// 回看模式的视窗请求器（U-3）：150 ms 去抖、同键忽略、换键中止在飞请求、代数校验丢陈旧结果；
// 谱与包络并发同一 AbortController；409 按 Retry-After 重试（上限 10 次）、413 用 suggest 重试一次、
// 400 停并记日志、404「该观测点无此产品」、网络异常 2 s 重试至多 3 次；包络 404 不算失败（只画谱）。
// 依赖全部注入，单测用假定时器与假客户端（仿 api/ws.test.ts）。

import type { WindowResult } from '../api/client.js'
import type { WindowMeta } from '../api/window.js'
import type { SpectrumRequest, Stat } from './viewport.js'

export interface FetchKey {
  task: string
  op: string
  t0: number
  t1: number
  f0: number
  f1: number
  px: number
  py: number
  stat: Stat
  /** 包络请求的时间像素数；0 = 不取包络 */
  envPx: number
}

export function sameKey(a: FetchKey | null, b: FetchKey): boolean {
  if (!a) return false
  return a.task === b.task && a.op === b.op && a.t0 === b.t0 && a.t1 === b.t1 && a.f0 === b.f0 && a.f1 === b.f1
    && a.px === b.px && a.py === b.py && a.stat === b.stat && a.envPx === b.envPx
}

export type FetchStatus = 'idle' | 'pending' | 'inflight' | 'waiting' | 'error'
export interface WindowData { data: Float32Array; meta: WindowMeta }

export interface FetcherDeps {
  spectrum: (task: string, op: string, q: SpectrumRequest, signal: AbortSignal) => Promise<WindowResult>
  envelope: (task: string, op: string, q: { t0: number; t1: number; px: number }, signal: AbortSignal) => Promise<WindowResult>
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
  onResult: (key: FetchKey, spec: WindowData, env: WindowData | null) => void
  onStatus: (s: FetchStatus, detail?: string) => void
  onLog?: (level: 'warn' | 'error', message: string) => void
}

const MAX_409 = 10
const MAX_NET = 3
const NET_RETRY_MS = 2000

export class WindowFetcher {
  private key: FetchKey | null = null
  private timer: unknown = null
  private ac: AbortController | null = null
  private gen = 0
  private waits409 = 0
  private netRetries = 0
  private retried413 = false
  status: FetchStatus = 'idle'

  constructor(private readonly deps: FetcherDeps) {}

  /** 当前键（含 413 后被 suggest 改写的 px / py）。 */
  get current(): FetchKey | null { return this.key }

  request(key: FetchKey, debounceMs = 150): void {
    if (sameKey(this.key, key) && this.status !== 'error') return
    this.key = key
    this.gen += 1
    this.waits409 = 0
    this.netRetries = 0
    this.retried413 = false
    this.abortInflight()
    this.setStatus('pending')
    this.schedule(debounceMs)
  }

  cancel(): void {
    this.key = null
    this.gen += 1
    this.abortInflight()
    this.setStatus('idle')
  }

  private schedule(ms: number): void {
    const gen = this.gen
    if (this.timer !== null) this.deps.clearTimeout(this.timer)
    this.timer = this.deps.setTimeout(() => { this.timer = null; void this.run(gen) }, ms)
  }

  private abortInflight(): void {
    if (this.timer !== null) { this.deps.clearTimeout(this.timer); this.timer = null }
    if (this.ac) { this.ac.abort(); this.ac = null }
  }

  private setStatus(s: FetchStatus, detail?: string): void {
    this.status = s
    this.deps.onStatus(s, detail)
  }

  private async run(gen: number): Promise<void> {
    if (gen !== this.gen || !this.key) return
    const key = this.key
    const ac = new AbortController()
    this.ac = ac
    this.setStatus('inflight')
    const q: SpectrumRequest = { t0: key.t0, t1: key.t1, f0: key.f0, f1: key.f1, px: key.px, py: key.py, stat: key.stat }
    let spec: WindowResult
    let env: WindowResult | null = null
    try {
      const [s, e] = await Promise.all([
        this.deps.spectrum(key.task, key.op, q, ac.signal),
        key.envPx > 0 ? this.deps.envelope(key.task, key.op, { t0: key.t0, t1: key.t1, px: key.envPx }, ac.signal) : Promise.resolve(null),
      ])
      spec = s
      env = e
    } catch (e) {
      if (gen !== this.gen) return
      this.netRetries += 1
      if (this.netRetries <= MAX_NET) { this.setStatus('waiting', `网络异常，${NET_RETRY_MS / 1000} s 后重试`); this.schedule(NET_RETRY_MS); return }
      this.setStatus('error', `网络异常：${(e as Error).message}`)
      return
    }
    if (gen !== this.gen) return
    this.ac = null

    // 未就绪：谱或包络任一 409 都等一等再整体重取
    const waitMs = 'retryAfterMs' in spec ? spec.retryAfterMs : env && 'retryAfterMs' in env ? env.retryAfterMs : null
    if (waitMs !== null) {
      this.waits409 += 1
      if (this.waits409 <= MAX_409) { this.setStatus('waiting', '数据尚未就绪'); this.schedule(waitMs); return }
      this.setStatus('error', '数据尚未就绪，已停止等待')
      return
    }
    if ('suggest' in spec) {
      if (!this.retried413 && spec.suggest) {
        this.retried413 = true
        this.key = { ...key, px: spec.suggest.px, py: spec.suggest.py }
        this.schedule(0)
        return
      }
      this.setStatus('error', '视窗超过单次响应上限')
      return
    }
    if (spec.status === 400) {
      this.deps.onLog?.('warn', `视窗参数被拒绝：${spec.message}`)
      this.setStatus('error', spec.message)
      return
    }
    if (spec.status === 404) { this.setStatus('error', '该观测点无此产品'); return }
    if (!('data' in spec)) { this.setStatus('error', `HTTP ${spec.status}`); return }

    let envData: WindowData | null = null
    if (env && 'data' in env) envData = { data: env.data, meta: env.meta }
    else if (env && env.status !== 404) this.deps.onLog?.('warn', `包络抽取失败：HTTP ${env.status}`)
    this.deps.onResult(this.key ?? key, { data: spec.data, meta: spec.meta }, envData)
    this.setStatus('idle')
  }
}
