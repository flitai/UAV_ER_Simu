// WebSocket 帧与产品行读取（06 备忘录 §9A B-6；docs/api-versions.md §4；决策 D-044）。
//
// 二进制帧布局（只承载 spectrum / envelope 行）：
//   [u32 LE header_len][UTF-8 JSON 帧头，用空格补齐到 4 字节倍数][Float32 LE × row_len]
// 帧头 = {seq, task_id, op_id, kind, row_index, row_len, t_s}；载荷就是 <op_id>/<kind>.f32 里该行的原字节
// （引擎按小端 float32 写，D-041），服务端不做任何转换。header_len 是补齐后的长度，因此 4 + header_len
// 是 4 的倍数，客户端可以零拷贝 new Float32Array(buf, 4 + header_len, row_len)。
//
// 连接级报文（subscribed / heartbeat / dropped / error）沿用任务事件的信封但 seq = 0：它们不属于任务的序号流，
// 客户端不得据此推进 lastSeq（唯 dropped 令 lastSeq = to）。
//
// RowReader 按事件里的偏移读产品文件：row_index × row_len × 4。引擎每写一行就 fflush 再发事件，所以按事件读
// 是安全的；短读或文件不存在返回 null，会话退回发原文本事件（序号保持，客户端稍后走 B-7 端点取）。

import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineEvent } from '../tasks/engine.js'

export interface RowHeader {
  seq: number
  task_id: string
  op_id: string
  kind: string
  row_index: number
  row_len: number
  /** 该行的逻辑时间（秒），取自 product_row 事件的 t_s */
  t_s: number
}

/** 组二进制帧。row 必须恰是 row_len × 4 字节（由 RowReader 保证）。 */
export function encodeRowFrame(h: RowHeader, row: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(h), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const headerLen = json.length + pad
  const out = Buffer.alloc(4 + headerLen + row.length)
  out.writeUInt32LE(headerLen, 0)
  json.copy(out, 4)
  for (let i = 0; i < pad; i++) out[4 + json.length + i] = 0x20
  row.copy(out, 4 + headerLen)
  return out
}

/** 解二进制帧（测试与将来的客户端对照实现）。载荷按平台字节序解释为 float32，目标平台全部小端。 */
export function decodeRowFrame(frame: ArrayBuffer | Uint8Array): { header: RowHeader; data: Float32Array } {
  const u8 = frame instanceof Uint8Array ? frame : new Uint8Array(frame)
  if (u8.byteLength < 4) throw new Error('帧不足 4 字节')
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const headerLen = dv.getUint32(0, true)
  if (headerLen % 4 !== 0 || 4 + headerLen > u8.byteLength) throw new Error(`帧头长度不合法：${headerLen}`)
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + headerLen))) as RowHeader
  const n = Math.floor((u8.byteLength - 4 - headerLen) / 4)
  const off = u8.byteOffset + 4 + headerLen
  const data = off % 4 === 0
    ? new Float32Array(u8.buffer, off, n)
    : new Float32Array(u8.slice(4 + headerLen, 4 + headerLen + n * 4).buffer)
  return { header, data }
}

export type ConnEventType = 'subscribed' | 'heartbeat' | 'dropped' | 'error'

/** 连接级报文：同一信封，seq = 0，t_s = 0。 */
export function connEvent(type: ConnEventType, task_id: string, payload: Record<string, unknown>): EngineEvent {
  return { seq: 0, task_id, type, t_s: 0, payload }
}

export const KINDS: ReadonlySet<string> = new Set(['spectrum', 'envelope'])
export const OP_ID_RE = /^[A-Za-z0-9_-]+$/
/** 单行浮点数上限（4 MB）：防止事件里的 row_len 被篡改后分配巨块内存 */
export const MAX_ROW_LEN = 1 << 20

/**
 * 每个会话一份：按 (op_id, kind) 缓存文件句柄，按偏移读一行。op_id 与 kind 先过白名单再拼路径，
 * 事件来自引擎但路径拼接不信任任何外来字符串。
 */
export class RowReader {
  private readonly handles = new Map<string, Promise<FileHandle | null>>()
  private readonly warned = new Set<string>()

  constructor(
    private readonly taskDir: string,
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
  ) {}

  async read(op_id: string, kind: string, row_index: number, row_len: number): Promise<Buffer | null> {
    if (!OP_ID_RE.test(op_id) || !KINDS.has(kind)) return this.miss(op_id, kind, '非法的 op_id 或 kind')
    if (!Number.isInteger(row_index) || row_index < 0 || !Number.isInteger(row_len) || row_len <= 0 || row_len > MAX_ROW_LEN) {
      return this.miss(op_id, kind, `非法的 row_index / row_len：${row_index} / ${row_len}`)
    }
    const key = `${op_id}/${kind}`
    let hp = this.handles.get(key)
    if (!hp) {
      hp = fsp.open(join(this.taskDir, op_id, `${kind}.f32`), 'r').catch(() => null)
      this.handles.set(key, hp)
    }
    const fh = await hp
    if (!fh) {
      this.handles.delete(key) // 文件可能稍后才出现，下次再试
      return this.miss(op_id, kind, '产品文件打不开')
    }
    const len = row_len * 4
    const buf = Buffer.alloc(len)
    try {
      const r = await fh.read(buf, 0, len, row_index * len)
      if (r.bytesRead !== len) return this.miss(op_id, kind, `第 ${row_index} 行短读：${r.bytesRead} / ${len} 字节`)
      return buf
    } catch (e) {
      return this.miss(op_id, kind, `读第 ${row_index} 行失败：${String(e instanceof Error ? e.message : e)}`)
    }
  }

  private miss(op_id: string, kind: string, why: string): null {
    const key = `${op_id}/${kind}`
    if (!this.warned.has(key)) {
      this.warned.add(key)
      this.warn(`产品行读不到，退回文本事件（${key}）：${why}`)
    }
    return null
  }

  async close(): Promise<void> {
    const hs = [...this.handles.values()]
    this.handles.clear()
    for (const hp of hs) {
      const fh = await hp
      if (fh) await fh.close().catch(() => undefined)
    }
  }
}
