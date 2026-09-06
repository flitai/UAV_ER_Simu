// WebSocket 客户端（09 附录 A.2 末段；docs/api-versions.md §4.0）：单连接、退避 1/2/4/8 s、
// 心跳看门狗、seq 递增校验、缺号先补取再续、二进制行帧零拷贝解码。
// 依赖全部可注入（WebSocket 实现、定时器、补取函数），单测不需要浏览器。

import { decodeRowFrame, isEnvelope, type RowHeader } from './frames.js'
import { SeqTracker } from './seq.js'
import type { LogLevel, WsState, WsTextEvent } from '../state/types.js'

export interface WsLike {
  binaryType: string
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface WsClientOptions {
  url: string
  fetchEvents: (taskId: string, since: number) => Promise<{ events: WsTextEvent[]; last_seq: number }>
  onEvent: (ev: WsTextEvent) => void
  onRow: (header: RowHeader, data: Float32Array) => void
  onStatus: (s: WsState) => void
  onClientLog: (level: LogLevel, message: string) => void
  WebSocketImpl?: new (url: string) => WsLike
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (h: unknown) => void
}

const BACKOFF_MS = [1000, 2000, 4000, 8000]
const WATCHDOG_MS = 35000          // 两个 15 s 心跳加余量
const CLOSE_MANUAL = 4000
const CLOSE_WATCHDOG = 4998
const CLOSE_DROP_TEST = 4999
const NO_RETRY = new Set([4400, 4404, 4409])

export class WsClient {
  private ws: WsLike | null = null
  private taskId: string | null = null
  private tracker = new SeqTracker(0)
  private manual = false
  private retryTimer: unknown = null
  private watchdog: unknown = null
  private catchingUp = false
  private held: Array<{ kind: 'text'; ev: WsTextEvent } | { kind: 'row'; header: RowHeader; data: Float32Array }> = []
  private readonly o: WsClientOptions
  readonly state: WsState = { status: 'closed', lastSeq: 0, reconnects: 0, dropped: 0, attempt: 0, nextRetryMs: 0 }

  constructor(o: WsClientOptions) { this.o = o }

  private st(): (fn: () => void, ms: number) => unknown { return this.o.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)) }
  private ct(): (h: unknown) => void { return this.o.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number)) }

  /** 订阅任务。同一任务重复调用是空操作（StrictMode 双 effect 安全）。 */
  subscribe(taskId: string, since: number): void {
    if (this.taskId === taskId && this.ws) return
    this.close()
    this.taskId = taskId
    this.tracker = new SeqTracker(since)
    this.state.lastSeq = since
    this.state.dropped = 0
    this.state.attempt = 0
    this.state.reconnects = 0
    this.held = []
    this.catchingUp = false
    this.connect()
  }

  close(): void {
    this.manual = true
    this.stopTimers()
    if (this.ws) { try { this.ws.close(CLOSE_MANUAL, 'client close') } catch { /* 忽略 */ } this.ws = null }
    this.taskId = null
    this.setStatus('closed')
  }

  /** 只在开发者模式挂到 window.__cuav：模拟断线，走真实的重连与 since 补取路径。 */
  dropForTest(): boolean {
    if (!this.ws) return false
    try { this.ws.close(CLOSE_DROP_TEST, 'drop for test') } catch { return false }
    return true
  }

  private connect(): void {
    if (!this.taskId) return
    this.manual = false
    const Impl = this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike)
    const ws = new Impl(this.o.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      ws.send(JSON.stringify({ subscribe: this.taskId, since: this.tracker.lastSeq }))
      this.state.attempt = 0
      this.state.nextRetryMs = 0
      this.setStatus('connected')
      this.kickWatchdog()
    }
    ws.onmessage = (ev) => { if (this.ws === ws) this.onMessage(ev.data) }
    ws.onerror = () => { /* onclose 随后到 */ }
    ws.onclose = (ev) => { if (this.ws === ws) this.onClose(ev.code) }
  }

  private onMessage(data: unknown): void {
    this.kickWatchdog()
    if (typeof data === 'string') {
      let ev: unknown
      try { ev = JSON.parse(data) } catch { return }
      if (!isEnvelope(ev)) return
      this.handleText(ev)
      return
    }
    if (data instanceof ArrayBuffer) {
      let frame
      try { frame = decodeRowFrame(data) } catch (e) { this.o.onClientLog('warn', `二进制帧解析失败：${(e as Error).message}`); return }
      this.handleRow(frame.header, frame.data)
    }
  }

  private handleText(ev: WsTextEvent): void {
    const v = this.tracker.classify(ev.seq, ev.type, ev.payload)
    if (v === 'conn') {
      if (ev.type === 'dropped') { this.state.dropped = this.tracker.dropped; this.state.lastSeq = this.tracker.lastSeq; this.emitStatus() }
      else if (ev.type === 'error') this.o.onClientLog('error', `连接报错：${String(ev.payload['code'] ?? '')} ${String(ev.payload['message'] ?? '')}`)
      else if (ev.type === 'subscribed') this.o.onEvent(ev)
      return
    }
    if (v === 'dup') return
    if (v === 'gap') { void this.catchUp({ kind: 'text', ev }); return }
    if (this.catchingUp) { this.held.push({ kind: 'text', ev }); return }
    this.state.lastSeq = this.tracker.lastSeq
    this.o.onEvent(ev)
  }

  private handleRow(header: RowHeader, data: Float32Array): void {
    const v = this.tracker.classify(header.seq, 'product_row', undefined)
    if (v === 'dup' || v === 'conn') return
    if (v === 'gap') { void this.catchUp({ kind: 'row', header, data }); return }
    if (this.catchingUp) { this.held.push({ kind: 'row', header, data }); return }
    this.state.lastSeq = this.tracker.lastSeq
    this.o.onRow(header, data)
  }

  /** 缺号：扣住到达的帧，用 REST 把洞补上，再按序回放扣住的帧。 */
  private async catchUp(first: { kind: 'text'; ev: WsTextEvent } | { kind: 'row'; header: RowHeader; data: Float32Array }): Promise<void> {
    if (this.catchingUp) { this.held.push(first); return }
    this.catchingUp = true
    this.held.push(first)
    const taskId = this.taskId
    const target = first.kind === 'text' ? first.ev.seq : first.header.seq
    if (!taskId) { this.catchingUp = false; return }
    try {
      while (this.tracker.lastSeq < target - 1) {
        const page = await this.o.fetchEvents(taskId, this.tracker.lastSeq)
        if (this.taskId !== taskId) return
        if (page.events.length === 0) break
        for (const ev of page.events) {
          if (ev.seq <= this.tracker.lastSeq) continue
          if (ev.seq !== this.tracker.lastSeq + 1) {
            const hole = this.tracker.advanceTo(ev.seq)
            if (hole) this.o.onClientLog('warn', `缺号：seq ${hole.from}→${hole.to} 补取不到`)
          } else {
            this.tracker.lastSeq = ev.seq
          }
          this.state.lastSeq = this.tracker.lastSeq
          this.o.onEvent(ev)          // 补取来的 product_row 是文本、无数据，reducer 忽略它
        }
      }
    } catch (e) {
      this.o.onClientLog('warn', `补取失败，改为重连：${(e as Error).message}`)
      this.catchingUp = false
      this.held = []
      if (this.ws) { try { this.ws.close(CLOSE_WATCHDOG, 'catch-up failed') } catch { /* 忽略 */ } }
      return
    }
    // 回放扣住的帧：其中重复的会被 classify 判 dup 丢掉
    const held = this.held
    this.held = []
    this.catchingUp = false
    for (const h of held) {
      if (h.kind === 'text') this.handleText(h.ev)
      else this.handleRow(h.header, h.data)
    }
  }

  private onClose(code: number): void {
    this.stopTimers()
    this.ws = null
    if (this.manual) { this.setStatus('closed'); return }
    if (NO_RETRY.has(code)) {
      this.o.onClientLog('error', `服务拒绝订阅（关闭码 ${code}），不再重连`)
      this.taskId = null
      this.setStatus('closed')
      return
    }
    this.state.reconnects += 1
    this.state.attempt += 1
    const delay = BACKOFF_MS[Math.min(this.state.attempt - 1, BACKOFF_MS.length - 1)]!
    this.state.nextRetryMs = delay
    this.setStatus('reconnecting')
    this.retryTimer = this.st()(() => { this.retryTimer = null; this.connect() }, delay)
  }

  private kickWatchdog(): void {
    if (this.watchdog) this.ct()(this.watchdog)
    this.watchdog = this.st()(() => {
      this.watchdog = null
      if (this.ws) { try { this.ws.close(CLOSE_WATCHDOG, 'heartbeat timeout') } catch { /* 忽略 */ } }
    }, WATCHDOG_MS)
  }

  private stopTimers(): void {
    if (this.retryTimer) { this.ct()(this.retryTimer); this.retryTimer = null }
    if (this.watchdog) { this.ct()(this.watchdog); this.watchdog = null }
  }

  private setStatus(status: WsState['status']): void {
    this.state.status = status
    this.state.lastSeq = this.tracker.lastSeq
    this.emitStatus()
  }

  private emitStatus(): void { this.o.onStatus({ ...this.state }) }
}

export function wsUrl(loc: { protocol: string; host: string } = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`
}
