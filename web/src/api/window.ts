// 视窗抽取响应的纯解析（docs/api-versions.md §3.1b；docs/display-products.md §3；D-046）。
// 响应头 X-CUAV-* 全是相对量：时间相对索引 t0_s，频率相对 center_Hz；绝对轴由调用方用索引换算。

import type { SpectrumRequest, Stat } from '../signal/viewport.js'

export interface WindowMeta {
  rows: number
  cols: number
  /** 实际覆盖的时间范围（秒，相对 t0_s） */
  t0: number
  t1: number
  /** 实际覆盖的频率范围（Hz，相对 center_Hz）；包络为 null */
  f0: number | null
  f1: number | null
  stat: Stat | null
  /** 索引里的结果四态 */
  state: string
}

const STATS = new Set(['max', 'mean', 'min'])

function num(get: (name: string) => string | null, name: string): number {
  const v = get(name)
  const n = v === null ? Number.NaN : Number(v)
  if (!Number.isFinite(n)) throw new Error(`响应头缺 ${name.toUpperCase()}`)
  return n
}

function optNum(get: (name: string) => string | null, name: string): number | null {
  const v = get(name)
  if (v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 解析 X-CUAV-* 响应头；缺 rows / cols / t0 / t1 / state 抛错。 */
export function parseWindowHeaders(get: (name: string) => string | null): WindowMeta {
  const rows = num(get, 'x-cuav-rows')
  const cols = num(get, 'x-cuav-cols')
  const t0 = num(get, 'x-cuav-t0')
  const t1 = num(get, 'x-cuav-t1')
  const state = get('x-cuav-state')
  if (!state) throw new Error('响应头缺 X-CUAV-STATE')
  const s = get('x-cuav-stat')
  return {
    rows: Math.floor(rows),
    cols: Math.floor(cols),
    t0,
    t1,
    f0: optNum(get, 'x-cuav-f0'),
    f1: optNum(get, 'x-cuav-f1'),
    stat: s && STATS.has(s) ? (s as Stat) : null,
    state,
  }
}

/** 响应体长度必须恰为 rows × cols × 4。 */
export function checkWindowBody(byteLength: number, meta: WindowMeta): void {
  const want = meta.rows * meta.cols * 4
  if (byteLength !== want) throw new Error(`short_body：期望 ${want} 字节，收到 ${byteLength}`)
}

/** Retry-After（秒）→ 毫秒；缺失或不合法按 1 s。 */
export function parseRetryAfterMs(v: string | null): number {
  const n = Number(v ?? '1')
  return (Number.isFinite(n) && n > 0 ? n : 1) * 1000
}

/** 413 响应体里的 suggest{px, py}。 */
export function parseSuggest(body: unknown): { px: number; py: number } | null {
  if (!body || typeof body !== 'object') return null
  const s = (body as { suggest?: unknown }).suggest
  if (!s || typeof s !== 'object') return null
  const px = (s as { px?: unknown }).px
  const py = (s as { py?: unknown }).py
  if (typeof px !== 'number' || typeof py !== 'number' || !(px >= 1) || !(py >= 1)) return null
  return { px: Math.floor(px), py: Math.floor(py) }
}

/** px / py 必须是 1 到 9 位的正整数（服务端 INT_RE）。 */
function intParam(v: number): string {
  const n = Math.max(1, Math.min(999999999, Math.floor(v)))
  return String(n)
}

export function spectrumQueryString(q: SpectrumRequest): string {
  const p = new URLSearchParams()
  p.set('t0', String(q.t0))
  p.set('t1', String(q.t1))
  p.set('f0', String(q.f0))
  p.set('f1', String(q.f1))
  p.set('px', intParam(q.px))
  p.set('py', intParam(q.py))
  p.set('stat', q.stat)
  return p.toString()
}

export function envelopeQueryString(q: { t0: number; t1: number; px: number }): string {
  const p = new URLSearchParams()
  p.set('t0', String(q.t0))
  p.set('t1', String(q.t1))
  p.set('px', intParam(q.px))
  return p.toString()
}
