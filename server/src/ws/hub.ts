// WebSocket 服务端（06 备忘录 §9A B-6；docs/api-versions.md §4；决策 D-044）。
//
// 路径 /ws。客户端先发 {subscribe: task_id, since}，服务端应答 subscribed，然后回放序号 > since 的事件
// （缓冲内切片、缓冲外读 events.jsonl，都走 TaskManager.readEvents），追平后转实时。一个连接一个订阅。
//
// 顺序保证：订阅先于第一次 readEvents 注册，回放期间的实时事件只入队；回放以空批次收口后才置 live 并抽队列，
// 队列里 seq ≤ cursor 的即重复、跳过。deliver 逐条 await（读产品行是异步的），pump 用标志串行化。
//
// 背压：只丢二进制行帧。bufferedAmount 超高水位时不读文件、把序号并进 pending，在发送下一帧（任何类型）之前
// 先发 dropped{from, to, count}，所以 dropped 的区间总是连续且有序；文本事件永不丢。send 一律不 await——
// await 会让 bufferedAmount 失去意义，积压只是转移到本进程的队列里。超硬上限则以 4013 断开，客户端重连补取。
//
// 心跳：单个定时器（首个连接才建、无连接即清、unref），每轮发 heartbeat 文本帧并 ping；上一轮没收到 pong 的
// 连接 terminate。浏览器看不到 ping/pong，所以文本 heartbeat 是给它判断连接活着的依据。

import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { EngineEvent } from '../tasks/engine.js'
import type { TaskManager } from '../tasks/manager.js'
import { taskDirAbs } from '../tasks/store.js'
import { RowReader, connEvent, encodeRowFrame } from './events.js'

export const CLOSE_GOING_AWAY = 1001
export const CLOSE_INTERNAL = 1011
export const CLOSE_OVERLOADED = 4013
export const CLOSE_BAD_SUBSCRIBE = 4400
export const CLOSE_NOT_FOUND = 4404
export const CLOSE_ALREADY_SUBSCRIBED = 4409

export interface HubOptions {
  mgr: TaskManager
  /** upgrade 路径，缺省 /ws */
  path?: string
  /** 心跳间隔，缺省 15000 ms（docs/api-versions.md §4） */
  heartbeatMs?: number
  /** 丢弃二进制行帧的高水位，缺省 1 MiB */
  highWaterBytes?: number
  /** 断开连接的硬上限，缺省 16 MiB */
  hardCapBytes?: number
  /** 背压判据，缺省 bufferedAmount > highWaterBytes；测试注入用 */
  overloaded?: (ws: WebSocket) => boolean
  /** 回放每批条数，缺省 1000 */
  replayBatch?: number
  log?: (msg: string) => void
}

export class WsHub {
  readonly mgr: TaskManager
  readonly path: string
  readonly heartbeatMs: number
  readonly hardCapBytes: number
  readonly replayBatch: number
  readonly overloaded: (ws: WebSocket) => boolean
  readonly log: (msg: string) => void
  private readonly wss: WebSocketServer
  private readonly sessions = new Set<Session>()
  private timer: NodeJS.Timeout | undefined
  private attached = false

  constructor(o: HubOptions) {
    this.mgr = o.mgr
    this.path = o.path ?? '/ws'
    this.heartbeatMs = Math.max(20, o.heartbeatMs ?? 15000)
    const high = o.highWaterBytes ?? 1 << 20
    this.hardCapBytes = o.hardCapBytes ?? 16 << 20
    this.overloaded = o.overloaded ?? ((ws) => ws.bufferedAmount > high)
    this.replayBatch = Math.max(1, o.replayBatch ?? 1000)
    this.log = o.log ?? ((m) => console.warn(m))
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  }

  /** 挂到 http.Server 的 upgrade 事件。不产生任何句柄，import 时调用也无副作用。 */
  attach(server: HttpServer): void {
    if (this.attached) return
    this.attached = true
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
  }

  get size(): number {
    return this.sessions.size
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== this.path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.newSession(ws))
  }

  private newSession(ws: WebSocket): void {
    const s = new Session(this, ws)
    this.sessions.add(s)
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.heartbeatMs)
      this.timer.unref()
    }
    ws.once('close', () => {
      this.sessions.delete(s)
      if (!this.sessions.size && this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    })
  }

  private tick(): void {
    for (const s of this.sessions) s.heartbeat()
  }

  /** 关掉全部连接（1001）并等它们真正关闭；测试与服务停止用。 */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await Promise.all([...this.sessions].map((s) => s.shutdown(CLOSE_GOING_AWAY, '服务停止')))
    await new Promise<void>((r) => this.wss.close(() => r()))
  }
}

interface DropRun {
  from: number
  to: number
  count: number
}

class Session {
  private taskId = ''
  private cursor = 0
  private readonly queue: EngineEvent[] = []
  private live = false
  private pumping = false
  private pending: DropRun | null = null
  private unsub: (() => void) | null = null
  private rows: RowReader | null = null
  private alive = true
  private closed = false

  constructor(
    private readonly hub: WsHub,
    private readonly ws: WebSocket,
  ) {
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary))
    ws.on('pong', () => {
      this.alive = true
    })
    ws.on('close', () => this.teardown())
    ws.on('error', () => this.teardown())
  }

  // -------------------------------------------------------------------------
  // 订阅

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) return this.fail(CLOSE_BAD_SUBSCRIBE, 'bad_subscribe', '订阅报文必须是文本 JSON')
    let j: unknown
    try {
      j = JSON.parse(rawToString(data))
    } catch {
      return this.fail(CLOSE_BAD_SUBSCRIBE, 'bad_subscribe', '订阅报文不是合法 JSON')
    }
    const o = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
    const since = o?.since === undefined ? 0 : o.since
    if (!o || typeof o.subscribe !== 'string' || !(typeof since === 'number' && Number.isInteger(since) && since >= 0)) {
      return this.fail(CLOSE_BAD_SUBSCRIBE, 'bad_subscribe', '订阅报文应为 {subscribe: task_id, since: 不小于 0 的整数}')
    }
    if (this.taskId) return this.fail(CLOSE_ALREADY_SUBSCRIBED, 'already_subscribed', `本连接已订阅 ${this.taskId}，换任务请另开连接`)
    const id = o.subscribe
    const rec = this.hub.mgr.get(id)
    if (!rec) return this.fail(CLOSE_NOT_FOUND, 'not_found', `任务不存在：${id}`, id)

    this.taskId = id
    this.cursor = since
    this.rows = new RowReader(taskDirAbs(this.hub.mgr.storeConfig, id), this.hub.log)
    // 先订阅再读历史：回放期间到达的实时事件进队列，回放收口后按 seq > cursor 抽出，既不丢也不重
    this.unsub = this.hub.mgr.subscribe(id, (ev) => {
      this.queue.push(ev)
      if (this.live) void this.pump()
    })
    this.sendText(connEvent('subscribed', id, { since, last_seq: rec.last_seq, run_state: rec.run_state }))
    void this.replay()
  }

  private async replay(): Promise<void> {
    try {
      for (;;) {
        if (this.closed) return
        const batch = await this.hub.mgr.readEvents(this.taskId, this.cursor, this.hub.replayBatch)
        if (!batch || !batch.length) break // 空批次 = 追平；「不足一批」不算，文件可能只是暂时读不到缓冲那一段
        for (const ev of batch) {
          if (this.closed) return
          await this.deliver(ev)
        }
      }
      this.live = true
      await this.pump()
    } catch (e) {
      this.hub.log(`WS 回放失败 ${this.taskId}：${String(e instanceof Error ? e.message : e)}`)
      this.fail(CLOSE_INTERNAL, 'internal', '服务端回放事件失败')
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length && !this.closed) {
        const ev = this.queue.shift()!
        if (ev.seq <= this.cursor) continue
        await this.deliver(ev)
      }
    } catch (e) {
      this.hub.log(`WS 推送失败 ${this.taskId}：${String(e instanceof Error ? e.message : e)}`)
      this.fail(CLOSE_INTERNAL, 'internal', '服务端推送事件失败')
    } finally {
      this.pumping = false
    }
  }

  // -------------------------------------------------------------------------
  // 发送

  private async deliver(ev: EngineEvent): Promise<void> {
    if (this.closed) return
    if (this.ws.bufferedAmount > this.hub.hardCapBytes) {
      return this.fail(CLOSE_OVERLOADED, 'overloaded', `客户端跟不上：待发 ${this.ws.bufferedAmount} 字节超过上限，请重连并按 since 补取`)
    }
    if (ev.type === 'product_row') {
      if (this.hub.overloaded(this.ws)) {
        if (this.pending) {
          this.pending.to = ev.seq
          this.pending.count++
        } else {
          this.pending = { from: ev.seq, to: ev.seq, count: 1 }
        }
        this.cursor = ev.seq
        return
      }
      const p = ev.payload
      const opId = String(p.op_id ?? '')
      const kind = String(p.kind ?? '')
      const rowIndex = Number(p.row_index)
      const rowLen = Number(p.row_len)
      const row = await this.rows!.read(opId, kind, rowIndex, rowLen)
      if (this.closed) return
      this.flushDropped()
      if (row) {
        this.sendBinary(encodeRowFrame({ seq: ev.seq, task_id: ev.task_id, op_id: opId, kind, row_index: rowIndex, row_len: rowLen, t_s: ev.t_s }, row))
      } else {
        this.sendText(ev) // 行读不到：退回原文本事件，序号不断
      }
    } else {
      this.flushDropped()
      this.sendText(ev)
    }
    this.cursor = ev.seq
  }

  private flushDropped(): void {
    if (!this.pending) return
    const d = this.pending
    this.pending = null
    this.sendText(connEvent('dropped', this.taskId, { from: d.from, to: d.to, count: d.count }))
  }

  private sendText(ev: EngineEvent): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(ev))
  }

  private sendBinary(frame: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(frame, { binary: true })
  }

  // -------------------------------------------------------------------------
  // 心跳、错误与收尾

  heartbeat(): void {
    if (this.closed) return
    if (!this.alive) {
      this.ws.terminate()
      return
    }
    this.alive = false
    const rec = this.taskId ? this.hub.mgr.get(this.taskId) : null
    this.sendText(connEvent('heartbeat', this.taskId, { last_seq: rec?.last_seq ?? 0 }))
    if (this.ws.readyState === WebSocket.OPEN) this.ws.ping()
  }

  private fail(code: number, errCode: string, message: string, taskId = this.taskId): void {
    if (this.closed) return
    this.sendText(connEvent('error', taskId, { code: errCode, node_id: '', port: '', message }))
    this.closed = true
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, message.slice(0, 120))
    this.release()
  }

  shutdown(code: number, reason: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve()
      const t = setTimeout(() => this.ws.terminate(), 1000)
      t.unref()
      this.ws.once('close', () => {
        clearTimeout(t)
        resolve()
      })
      this.closed = true
      this.release()
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason)
      else this.ws.terminate()
    })
  }

  private teardown(): void {
    this.closed = true
    this.release()
  }

  private release(): void {
    this.unsub?.()
    this.unsub = null
    const rows = this.rows
    this.rows = null
    if (rows) void rows.close()
    this.queue.length = 0
    this.pending = null
  }
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
