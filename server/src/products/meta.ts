// 产品索引与可读行数（06 备忘录 §9A B-7；docs/display-products.md §1.1、§2；决策 D-046）。
//
// **读端一律以文件长度定行数**：索引里的 rows 每 64 行才刷一次，任务被杀时还可能永远停在最后一次刷新，
// 两个真实的取消任务实测索引 1344 行对文件 1392 行。rows 在这里只用来判断索引是否已收尾
// （index_final），它决定包络末桶按满桶还是按 last_bucket_samples 计权。
//
// 就绪语义（D-046 第 5 条）：产品文件还没出现、或索引还没写出来，对运行中的任务都是**正常的早期状态**，
// 一律 409 not_ready 加 retry-after，让客户端重试；只有终态任务才 404。

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from '../tasks/manager.js'
import type { RunState } from '../tasks/store.js'
import { KINDS, MAX_ROW_LEN, OP_ID_RE } from '../ws/events.js'

export type ProductKind = 'spectrum' | 'envelope'

export interface ProductIndexBase {
  schema_version: string
  kind: ProductKind
  row_len: number
  rows: number
  sample_rate_Hz: number
  center_Hz: number
  t0_s: number
  state: string
  [k: string]: unknown
}

export interface SpectrumIndex extends ProductIndexBase {
  kind: 'spectrum'
  bin_width_Hz: number
  frame_hop_samples: number
  nfft: number
}

export interface EnvelopeIndex extends ProductIndexBase {
  kind: 'envelope'
  bucket_samples: number
  last_bucket_samples: number
}

export type ProductIndex = SpectrumIndex | EnvelopeIndex

export interface ProductMeta {
  index: ProductIndex
  /** 以文件长度为准的行数 */
  rows_available: number
  /** 索引是否已收尾（rows == rows_available） */
  index_final: boolean
  f32Path: string
}

export function isProductKind(s: string): s is ProductKind {
  return KINDS.has(s)
}

export function productPaths(taskDir: string, opId: string, kind: ProductKind): { dir: string; f32: string; index: string } {
  const dir = join(taskDir, opId)
  return { dir, f32: join(dir, `${kind}.f32`), index: join(dir, `${kind}.index.json`) }
}

export function rowsAvailable(bytes: number, rowLen: number): number {
  if (!(rowLen > 0)) return 0
  return Math.floor(bytes / (rowLen * 4))
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`字段 ${k} 不是有限数`)
  return v
}

/** 校验索引的必需字段。不合法一律 500：索引是引擎写的，坏了不是客户端能修正的。 */
export function parseIndex(raw: unknown, kind: ProductKind): ProductIndex {
  try {
    if (!raw || typeof raw !== 'object') throw new Error('索引不是对象')
    const o = raw as Record<string, unknown>
    if (typeof o.schema_version !== 'string' || !o.schema_version.startsWith('cuav-product/')) {
      throw new Error(`schema_version 不是 cuav-product/*：${String(o.schema_version)}`)
    }
    if (o.kind !== kind) throw new Error(`kind 应为 ${kind}，实为 ${String(o.kind)}`)
    if (o.byte_order !== undefined && o.byte_order !== 'little') throw new Error(`byte_order 只支持 little`)
    const row_len = num(o, 'row_len')
    if (!Number.isInteger(row_len) || row_len <= 0 || row_len > MAX_ROW_LEN) throw new Error(`row_len 不合法：${row_len}`)
    const rows = num(o, 'rows')
    if (!Number.isInteger(rows) || rows < 0) throw new Error(`rows 不合法：${rows}`)
    const fs = num(o, 'sample_rate_Hz')
    if (!(fs > 0)) throw new Error(`sample_rate_Hz 必须为正：${fs}`)
    num(o, 'center_Hz')
    num(o, 't0_s')
    if (typeof o.state !== 'string') throw new Error('state 不是字符串')
    if (kind === 'spectrum') {
      const nfft = num(o, 'nfft')
      if (!Number.isInteger(nfft) || nfft <= 0) throw new Error(`nfft 不合法：${nfft}`)
      if (nfft !== row_len) throw new Error(`row_len ${row_len} 与 nfft ${nfft} 不一致`)
      if (!(num(o, 'bin_width_Hz') > 0)) throw new Error('bin_width_Hz 必须为正')
      if (!(num(o, 'frame_hop_samples') > 0)) throw new Error('frame_hop_samples 必须为正')
    } else {
      if (row_len !== 3) throw new Error(`包络 row_len 应为 3，实为 ${row_len}`)
      if (!(num(o, 'bucket_samples') > 0)) throw new Error('bucket_samples 必须为正')
      const last = num(o, 'last_bucket_samples')
      if (last < 0) throw new Error('last_bucket_samples 不能为负')
    }
    return o as unknown as ProductIndex
  } catch (e) {
    throw new HttpError(500, { error: 'index_invalid', message: `${kind}.index.json 不合法：${e instanceof Error ? e.message : String(e)}` })
  }
}

const warned = new Set<string>()

function notReady(reason: string, extra: Record<string, unknown>): HttpError {
  return new HttpError(409, { error: 'not_ready', reason, ...extra })
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT'
}

/**
 * 读索引并按文件长度定行数。
 *   产品文件不存在：运行中 409 product_missing，终态 404；
 *   索引不存在：任何运行态都 409 index_missing（引擎写完第一行就会写一次索引，窗口只有毫秒级）；
 *   索引坏：500 index_invalid。
 */
export async function readProductMeta(taskDir: string, opId: string, kind: ProductKind, runState: RunState): Promise<ProductMeta> {
  if (!OP_ID_RE.test(opId) || !isProductKind(kind)) {
    throw new HttpError(404, { error: 'not_found', op_id: opId, kind })
  }
  const p = productPaths(taskDir, opId, kind)
  const pending = runState === 'queued' || runState === 'running'

  let size: number
  try {
    const st = await fsp.stat(p.f32)
    if (!st.isFile()) throw Object.assign(new Error('不是普通文件'), { code: 'ENOENT' })
    size = st.size
  } catch (e) {
    if (!isEnoent(e)) throw e
    if (pending) throw notReady('product_missing', { op_id: opId, kind, bytes: 0, rows_available: 0, run_state: runState })
    throw new HttpError(404, { error: 'not_found', op_id: opId, kind, message: '该观测点没有这种产品' })
  }

  let raw: unknown
  try {
    raw = JSON.parse(await fsp.readFile(p.index, 'utf8'))
  } catch (e) {
    if (isEnoent(e)) {
      // 行长未知时算不出行数：包络恒为 3 列可以给，谱要等索引才知道 nfft
      const rows = kind === 'envelope' ? rowsAvailable(size, 3) : null
      throw notReady('index_missing', { op_id: opId, kind, bytes: size, rows_available: rows, run_state: runState })
    }
    throw new HttpError(500, { error: 'index_invalid', message: `读 ${kind}.index.json 失败：${e instanceof Error ? e.message : String(e)}` })
  }

  const index = parseIndex(raw, kind)
  const avail = rowsAvailable(size, index.row_len)
  if (avail < index.rows && !warned.has(p.f32)) {
    warned.add(p.f32)
    console.warn(`产品文件比索引短，以文件长度为准（${p.f32}）：文件 ${avail} 行，索引记 ${index.rows} 行`)
  }
  return { index, rows_available: avail, index_final: index.rows === avail, f32Path: p.f32 }
}
