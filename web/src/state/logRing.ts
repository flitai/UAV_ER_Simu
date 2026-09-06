// 日志环形缓冲（09 §8：2000 行、级别过滤、搜索）。纯函数，供 reducer 与单测。

import type { LogLevel, LogLine, WsTextEvent } from './types.js'

export const LOG_CAP = 2000

export function levelOf(raw: unknown): LogLevel {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'error' || s === 'err' || s === 'fatal') return 'error'
  if (s === 'warn' || s === 'warning') return 'warn'
  return 'info'
}

/** 把引擎 log / error 事件变成一行；其它类型返回 null。 */
export function lineFromEvent(ev: WsTextEvent, id: number): LogLine | null {
  const p = ev.payload ?? {}
  if (ev.type === 'log') {
    return { id, seq: ev.seq, t_s: ev.t_s, level: levelOf(p['level']), message: String(p['message'] ?? ''), origin: 'engine' }
  }
  if (ev.type === 'error') {
    const line: LogLine = {
      id, seq: ev.seq, t_s: ev.t_s, level: 'error',
      message: `${String(p['code'] ?? 'error')}：${String(p['message'] ?? '')}`, origin: 'engine',
    }
    if (p['node_id']) line.node_id = String(p['node_id'])
    if (p['port']) line.port = String(p['port'])
    return line
  }
  return null
}

/** 追加并裁到上限；返回新数组（不改入参）。 */
export function pushLines(ring: readonly LogLine[], lines: readonly LogLine[]): LogLine[] {
  if (lines.length === 0) return ring as LogLine[]
  const out = ring.concat(lines)
  return out.length > LOG_CAP ? out.slice(out.length - LOG_CAP) : out
}

export function filterLog(ring: readonly LogLine[], filter: 'all' | 'warn' | 'error', query: string): LogLine[] {
  const q = query.trim().toLowerCase()
  return ring.filter((l) => {
    if (filter === 'error' && l.level !== 'error') return false
    if (filter === 'warn' && l.level === 'info') return false
    if (q && !l.message.toLowerCase().includes(q) && !(l.node_id ?? '').toLowerCase().includes(q)) return false
    return true
  })
}
