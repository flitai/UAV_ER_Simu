// WebSocket 帧解析：文本信封判别与二进制行帧零拷贝解码（docs/api-versions.md §4.0；D-044）。
// 与 server/src/ws/events.ts 的 decodeRowFrame 是同一套规则。

import type { WsTextEvent } from '../state/types.js'

export interface RowHeader {
  seq: number
  task_id: string
  op_id: string
  kind: string
  row_index: number
  row_len: number
  t_s: number
}

export function isEnvelope(x: unknown): x is WsTextEvent {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o['seq'] === 'number' && typeof o['task_id'] === 'string' && typeof o['type'] === 'string'
    && typeof o['t_s'] === 'number' && !!o['payload'] && typeof o['payload'] === 'object'
}

export function decodeRowFrame(buf: ArrayBuffer): { header: RowHeader; data: Float32Array } {
  if (buf.byteLength < 4) throw new Error('帧不足 4 字节')
  const dv = new DataView(buf)
  const headerLen = dv.getUint32(0, true)
  if (headerLen % 4 !== 0 || 4 + headerLen > buf.byteLength) throw new Error(`帧头长度不合法：${headerLen}`)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as RowHeader
  if (typeof header.seq !== 'number' || typeof header.row_len !== 'number') throw new Error('帧头缺 seq 或 row_len')
  const n = Math.floor((buf.byteLength - 4 - headerLen) / 4)
  // 4 + headerLen 是 4 的倍数，直接在原缓冲上建视图，不拷贝
  const data = new Float32Array(buf, 4 + headerLen, n)
  return { header, data }
}
