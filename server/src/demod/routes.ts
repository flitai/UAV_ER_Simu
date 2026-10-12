// 解调端点（D-107）：从一次运行保存的原始 IQ 里按需解调一个突发，只把点集送到浏览器（铁律 7）。
//
//   GET /api/v1/results/{task}/{op}/demod/bursts               可解调的突发（真值行里 OFDM / DroneID 广播 / GFSK、在该观测点可用频带内）
//   GET /api/v1/results/{task}/{op}/demod?emitter_id&t_s       解调一个突发 → 二进制帧（D-044 同一布局）：
//       [u32 LE 帧头长][UTF-8 JSON 帧头，空格补齐到 4 字节][Float32 LE 数据]
//       数据按帧头 sections 依次排列：OFDM 为 points（I, Q 交织）；GFSK 为 deviations（Hz）与 trace（相对包起点秒, Hz 交织）
//
// 客户端只能点名一个真值行（辐射源 + 起始时刻），预设、频率与粗窗都由服务端从真值行取。
// 运行未结束回 409（iq.cf32 可能还在写）；观测点没开 iq 回 404；响应里不出现服务器路径（04 §8.6）。
// 计算在事件循环里同步跑（一个 20 MHz 图传突发约几十毫秒），一次只算一个，最近 32 个结果按键缓存。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { sendJson } from '../static.js'
import { HttpError, type TaskManager } from '../tasks/manager.js'
import { isTaskId, taskDirAbs } from '../tasks/store.js'
import { OP_ID_RE } from '../ws/events.js'
import { ExportError, opBand, type CatalogDoc } from '../exports/sigmf.js'
import {
  ALGO_VERSION, demod, demodulable, loadPresetDocs, openIq, overlaps,
  type DemodResult, type Json, type PresetDocs, type State, type TruthRow,
} from './core.js'

export interface DemodDeps {
  root: string
  mgr: TaskManager
  catalog: () => Promise<CatalogDoc>
}

const RE_BURSTS = /^\/api\/v1\/results\/([^/]+)\/([^/]+)\/demod\/bursts$/
const RE_DEMOD = /^\/api\/v1\/results\/([^/]+)\/([^/]+)\/demod$/
const EMITTER_RE = /^[A-Za-z0-9_.-]{1,64}$/
const T_TOL_S = 1e-9
const CACHE_MAX = 32

let docs: PresetDocs | null = null
const cache = new Map<string, Buffer>()
let busy: Promise<unknown> = Promise.resolve()

interface OpCtx {
  taskId: string; opId: string; dir: string
  iq: Awaited<ReturnType<typeof openIq>>
  band: { lo: number; hi: number; transient_s: number; site_id: string | null }
  rows: TruthRow[]
}

export async function handleDemodRoutes(req: IncomingMessage, res: ServerResponse, url: URL, deps: DemodDeps): Promise<boolean> {
  const path = url.pathname
  const mb = RE_BURSTS.exec(path)
  const md = mb ? null : RE_DEMOD.exec(path)
  if (!mb && !md) return false
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return true
  }
  try {
    const m = (mb ?? md)!
    if (mb) {
      sendJson(res, 200, await listBursts(await opCtx(deps, m[1], m[2]), deps))
      return true
    }
    const emitter = url.searchParams.get('emitter_id') ?? ''
    const tRaw = url.searchParams.get('t_s') ?? ''
    const t = Number(tRaw)
    if (!EMITTER_RE.test(emitter)) throw new HttpError(400, { error: 'bad_request', param: 'emitter_id', message: '缺辐射源标识' })
    if (tRaw === '' || !Number.isFinite(t)) throw new HttpError(400, { error: 'bad_request', param: 't_s', message: '缺突发起始时刻' })
    const ctx = await opCtx(deps, m[1], m[2])
    const key = `${ctx.taskId}|${ctx.opId}|${emitter}|${t}|${ALGO_VERSION}`
    let frame = cache.get(key)
    if (!frame) {
      const run = busy.then(() => demodOne(ctx, deps, emitter, t))
      busy = run.catch(() => undefined)
      frame = await run
      cache.set(key, frame)
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': frame.length, 'cache-control': 'no-store' })
    res.end(frame)
    return true
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 409) res.setHeader('retry-after', '1')
      sendJson(res, e.status, e.body)
      return true
    }
    if (e instanceof ExportError) {
      sendJson(res, 422, { error: 'unprocessable', message: e.message })
      return true
    }
    throw e
  }
}

async function opCtx(deps: DemodDeps, rawTask: string, rawOp: string): Promise<OpCtx> {
  const taskId = decodeURIComponent(rawTask)
  const opId = decodeURIComponent(rawOp)
  const rec = isTaskId(taskId) ? deps.mgr.get(taskId) : null
  if (!rec) throw new HttpError(404, { error: 'not_found', task_id: taskId })
  if (!OP_ID_RE.test(opId)) throw new HttpError(404, { error: 'not_found', task_id: taskId, op_id: opId })
  if (rec.run_state === 'queued' || rec.run_state === 'running') {
    throw new HttpError(409, { error: 'not_ready', reason: 'run_in_progress', run_state: rec.run_state })
  }
  const dir = taskDirAbs(deps.mgr.storeConfig, taskId)
  const diagram = JSON.parse(await fsp.readFile(join(dir, 'diagram.json'), 'utf8')) as Json
  const op = ((diagram.observation_points as Json[] | undefined) ?? []).find((o) => o.id === opId)
  if (!op || !((op.products as string[] | undefined) ?? []).includes('iq')) {
    throw new HttpError(404, { error: 'not_found', reason: 'iq_missing', op_id: opId, message: '该观测点没有保存原始 IQ' })
  }
  let iq: OpCtx['iq']
  try {
    iq = await openIq(join(dir, opId))
  } catch {
    throw new HttpError(404, { error: 'not_found', reason: 'iq_missing', op_id: opId, message: '该观测点的原始 IQ 不完整' })
  }
  const band = await opBand(deps.root, diagram, opId, await deps.catalog(), iq.fs, iq.fc)
  let rows: TruthRow[] = []
  try {
    const text = await fsp.readFile(join(dir, 'truth.jsonl'), 'utf8')
    rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as TruthRow)
  } catch {
    rows = []
  }
  if (band.site_id !== null) rows = rows.filter((r) => r.site_id === band.site_id)
  return { taskId, opId, dir, iq, band, rows }
}

function inBand(r: TruthRow, band: OpCtx['band']): boolean {
  return r.center_Hz - r.bw_Hz / 2 >= band.lo && r.center_Hz + r.bw_Hz / 2 <= band.hi
}

function edgeOf(r: TruthRow, ctx: OpCtx): boolean {
  const t0 = ctx.iq.t0 + ctx.band.transient_s
  const t1 = ctx.iq.t0 + ctx.iq.samples / ctx.iq.fs
  return r.t_s - 1e-5 < t0 || r.t_end_s + 1e-4 > t1
}

async function presetDocs(deps: DemodDeps): Promise<PresetDocs> {
  if (!docs) docs = await loadPresetDocs(deps.root)
  return docs
}

function presetName(d: PresetDocs, pid: string | undefined): string | null {
  for (const doc of [d.ofdm, d.gfsk]) {
    const p = (doc.presets as Json[]).find((x) => x.id === pid)
    if (p) return String(p.name ?? pid)
  }
  return null
}

async function listBursts(ctx: OpCtx, deps: DemodDeps): Promise<Json> {
  const d = await presetDocs(deps)
  const sel = ctx.rows.filter((r) => demodulable(r.waveform) && inBand(r, ctx.band))
  const emitters = new Map<string, Json>()
  for (const r of sel) {
    const e = emitters.get(r.emitter_id) ?? {
      emitter_id: r.emitter_id, label: r.label ?? null, waveform: r.waveform, preset_id: r.preset_id ?? null,
      preset_name: presetName(d, r.preset_id), count: 0,
    }
    e.count = (e.count as number) + 1
    emitters.set(r.emitter_id, e)
  }
  return {
    op_id: ctx.opId, sample_rate_Hz: ctx.iq.fs, center_Hz: ctx.iq.fc, band_Hz: [ctx.band.lo, ctx.band.hi],
    site_id: ctx.band.site_id, algo_version: ALGO_VERSION,
    emitters: [...emitters.values()],
    bursts: sel.map((r) => ({
      emitter_id: r.emitter_id, label: r.label ?? null, waveform: r.waveform, preset_id: r.preset_id ?? null,
      t_s: r.t_s, t_end_s: r.t_end_s, center_Hz: r.center_Hz, bw_Hz: r.bw_Hz,
      overlap: overlaps(r, ctx.rows), edge: edgeOf(r, ctx),
    })),
  }
}

async function linkDelay(dir: string, siteId: string | undefined, emitter: string, t: number): Promise<number | null> {
  if (!siteId) return null
  let text: string
  try {
    text = await fsp.readFile(join(dir, 'links.jsonl'), 'utf8')
  } catch {
    return null
  }
  const want = `${siteId}-${emitter}`
  let best: number | null = null
  let bd = Infinity
  for (const l of text.split('\n')) {
    if (!l.includes(want)) continue
    const r = JSON.parse(l) as Json
    if (r.link_id !== want) continue
    const d = Math.abs(Number(r.t_s) - t)
    if (d < bd) {
      bd = d
      best = Number(r.delay_s)
    }
  }
  return best
}

async function demodOne(ctx: OpCtx, deps: DemodDeps, emitter: string, t: number): Promise<Buffer> {
  const row = ctx.rows.find((r) => r.emitter_id === emitter && Math.abs(r.t_s - t) <= T_TOL_S)
  if (!row) throw new HttpError(404, { error: 'not_found', reason: 'burst_not_found', emitter_id: emitter, t_s: t })
  const d = await presetDocs(deps)
  let res: DemodResult
  if (!demodulable(row.waveform)) res = { state: 'not_applicable', reasons: [`波形 ${String(row.waveform)} 无星座`] }
  else if (!inBand(row, ctx.band)) res = { state: 'not_applicable', reasons: ['突发不在该观测点的可用频带内'] }
  else res = await demod(ctx.iq, row, d)
  let state: State = res.state
  const reasons = [...res.reasons]
  const ov = overlaps(row, ctx.rows)
  if (state === 'valid' && ov.length) {
    state = 'degraded'
    reasons.push(`co_channel：与 ${ov.join('、')} 同时同频`)
  }
  if (state === 'valid' && edgeOf(row, ctx)) {
    state = 'degraded'
    reasons.push('edge：取段靠近文件起止或上游滤波器的起始暂态')
  }
  const head: Json = {
    schema: 'cuav-demod/1', algo_version: ALGO_VERSION, task_id: ctx.taskId, op_id: ctx.opId,
    emitter_id: row.emitter_id, label: row.label ?? null, waveform: row.waveform, preset_id: row.preset_id ?? null,
    preset_name: presetName(d, row.preset_id), t_s: row.t_s, t_end_s: row.t_end_s, center_Hz: row.center_Hz,
    bw_Hz: row.bw_Hz, state, reasons, overlap: ov,
    truth: { cfo_Hz: row.cfo_Hz ?? null, delay_s: await linkDelay(ctx.dir, row.site_id, row.emitter_id, row.t_s) },
    trace: {
      model_id: 'iq-demod', model_version: ALGO_VERSION, model_level: 'E2', model_layer: 'M3', credibility: 'V1',
      parameter_version: `presets-${String(d.ofdm.version ?? '')}+gfsk-${String(d.gfsk.version ?? '')}`,
      confidence: null, trace_id: `${ctx.taskId}:${ctx.opId}:${row.emitter_id}:${row.t_s}`,
    },
  }
  const parts: Float32Array[] = []
  const sections: Json[] = []
  if ('kind' in res && res.kind === 'ofdm') {
    const n = res.points.re.length
    const pts = new Float32Array(2 * n)
    for (let i = 0; i < n; i++) {
      pts[2 * i] = res.points.re[i]
      pts[2 * i + 1] = res.points.im[i]
    }
    parts.push(pts)
    sections.push({ name: 'points', count: n, stride: 2 })
    Object.assign(head, {
      kind: 'ofdm', constellation: res.constellation, variant: res.variant, n_symbols: res.n_symbols,
      n_subcarriers: res.n_subcarriers, evm_rms: res.evm_rms, mer_dB: res.mer_dB, cfo_Hz: res.cfo_Hz,
      delay_s: res.delay_s, q: res.q, eps_Hz: res.eps_Hz, sync_ratio: res.sync_ratio, ideal: res.ideal,
    })
  } else if ('kind' in res && res.kind === 'gfsk') {
    parts.push(Float32Array.from(res.deviations))
    sections.push({ name: 'deviations', count: res.deviations.length, stride: 1 })
    parts.push(Float32Array.from(res.trace))
    sections.push({ name: 'trace', count: res.trace.length / 2, stride: 2 })
    Object.assign(head, {
      kind: 'gfsk', modulation: res.modulation, bt: res.bt, symbol_rate_Hz: res.symbol_rate_Hz,
      deviation_nominal_Hz: res.deviation_nominal_Hz, deviation_Hz: res.deviation_Hz, n_symbols: res.n_symbols,
      cfo_Hz: res.cfo_Hz, delay_s: res.delay_s, header_match: res.header_match,
    })
  } else {
    Object.assign(head, { kind: null, sync_ratio: (res as { sync_ratio?: number }).sync_ratio ?? null })
  }
  head.sections = sections
  return encodeFrame(head, parts)
}

export function encodeFrame(head: Json, parts: Float32Array[]): Buffer {
  const json = Buffer.from(JSON.stringify(head), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const headerLen = json.length + pad
  const dataBytes = parts.reduce((a, p) => a + p.byteLength, 0)
  const out = Buffer.alloc(4 + headerLen + dataBytes)
  out.writeUInt32LE(headerLen, 0)
  json.copy(out, 4)
  for (let i = 0; i < pad; i++) out[4 + json.length + i] = 0x20
  let off = 4 + headerLen
  for (const p of parts) {
    Buffer.from(p.buffer, p.byteOffset, p.byteLength).copy(out, off)
    off += p.byteLength
  }
  return out
}
