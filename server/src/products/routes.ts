// 视窗抽取端点（06 备忘录 §9A B-7；docs/display-products.md §3；docs/api-versions.md §3.1a；决策 D-046）。
//
//   GET /api/v1/results/{task}/{op}/spectrum?t0&t1&f0&f1&px&py&stat   二维 Float32，列 = 频率、行 = 时间
//   GET /api/v1/results/{task}/{op}/envelope?t0&t1&px                 三列 Float32（min, max, rms）
//   GET /api/v1/results/{task}/{op}/scatter                           本版本 404（观测点不产出 iq 产品，D-040 ③）
//   GET /api/v1/results/{task}/{op}/{kind}/index                      索引原文 + rows_available + index_final
//   GET /api/v1/results/{task}/{track|links|detections}?t0&t1&stride  JSON 数组
//
// 这里只做 HTTP：参数校验、状态码、响应头、HEAD、上限判定。归约在 spectrum.ts / envelope.ts，
// 那两个模块不认识 HTTP，才能与 Python 参考逐行对译（B-7 验收条件）。
//
// 铁律 7：浏览器只收按视窗抽取的展示数据，二进制走裸 Float32 流，不做 JSON / Base64 封装。
// 04 §8.6：响应里不出现任何服务器路径——这里只回数值与索引里的非路径字段。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { sendJson } from '../static.js'
import { HttpError, type TaskManager } from '../tasks/manager.js'
import { isTaskId, taskDirAbs, type RunState } from '../tasks/store.js'
import { OP_ID_RE } from '../ws/events.js'
import { MAX_BYTES } from './window.js'
import { isProductKind, readProductMeta, type EnvelopeIndex, type ProductKind, type SpectrumIndex } from './meta.js'
import { openFileRowSource } from './source.js'
import { STATS, extractSpectrum, planSpectrum, type Extract, type SpectrumGeom, type SpectrumQuery, type Stat } from './spectrum.js'
import { extractEnvelope, planEnvelope, type EnvelopeGeom, type EnvelopeQuery } from './envelope.js'
import { readJsonlWindow, type JsonlRecord } from './jsonl.js'

export interface ResultRouteDeps {
  mgr: TaskManager
  /** 单次响应上限，缺省 16 MiB；测试注入小值以逼出 413 */
  maxBytes?: number
}

const RE_PRODUCT = /^\/api\/v1\/results\/([^/]+)\/([^/]+)\/(spectrum|envelope|scatter)$/
const RE_INDEX = /^\/api\/v1\/results\/([^/]+)\/([^/]+)\/(spectrum|envelope)\/index$/
const RE_JSONL = /^\/api\/v1\/results\/([^/]+)\/(track|links|detections)$/

const NUM_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/
const INT_RE = /^\d{1,9}$/

/** JSONL 端点的文件名与抽稀键（G-2 / G-5 落地后这三个文件才有生产者）。 */
const JSONL_KINDS: Record<string, { file: string; key?: (r: JsonlRecord) => string }> = {
  track: { file: 'track.jsonl', key: (r) => String(r.id ?? '') },
  links: { file: 'links.jsonl', key: (r) => String(r.link_id ?? '') },
  detections: { file: 'detections.jsonl' },
}

/** 命中结果路由返回 true（含 405 与各种错误）；不是结果路由返回 false，交回主路由。 */
export async function handleResultRoutes(req: IncomingMessage, res: ServerResponse, url: URL, deps: ResultRouteDeps): Promise<boolean> {
  const path = url.pathname
  const method = req.method ?? 'GET'
  const head = method === 'HEAD'
  try {
    const mi = RE_INDEX.exec(path)
    if (mi) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res)
      const { rec, dir } = task(deps, mi[1])
      const kind = mi[3] as ProductKind
      const meta = await readProductMeta(dir, decodeURIComponent(mi[2]), kind, rec.run_state)
      sendJson(res, 200, {
        ...meta.index,
        rows_available: meta.rows_available,
        index_final: meta.index_final,
        run_state: rec.run_state,
      })
      return true
    }

    const mp = RE_PRODUCT.exec(path)
    if (mp) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res)
      const { rec, dir } = task(deps, mp[1])
      const opId = decodeURIComponent(mp[2])
      if (!OP_ID_RE.test(opId)) return notFoundOp(res, mp[1], opId)
      if (mp[3] === 'scatter') {
        sendJson(res, 404, {
          error: 'not_found',
          reason: 'product_unsupported',
          op_id: opId,
          message: '本版本观测点不产出 iq 产品（框图装载器拒绝 products 里的 iq，D-040），散点端点待 iq 产品落地后实现',
        })
        return true
      }
      const kind = mp[3] as ProductKind
      if (!isProductKind(kind)) return notFoundOp(res, mp[1], opId)
      // 先校验参数再看盘上有什么：坏参数是客户端的错，任何服务端状态都不该把它盖成 409，
      // 否则客户端会拿着一个永远不可能成功的查询按 Retry-After 一直重试。
      const spectrumQuery = kind === 'spectrum' ? parseSpectrumQuery(url.searchParams) : null
      const envelopeQuery = kind === 'envelope' ? parseEnvelopeQuery(url.searchParams) : null
      const meta = await readProductMeta(dir, opId, kind, rec.run_state)
      const idx = meta.index
      const fs = idx.sample_rate_Hz

      let out: Extract
      let stat: Stat | null = null
      if (spectrumQuery) {
        const si = idx as SpectrumIndex
        const q = spectrumQuery
        stat = q.stat
        const geom: SpectrumGeom = { dt: si.frame_hop_samples / fs, bw: si.bin_width_Hz, nfft: si.nfft, rowsAvail: meta.rows_available }
        out = await runExtract(meta.f32Path, si.row_len, meta.rows_available, deps, head, planSpectrum(geom, q), (src) =>
          extractSpectrum(src, geom, q),
        )
      } else {
        const ei = idx as EnvelopeIndex
        const q = envelopeQuery as EnvelopeQuery
        const geom: EnvelopeGeom = {
          dt: ei.bucket_samples / fs,
          rowsAvail: meta.rows_available,
          bucketSamples: ei.bucket_samples,
          lastBucketSamples: ei.last_bucket_samples,
          indexFinal: meta.index_final,
        }
        out = await runExtract(meta.f32Path, ei.row_len, meta.rows_available, deps, head, planEnvelope(geom, q), (src) =>
          extractEnvelope(src, geom, q),
        )
      }
      sendExtract(res, out, idx.state, stat, head)
      return true
    }

    const mj = RE_JSONL.exec(path)
    if (mj) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res)
      const { rec, dir } = task(deps, mj[1])
      const spec = JSONL_KINDS[mj[2]]
      const t0 = numParam(url.searchParams, 't0')
      const t1 = numParam(url.searchParams, 't1')
      if (t0 !== null && t1 !== null && t1 < t0) throw badRequest('t1', 't1 不得小于 t0')
      const stride = intParam(url.searchParams, 'stride') ?? 1
      const linkId = url.searchParams.get('link_id')
      const win = await readJsonlWindow(join(dir, spec.file), {
        t0,
        t1,
        stride,
        strideKey: spec.key,
        filter: linkId ? (r) => String(r.link_id ?? '') === linkId : undefined,
      })
      if (!win) return missingFile(res, rec.run_state, mj[2])
      const body = Buffer.from(JSON.stringify(win.records), 'utf8')
      const cap = deps.maxBytes ?? MAX_BYTES
      if (body.length > cap) {
        sendJson(res, 413, {
          error: 'payload_too_large',
          max_bytes: cap,
          bytes: body.length,
          rows: win.records.length,
          suggest: { stride: stride * Math.ceil(body.length / cap) },
        })
        return true
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-cache',
        'x-cuav-rows': String(win.records.length),
        'x-cuav-skipped': String(win.skipped),
        'x-cuav-t0': t0 === null ? '' : String(t0),
        'x-cuav-t1': t1 === null ? '' : String(t1),
        'x-cuav-state': rec.result,
      })
      res.end(head ? undefined : body)
      return true
    }
    return false
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 409) res.setHeader('retry-after', '1')
      sendJson(res, e.status, e.body)
      return true
    }
    throw e
  }
}

/** 先按计划判 413，再决定是否真的开文件读盘；HEAD 只到计划为止，不读一个字节。 */
async function runExtract(
  f32Path: string,
  rowLen: number,
  rows: number,
  deps: ResultRouteDeps,
  head: boolean,
  p: { rows: number; cols: number; bytes: number; t0: number; t1: number; f0?: number; f1?: number },
  run: (src: Awaited<ReturnType<typeof openFileRowSource>>) => Promise<Extract>,
): Promise<Extract> {
  const cap = deps.maxBytes ?? MAX_BYTES
  if (p.bytes > cap) {
    const s = Math.sqrt(cap / p.bytes)
    throw new HttpError(413, {
      error: 'payload_too_large',
      max_bytes: cap,
      rows: p.rows,
      cols: p.cols,
      bytes: p.bytes,
      suggest: { px: Math.max(1, Math.floor(p.cols * s)), py: Math.max(1, Math.floor(p.rows * s)) },
    })
  }
  if (head) {
    return { data: new Float32Array(0), rows: p.rows, cols: p.cols, t0: p.t0, t1: p.t1, f0: p.f0 ?? null, f1: p.f1 ?? null }
  }
  const src = await openFileRowSource(f32Path, rowLen, rows)
  try {
    return await run(src)
  } finally {
    await src.close()
  }
}

function sendExtract(res: ServerResponse, out: Extract, state: string, stat: Stat | null, head: boolean): void {
  const body = head ? null : Buffer.from(out.data.buffer, out.data.byteOffset, out.data.byteLength)
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-length': String(out.rows * out.cols * 4),
    'cache-control': 'no-cache',
    'x-cuav-rows': String(out.rows),
    'x-cuav-cols': String(out.cols),
    'x-cuav-t0': String(out.t0),
    'x-cuav-t1': String(out.t1),
    'x-cuav-state': state,
  }
  if (out.f0 !== null) headers['x-cuav-f0'] = String(out.f0)
  if (out.f1 !== null) headers['x-cuav-f1'] = String(out.f1)
  if (stat) headers['x-cuav-stat'] = stat
  res.writeHead(200, headers)
  res.end(body ?? undefined)
}

function task(deps: ResultRouteDeps, rawId: string): { rec: { run_state: RunState; result: string }; dir: string } {
  const id = decodeURIComponent(rawId)
  const rec = isTaskId(id) ? deps.mgr.get(id) : null
  if (!rec) throw new HttpError(404, { error: 'not_found', task_id: id })
  return { rec, dir: taskDirAbs(deps.mgr.storeConfig, id) }
}

function missingFile(res: ServerResponse, runState: RunState, kind: string): true {
  if (runState === 'queued' || runState === 'running') {
    res.setHeader('retry-after', '1')
    sendJson(res, 409, { error: 'not_ready', reason: 'product_missing', kind, run_state: runState })
  } else {
    sendJson(res, 404, { error: 'not_found', kind, message: '本次任务没有产出这种记录' })
  }
  return true
}

function notFoundOp(res: ServerResponse, taskId: string, opId: string): true {
  sendJson(res, 404, { error: 'not_found', task_id: taskId, op_id: opId })
  return true
}

function methodNotAllowed(res: ServerResponse): true {
  res.writeHead(405, { allow: 'GET, HEAD' })
  res.end()
  return true
}

function badRequest(param: string, message: string): HttpError {
  return new HttpError(400, { error: 'bad_request', param, message })
}

/** 十进制浮点参数；空串与缺省都返回 null。 */
export function numParam(sp: URLSearchParams, name: string): number | null {
  const v = sp.get(name)
  if (v === null || v === '') return null
  if (!NUM_RE.test(v)) throw badRequest(name, `${name} 必须是十进制数`)
  const n = Number(v)
  if (!Number.isFinite(n)) throw badRequest(name, `${name} 必须是有限数`)
  return n
}

/** 正整数参数；空串与缺省都返回 null。 */
export function intParam(sp: URLSearchParams, name: string): number | null {
  const v = sp.get(name)
  if (v === null || v === '') return null
  if (!INT_RE.test(v)) throw badRequest(name, `${name} 必须是不超过 9 位的正整数`)
  const n = Number(v)
  if (n < 1) throw badRequest(name, `${name} 必须不小于 1`)
  return n
}

export function parseSpectrumQuery(sp: URLSearchParams): SpectrumQuery {
  const t0 = numParam(sp, 't0')
  const t1 = numParam(sp, 't1')
  if (t0 !== null && t1 !== null && t1 < t0) throw badRequest('t1', 't1 不得小于 t0')
  const f0 = numParam(sp, 'f0')
  const f1 = numParam(sp, 'f1')
  if (f0 !== null && f1 !== null && f1 < f0) throw badRequest('f1', 'f1 不得小于 f0')
  const s = sp.get('stat')
  if (s !== null && s !== '' && !STATS.has(s)) throw badRequest('stat', 'stat 只能是 max、mean 或 min')
  return { t0, t1, f0, f1, px: intParam(sp, 'px'), py: intParam(sp, 'py'), stat: (s && s !== '' ? s : 'max') as Stat }
}

export function parseEnvelopeQuery(sp: URLSearchParams): EnvelopeQuery {
  const t0 = numParam(sp, 't0')
  const t1 = numParam(sp, 't1')
  if (t0 !== null && t1 !== null && t1 < t0) throw badRequest('t1', 't1 不得小于 t0')
  return { t0, t1, px: intParam(sp, 'px') }
}
