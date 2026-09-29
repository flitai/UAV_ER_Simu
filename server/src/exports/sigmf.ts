// 观测点原始样点导出 SigMF 的服务端实现（D-090；Q-1 / D-087 的 tools/iq_export_sigmf.py 在服务端的第二份实现）。
//
// 为什么要第二份：交付包只带便携 Node、不带 Python（D-084），界面上的「数据导出」要在交付的软件里能用，
// 就得在服务端实现。Python 版留作参考实现，两份的一致性由 tests/regression/export_parity.py 在真引擎运行上核：
//   · .sigmf-data（量化后的 int16）**逐字节相同**——量化只用 IEEE 的乘、加、floor，两种语言结果相同；
//   · .sigmf-meta 与 .cuav-links.jsonl **逐值相同**（解析成 JSON 再比）——不比字节，因为 Python 把浮点整数
//     写成 `80000000.0` 而 JavaScript 写成 `80000000`，指数写法的阈值也不同；经 log10 算出的量允许末位差。
// 算法与每条判据的来历见 Python 版的头注（14 报告 §5.2–§5.3、§6；docs/iq-format.md §4.5），这里不重抄。
//
// 原始 IQ 不进浏览器（铁律 7、D-087 ③）：本模块只读写服务器盘上的文件，端点只回摘要（routes.ts）。
// 读大文件按块流式处理、每块之间让出事件循环，导出期间服务照常应答。

import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

export const EXPORTER_VERSION = '0.1.0'
export const SIGMF_VERSION = '1.2.6'
const CUAV_EXT_VERSION = '1.0.0'
const FULL_SCALE = 32768
const CHUNK = 1 << 22                    // 每块复样点数（约 32 MB cf32），与 Python 版相同
const S3_GRID_TOL = 0.01
const REQUANT_MARGIN_MIN_DB = 20.0
const BOLTZMANN = 1.380649e-23

export class ExportError extends Error {}

type Json = Record<string, unknown>
interface CatalogParam { name: string; default?: unknown }
interface CatalogComponent {
  type: string; model_id: string; version: string; model_level: string; model_layer: string
  implementation: string; params: CatalogParam[]
}
export interface CatalogDoc { engine_version: string; components: CatalogComponent[] }

interface DiagramNode { id: string; type: string; params?: Json; scene_binding?: Json }
interface DiagramEdge { from: { node: string }; to: { node: string } }
interface ObservationPoint { id: string; node: string; products?: string[]; label?: string }
interface Diagram {
  diagram_id?: string; nodes: DiagramNode[]; edges: DiagramEdge[]
  observation_points?: ObservationPoint[]; scenario_ref?: { scenario_id: string; sha256: string }
  template_ref?: { mode?: string }
}

export interface ExportOpResult {
  op_id: string; point: string; stem: string; samples: number; state: string; lossless: boolean
  export_clipped: number; max_readback_error_codes: number; requant_margin_dB: number | null
  annotations: number; truth_rows_site: number; outside_capture: number
  files: Array<{ name: string; bytes: number }>
}

export interface ExportOptions {
  /** 仓库根（找 data/scene/*\/scenarios/ 用） */
  root: string
  runDir: string
  outDir: string
  catalog: CatalogDoc
  ops?: string[]
  stemPrefix?: string
  /** 场景文件；缺省在 data/scene/*\/scenarios/ 里按标识找，照样核对字节哈希 */
  scenarioPath?: string
  /** 进度：已处理 / 总计（cf32 字节） */
  onProgress?: (done: number, total: number) => void
  /** 写进 cuav:exporter 的名字 */
  exporterName?: string
}

// ---------------------------------------------------------------- Python 兼容的格式化

/** Python 的 `format(x, 'g')`（6 位有效数字、去尾零、指数在 < 1e-4 或 ≥ 1e6 时用） */
export function fmtG(x: number): string {
  if (x === 0) return Object.is(x, -0) ? '-0' : '0'
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf'
  const exp = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))))
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split('e')
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m
    const en = Number(e)
    return `${mant}e${en < 0 ? '-' : '+'}${String(Math.abs(en)).padStart(2, '0')}`
  }
  const s = x.toFixed(Math.max(0, 5 - exp))
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/** Python 的 `round(x, nd)`（精确平局之外逐位相同；平局在经 log10 算出的量上不会出现） */
export function roundTo(x: number, nd: number): number {
  return Number(x.toFixed(nd))
}

// ---------------------------------------------------------------- 读输入

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(path, 'utf8'))
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const b of createReadStream(path)) h.update(b as Buffer)
  return h.digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

async function readEvents(runDir: string): Promise<{ first: Json; last: Json }> {
  const path = join(runDir, 'events.jsonl')
  if (!(await exists(path))) throw new ExportError('运行目录里没有 events.jsonl')
  let first: Json | null = null
  let last: Json | null = null
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"task.state"')) continue
    const ev = JSON.parse(line) as Json
    if (ev.type !== 'task.state') continue
    const payload = ev.payload as Json
    if (!first) first = { ...payload, task_id: ev.task_id }
    last = payload
  }
  if (!first || !last) throw new ExportError('events.jsonl 里没有 task.state 事件')
  return { first, last }
}

async function readJsonl(path: string): Promise<Json[]> {
  if (!(await exists(path))) return []
  const out: Json[] = []
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) if (line.trim()) out.push(JSON.parse(line) as Json)
  return out
}

async function findScenario(root: string, id: string, sha: string, path?: string): Promise<Json> {
  if (path) {
    if ((await sha256File(path)) !== sha) {
      throw new ExportError(`给的场景文件 ${basename(path)} 的哈希与框图 scenario_ref 不符`)
    }
    return (await loadJson(path)) as Json
  }
  const base = join(root, 'data', 'scene')
  let aois: string[] = []
  try {
    aois = (await fsp.readdir(base)).sort()
  } catch {
    aois = []
  }
  const hits: string[] = []
  for (const aoi of aois) {
    const p = join(base, aoi, 'scenarios', `${id}.scenario.json`)
    if (await exists(p)) hits.push(p)
  }
  if (!hits.length) throw new ExportError(`找不到场景文件 ${id}.scenario.json（data/scene/*/scenarios/）`)
  for (const p of hits) if ((await sha256File(p)) === sha) return (await loadJson(p)) as Json
  throw new ExportError(`场景 ${id} 的文件哈希与框图 scenario_ref 不符：场景改过了，运行结果与现在的场景对不上`)
}

// ---------------------------------------------------------------- 框图遍历

const POINT_OF: Record<string, string> = { AdcQuantizer: 'S3', DDC: 'S4', Channelizer: 'S5' }

interface EmitterGains { tx_gain_dBi: number; rx_gain_dBi: number; feeder_loss_dB: number; snr_basis: string }
interface Chain {
  opId: string; node: string; point: string; siteId: string
  adc: DiagramNode; rxFe: DiagramNode | null; stages: DiagramNode[]
  emitters: Map<string, EmitterGains>
}

function param(node: DiagramNode, name: string, cat: Map<string, CatalogComponent>): unknown {
  const p = node.params ?? {}
  if (name in p) return p[name]
  const comp = cat.get(node.type)
  if (!comp) throw new ExportError(`组件目录里没有 ${node.type}`)
  for (const spec of comp.params) {
    if (spec.name === name) {
      if (!('default' in spec) || spec.default === null || spec.default === undefined) {
        throw new ExportError(`节点 ${node.id} 缺参数 ${name} 且组件目录没有缺省值`)
      }
      return spec.default
    }
  }
  throw new ExportError(`组件 ${node.type} 没有参数 ${name}`)
}

function upstream(d: Diagram, start: string): string[] {
  const preds = new Map<string, string[]>()
  for (const e of d.edges) {
    const a = preds.get(e.to.node) ?? []
    a.push(e.from.node)
    preds.set(e.to.node, a)
  }
  const seen = new Set([start])
  const order: string[] = []
  const stack = [start]
  while (stack.length) {
    const n = stack.pop()!
    order.push(n)
    for (const p of [...(preds.get(n) ?? [])].sort()) {
      if (!seen.has(p)) {
        seen.add(p)
        stack.push(p)
      }
    }
  }
  return order
}

function downstream(d: Diagram, start: string): Set<string> {
  const succ = new Map<string, string[]>()
  for (const e of d.edges) {
    const a = succ.get(e.from.node) ?? []
    a.push(e.to.node)
    succ.set(e.from.node, a)
  }
  const seen = new Set([start])
  const stack = [start]
  while (stack.length) {
    for (const s of succ.get(stack.pop()!) ?? []) {
      if (!seen.has(s)) {
        seen.add(s)
        stack.push(s)
      }
    }
  }
  return seen
}

/** 该观测点能不能导出（ADC 之后）：S3 / S4 / S5，否则 null */
export function pointOf(d: Diagram, op: ObservationPoint): string | null {
  const node = d.nodes.find((n) => n.id === op.node)
  return node ? POINT_OF[node.type] ?? null : null
}

function chainFor(d: Diagram, op: ObservationPoint, cat: Map<string, CatalogComponent>): Chain {
  const nodes = new Map(d.nodes.map((n) => [n.id, n]))
  const node = nodes.get(op.node)
  if (!node || !(node.type in POINT_OF)) {
    throw new ExportError(`观测点 ${op.id} 挂在 ${node?.type ?? '未知节点'} 上；导出只支持 ADC 之后的观测点`
      + '（S3 ADC / S4 DDC / S5 信道化），ADC 之前没有量化器、没有满量程')
  }
  const up = upstream(d, node.id)
  const upn = up.map((i) => nodes.get(i)!)
  const adcs = upn.filter((n) => n.type === 'AdcQuantizer')
  if (adcs.length !== 1) throw new ExportError(`观测点 ${op.id} 上游有 ${adcs.length} 个 ADC，应恰好一个`)
  const fes = upn.filter((n) => n.type === 'ReceiverFrontEnd')
  const sites = [...new Set(upn
    .filter((n) => n.type === 'ScenarioSource' && typeof n.scene_binding?.site_id === 'string' && n.scene_binding.site_id)
    .map((n) => String(n.scene_binding!.site_id)))].sort()
  if (sites.length !== 1) throw new ExportError(`观测点 ${op.id} 上游绑定了 ${sites.length} 个站，应恰好一个`)
  const ch: Chain = {
    opId: op.id, node: node.id, point: POINT_OF[node.type], siteId: sites[0],
    adc: adcs[0], rxFe: fes.length === 1 ? fes[0] : null, stages: [...upn].reverse(), emitters: new Map(),
  }
  const upSet = new Set(up)
  for (const n of upn) {
    if (n.type !== 'SceneEmitterSource') continue
    const eid = String(n.scene_binding?.entity_id ?? '')
    const path = [...downstream(d, n.id)].filter((x) => upSet.has(x)).sort()
    const info: EmitterGains = { tx_gain_dBi: 0.0, rx_gain_dBi: 0.0, feeder_loss_dB: 0.0, snr_basis: 'omni_matched' }
    for (const a of path.map((i) => nodes.get(i)!)) {
      if (a.type !== 'AntennaGain') continue
      const role = param(a, 'role', cat)
      if (param(a, 'pattern', cat) !== 'omni') info.snr_basis = `directional_antenna:${a.id}`
      if (param(a, 'polarization', cat) !== param(a, 'peer_polarization', cat)) info.snr_basis = `polarization_mismatch:${a.id}`
      if (role === 'tx') info.tx_gain_dBi = Number(param(a, 'gain_dBi', cat))
      else {
        info.rx_gain_dBi = Number(param(a, 'gain_dBi', cat))
        info.feeder_loss_dB = Number(param(a, 'feeder_loss_dB', cat))
      }
    }
    ch.emitters.set(eid, info)
  }
  return ch
}

// ---------------------------------------------------------------- 量化与写盘

interface QuantResult {
  samples: number; sha512: string; sha256: string; clippedExport: number
  maxReadbackErrCodes: number; lossless: boolean
}

async function quantize(cf32Path: string, n: number, amp: number, point: string, outPath: string,
  progress: (bytes: number) => void): Promise<QuantResult> {
  const h512 = createHash('sha512')
  const h256 = createHash('sha256')
  let clipped = 0
  let maxErr = 0.0
  const scale = FULL_SCALE / amp
  const inp = await fsp.open(cf32Path, 'r')
  const out = await fsp.open(outPath, 'w')
  try {
    // 缓冲区自带 ArrayBuffer（Buffer.alloc 大块不走池），Float32Array 视图起点对齐
    const inBuf = Buffer.alloc(8 * CHUNK)
    const outBuf = Buffer.alloc(4 * CHUNK)
    const f32 = new Float32Array(inBuf.buffer, inBuf.byteOffset, 2 * CHUNK)
    const i16 = new Int16Array(outBuf.buffer, outBuf.byteOffset, 2 * CHUNK)
    for (let a = 0; a < n; a += CHUNK) {
      const cnt = Math.min(CHUNK, n - a)
      const want = 8 * cnt
      let got = 0
      while (got < want) {
        const r = await inp.read(inBuf, got, want - got, 8 * a + got)
        if (r.bytesRead === 0) throw new ExportError('iq.cf32 比索引短：读到文件尾')
        got += r.bytesRead
      }
      const m = 2 * cnt
      if (point === 'S3') {
        // 与 Python 版同序：先查格点（报文更准），再查越界，最后查回读
        let off = 0
        let lo = 0
        let hi = 0
        for (let i = 0; i < m; i++) {
          const c = f32[i] * scale
          const q = Math.floor(c + 0.5)
          const d = Math.abs(c - q)
          if (d > off) off = d
          if (q < lo) lo = q
          if (q > hi) hi = q
          i16[i] = q
        }
        if (off > S3_GRID_TOL) {
          throw new ExportError(`S3 样点不在 ADC 格点上（最大偏离 ${off.toFixed(4)} 码）：数据不是这台 ADC 出来的，`
            + '不四舍五入蒙混（铁律 10）')
        }
        if (lo < -FULL_SCALE || hi > FULL_SCALE - 1) {
          throw new ExportError('S3 码值越出 int16：ADC 位数超过 16 或满量程与数据不符')
        }
        let bad = 0
        for (let i = 0; i < m; i++) if (Math.fround((i16[i] / FULL_SCALE) * amp) !== f32[i]) bad++
        if (bad) throw new ExportError(`S3 回读与引擎 float32 不逐位相同（${bad} 个分量）：无损承诺不成立`)
      } else {
        for (let i = 0; i < m; i += 2) {
          let over = false
          for (let k = 0; k < 2; k++) {
            const c = f32[i + k] * scale
            let q = Math.floor(c + 0.5)
            if (q > FULL_SCALE - 1 || q < -FULL_SCALE) {
              over = true
              q = q > 0 ? FULL_SCALE - 1 : -FULL_SCALE
            } else {
              const e = Math.abs(q - c)
              if (e > maxErr) maxErr = e
            }
            i16[i + k] = q
          }
          if (over) clipped++
        }
      }
      const chunk = outBuf.subarray(0, 2 * m)
      h512.update(chunk)
      h256.update(chunk)
      await out.write(chunk, 0, chunk.length)
      progress(want)
    }
  } finally {
    await inp.close()
    await out.close()
  }
  return {
    samples: n, sha512: h512.digest('hex'), sha256: h256.digest('hex'), clippedExport: clipped,
    maxReadbackErrCodes: maxErr, lossless: point === 'S3',
  }
}

// ---------------------------------------------------------------- 真值注记

function sampleAt(t: number, fs: number): number {
  if (!(t > 0.0)) return 0
  return Math.floor(t * fs + 0.5)
}

function bisectRight(a: number[], x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x < a[mid]) hi = mid
    else lo = mid + 1
  }
  return lo
}

function linkAt(links: Json[], starts: number[], t: number): Json | null {
  if (!links.length) return null
  const i = bisectRight(starts, t)
  let best: [number, Json] | null = null
  for (const j of [i - 1, i]) {
    if (j >= 0 && j < links.length) {
      const r = links[j]
      const d = Math.abs(0.5 * (Number(r.valid_from_s) + Number(r.valid_to_s)) - t)
      if (best === null || d < best[0]) best = [d, r]
    }
  }
  return best ? best[1] : null
}

function presetKeys(scen: Json): Json {
  const ids = new Set<string>()
  for (const e of (scen.emitters as Json[] | undefined) ?? []) {
    const w = ((e.emission as Json | undefined)?.waveform as Json | undefined) ?? {}
    if (typeof w.preset_id === 'string') ids.add(w.preset_id)
  }
  return ids.size ? { 'cuav:preset_ids': [...ids].sort(), 'cuav:presets_version': 'v1' } : {}
}

function annotations(truth: Json[], linksById: Map<string, Json[]>, scen: Json, ch: Chain, n0: number | null,
  fs: number, fc: number, startSample: number, n: number): { ann: Json[]; truthRowsSite: number; outsideCapture: number } {
  const starts = new Map([...linksById].map(([k, v]) => [k, v.map((r) => Number(r.valid_from_s))]))
  const emitters = new Map(((scen.emitters as Json[]) ?? []).map((e) => [String(e.id), e]))
  const out: Json[] = []
  let truthRowsSite = 0
  let outsideCapture = 0
  const t0 = startSample / fs
  for (const r of truth) {
    if (r.site_id !== undefined && r.site_id !== null && r.site_id !== ch.siteId) continue
    truthRowsSite++
    const ts = Number(r.t_s)
    const te = Number(r.t_end_s)
    const s0 = ts > t0 ? sampleAt(ts - t0, fs) : 0
    const s1 = Math.min(sampleAt(te - t0, fs), n)
    if (s1 <= s0) {
      outsideCapture++
      continue
    }
    const eid = r.emitter_id as string | undefined
    const em = (eid !== undefined ? emitters.get(eid) : undefined) ?? {}
    const a: Json = { 'core:sample_start': s0, 'core:sample_count': s1 - s0, 'core:label': r.label }
    if (r.center_Hz !== undefined && r.center_Hz !== null && r.bw_Hz !== undefined && r.bw_Hz !== null) {
      const lo = Number(r.center_Hz) - Number(r.bw_Hz) / 2
      const hi = Number(r.center_Hz) + Number(r.bw_Hz) / 2
      a['core:freq_lower_edge'] = lo
      a['core:freq_upper_edge'] = hi
      a['cuav:in_capture_band'] = hi > fc - fs / 2 && lo < fc + fs / 2
    }
    a['cuav:emitter_id'] = eid ?? null
    for (const k of ['platform_type', 'equipment_model']) {
      if (em[k] !== undefined && em[k] !== null) a[`cuav:${k}`] = em[k]
    }
    a['cuav:waveform'] = r.waveform ?? null
    if (r.preset_id) a['cuav:preset_id'] = r.preset_id
    const lid = `${ch.siteId}-${eid}`
    const link = linkAt(linksById.get(lid) ?? [], starts.get(lid) ?? [], 0.5 * (ts + te))
    if (link !== null) {
      for (const k of ['distance_m', 'line_of_sight', 'path_loss_dB', 'doppler_Hz']) a[`cuav:${k}`] = link[k]
      a['cuav:diffraction_dB'] = link.diffraction_dB ?? 0.0
      a['cuav:link_frame_t_s'] = link.valid_from_s
    }
    const gains = eid !== undefined ? ch.emitters.get(eid) : undefined
    const txPower = (em.emission as Json | undefined)?.tx_power_dBm
    if (n0 === null) {
      a['cuav:snr_dB'] = null
      a['cuav:snr_basis'] = 'no_thermal_noise_model'
    } else if (link === null || gains === undefined || txPower === undefined || txPower === null || !r.bw_Hz) {
      a['cuav:snr_dB'] = null
      a['cuav:snr_basis'] = 'missing_input'
    } else if (gains.snr_basis !== 'omni_matched') {
      a['cuav:snr_dB'] = null
      a['cuav:snr_basis'] = gains.snr_basis
    } else {
      const pRx = Number(txPower) + gains.tx_gain_dBi + gains.rx_gain_dBi - Number(link.path_loss_dB) - gains.feeder_loss_dB
      const noise = n0 + 10 * Math.log10(Number(r.bw_Hz))
      a['cuav:snr_dB'] = roundTo(pRx - noise, 6)
      a['cuav:snr_basis'] = 'link_budget'
    }
    out.push(a)
  }
  out.sort((x, y) => {
    const d0 = Number(x['core:sample_start']) - Number(y['core:sample_start'])
    if (d0) return d0
    const ex = String(x['cuav:emitter_id'] ?? '')
    const ey = String(y['cuav:emitter_id'] ?? '')
    if (ex !== ey) return ex < ey ? -1 : 1
    return Number(x['core:sample_count']) - Number(y['core:sample_count'])
  })
  return { ann: out, truthRowsSite, outsideCapture }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const o: Json = {}
    for (const k of Object.keys(v as Json).sort()) o[k] = sortKeys((v as Json)[k])
    return o
  }
  return v
}

// ---------------------------------------------------------------- 一个观测点

async function exportOp(o: ExportOptions, d: Diagram, diagramSha: string, scen: Json, first: Json,
  cat: Map<string, CatalogComponent>, op: ObservationPoint, stem: string,
  progress: (bytes: number) => void): Promise<ExportOpResult> {
  const ch = chainFor(d, op, cat)
  const opDir = join(o.runDir, op.id)
  const idxPath = join(opDir, 'iq.index.json')
  const cfPath = join(opDir, 'iq.cf32')
  if (!(await exists(idxPath))) throw new ExportError(`观测点 ${op.id} 没有 iq.index.json：iq 产品没开，或运行没有正常收尾`)
  const idx = (await loadJson(idxPath)) as Json
  const n = Number(idx.samples)
  const size = (await fsp.stat(cfPath)).size
  if (size !== 8 * n) throw new ExportError(`iq.cf32 长度 ${size} 字节与索引 ${n} 个样点对不上`)
  const fs = Number(idx.sample_rate_Hz)
  const fc = Number(idx.center_Hz)

  const fsDbm = Number(param(ch.adc, 'full_scale_dBm', cat))
  const bits = Math.trunc(Number(param(ch.adc, 'bits', cat)))
  const amp = 10.0 ** (fsDbm / 20.0)
  const nf = ch.rxFe ? Number(param(ch.rxFe, 'nf_dB', cat)) : null
  const gain = ch.rxFe ? Number(param(ch.rxFe, 'gain_dB', cat)) : null
  const thermal = ch.rxFe !== null && param(ch.rxFe, 'noise_mode', cat) === 'thermal'
  const n0 = thermal && nf !== null
    ? 10 * Math.log10(BOLTZMANN * Number(param(ch.rxFe!, 'reference_temperature_K', cat)) * 1e3) + nf
    : null

  const dataName = `${stem}.sigmf-data`
  const q = await quantize(cfPath, n, amp, ch.point, join(o.outDir, dataName), progress)

  const reasons: string[] = [...((idx.state_reasons as string[] | undefined) ?? [])]
  let state = String(idx.state ?? 'valid')
  let requant: Json | null = null
  if (ch.point !== 'S3') {
    const qNoise = 10 * Math.log10((amp / FULL_SCALE) ** 2 / 6)
    const floor = n0 !== null && gain !== null ? n0 + gain + 10 * Math.log10(fs) : null
    const margin = floor === null ? null : floor - qNoise
    requant = {
      step_codes: 1, full_scale_dBm: fsDbm, quantization_noise_dBm: roundTo(qNoise, 4),
      noise_floor_dBm: floor === null ? null : roundTo(floor, 4),
      margin_dB: margin === null ? null : roundTo(margin, 4),
      max_readback_error_codes: roundTo(q.maxReadbackErrCodes, 6),
    }
    if (margin === null) {
      state = 'degraded'
      reasons.push('export_requantization：接收机前端不注入热噪声（或链上没有前端），算不出底噪，重量化余量未知')
    } else if (margin < REQUANT_MARGIN_MIN_DB) {
      state = 'degraded'
      reasons.push(`export_requantization：量化噪声只比底噪低 ${margin.toFixed(1)} dB（线 ${fmtG(REQUANT_MARGIN_MIN_DB)} dB）`)
    }
    if (q.clippedExport > 0) {
      if (q.clippedExport / n > Number(param(ch.adc, 'degrade_clip_ratio', cat))) state = 'degraded'
      reasons.push(`export_clip：${q.clippedExport} / ${n} 个样点在导出量化时削顶`)
    }
  }

  const links = await readJsonl(join(o.runDir, 'links.jsonl'))
  const byId = new Map<string, Json[]>()
  for (const r of links) {
    const k = String(r.link_id)
    const a = byId.get(k) ?? []
    a.push(r)
    byId.set(k, a)
  }
  for (const v of byId.values()) v.sort((x, y) => Number(x.valid_from_s) - Number(y.valid_from_s))
  const truth = await readJsonl(join(o.runDir, 'truth.jsonl'))
  const { ann, truthRowsSite, outsideCapture } = annotations(truth, byId, scen, ch, n0, fs, fc, Number(idx.start_sample), n)

  const siteLinks: Json[] = []
  for (const eid of [...ch.emitters.keys()].sort()) siteLinks.push(...(byId.get(`${ch.siteId}-${eid}`) ?? []))
  siteLinks.sort((x, y) => {
    const d0 = Number(x.valid_from_s) - Number(y.valid_from_s)
    if (d0) return d0
    return String(x.link_id) < String(y.link_id) ? -1 : String(x.link_id) > String(y.link_id) ? 1 : 0
  })
  const linksName = `${stem}.cuav-links.jsonl`
  await fsp.writeFile(join(o.outDir, linksName), siteLinks.map((r) => JSON.stringify(sortKeys(r)) + '\n').join(''), 'utf8')

  const stages = ch.stages.map((s) => {
    const c = cat.get(s.type)!
    return {
      node_id: s.id, type: s.type, model_id: c.model_id, model_version: c.version,
      model_level: c.model_level, model_layer: c.model_layer, implementation: c.implementation,
    }
  })
  const hw = (nf !== null ? `仿真接收机：噪声系数 ${fmtG(nf)} dB、前端增益 ${fmtG(gain!)} dB；` : '仿真接收机；')
    + `ADC ${bits} 位、满量程 ${fmtG(fsDbm)} dBm；`
    + stages.filter((s) => ['RxFilter', 'DDC', 'Channelizer'].includes(s.type)).map((s) => `${s.type} ${s.node_id}`).join('；')
  const meta = {
    global: {
      'core:datatype': 'ci16_le',
      'core:sample_rate': fs,
      'core:version': SIGMF_VERSION,
      'core:num_channels': 1,
      'core:sha512': q.sha512,
      'core:description': `场景 ${scen.scenario_id}，站 ${ch.siteId}，观测点 ${ch.point}（${op.id}），`
        + `${fmtG(n / fs)} s，${fmtG(fs / 1e6)} MS/s @ ${fmtG(fc / 1e6)} MHz`,
      'core:hw': hw,
      'core:recorder': `cuav_run ${first.engine_version}`,
      'core:extensions': [{ name: 'cuav', version: CUAV_EXT_VERSION, optional: true }],
      'cuav:observation_point': ch.point,
      'cuav:op_id': op.id,
      'cuav:site_id': ch.siteId,
      'cuav:full_scale_dBm': fsDbm,
      'cuav:full_scale_code': FULL_SCALE,
      'cuav:calibration_source': ((idx.calibration as Json | undefined) ?? {}).source ?? null,
      'cuav:scale': idx.scale ?? null,
      'cuav:adc_bits': bits,
      'cuav:time_basis': 'logical_sim',
      'cuav:continuity': 'continuous',
      'cuav:start_sample': Math.trunc(Number(idx.start_sample)),
      'cuav:t0_s': Number(idx.t0_s),
      'cuav:seed': first.seed ?? null,
      'cuav:seed_source': first.seed_source ?? null,
      'cuav:diagram_id': first.diagram_id ?? null,
      'cuav:diagram_sha256': diagramSha,
      'cuav:scenario_id': scen.scenario_id,
      'cuav:scenario_sha256': d.scenario_ref!.sha256,
      'cuav:origin_kind': d.template_ref?.mode === 'mixed' ? 'mixed' : 'synthetic',
      'cuav:content_sha256': q.sha256,
      'cuav:lossless': q.lossless,
      'cuav:quality': {
        state, reasons,
        engine_clipped_samples: Math.trunc(Number(idx.clipped_samples ?? 0)),
        export_clipped_samples: q.clippedExport,
        export_requantization: requant,
      },
      'cuav:signal_trace': idx.trace ?? null,
      ...presetKeys(scen),
      'cuav:model_trace': stages,
      'cuav:links_file': linksName,
      'cuav:exporter': `${o.exporterName ?? 'server/src/exports/sigmf.ts'} ${EXPORTER_VERSION}`,
    },
    captures: [{ 'core:sample_start': 0, 'core:frequency': fc }],
    annotations: ann,
  }
  const metaName = `${stem}.sigmf-meta`
  await fsp.writeFile(join(o.outDir, metaName), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  const files = []
  for (const name of [dataName, metaName, linksName]) files.push({ name, bytes: (await fsp.stat(join(o.outDir, name))).size })
  return {
    op_id: op.id, point: ch.point, stem, samples: n, state, lossless: q.lossless,
    export_clipped: q.clippedExport, max_readback_error_codes: q.maxReadbackErrCodes,
    requant_margin_dB: requant ? (requant.margin_dB as number | null) : null,
    annotations: ann.length, truth_rows_site: truthRowsSite, outside_capture: outsideCapture, files,
  }
}

/** 一次运行里要导出的观测点（开了 iq、挂在 ADC 之后）。只读，不碰样点文件 */
export function exportableOps(d: Diagram): ObservationPoint[] {
  return (d.observation_points ?? []).filter((op) => (op.products ?? []).includes('iq') && pointOf(d, op) !== null)
}

export async function exportRun(o: ExportOptions): Promise<ExportOpResult[]> {
  const diagramPath = join(o.runDir, 'diagram.json')
  if (!(await exists(diagramPath))) throw new ExportError('运行目录里没有 diagram.json')
  const diagramBytes = await fsp.readFile(diagramPath)
  const d = JSON.parse(diagramBytes.toString('utf8')) as Diagram
  const { first, last } = await readEvents(o.runDir)
  if (last.run_state !== 'finished') throw new ExportError(`运行没有正常结束（run_state = ${String(last.run_state)}）`)
  if (last.result === 'invalid') throw new ExportError('运行结果是 invalid，不导出')
  if (first.diagram_id !== d.diagram_id) {
    throw new ExportError(`框图文件（${d.diagram_id}）不是这次运行用的（${String(first.diagram_id)}）`)
  }
  if (!d.scenario_ref) throw new ExportError('框图没有 scenario_ref：只导出合成与混合增强运行（真值与链路几何都来自场景）')
  const scen = await findScenario(o.root, d.scenario_ref.scenario_id, d.scenario_ref.sha256, o.scenarioPath)
  if (o.catalog.engine_version !== first.engine_version) {
    throw new ExportError(`引擎版本对不上：运行用的是 ${String(first.engine_version)}，现在的是 ${o.catalog.engine_version}`)
  }
  const cat = new Map(o.catalog.components.map((c) => [c.type, c]))
  let want = (d.observation_points ?? []).filter((op) => (op.products ?? []).includes('iq'))
  if (o.ops && o.ops.length) {
    const have = new Set(want.map((op) => op.id))
    const missing = o.ops.filter((x) => !have.has(x)).sort()
    if (missing.length) throw new ExportError(`这些观测点没开 iq 产品：${missing.join('、')}`)
    want = want.filter((op) => o.ops!.includes(op.id))
  }
  if (!want.length) throw new ExportError('框图里没有开 iq 产品的观测点')
  await fsp.mkdir(o.outDir, { recursive: true })
  const prefix = o.stemPrefix ?? (first.task_id as string | undefined) ?? basename(o.runDir)
  const dsha = createHash('sha256').update(diagramBytes).digest('hex')
  // 进度按 cf32 字节计：先把各观测点的样点数加起来
  let total = 0
  for (const op of want) {
    try {
      total += 8 * Number(((await loadJson(join(o.runDir, op.id, 'iq.index.json'))) as Json).samples)
    } catch {
      // 缺索引的由 exportOp 报错
    }
  }
  let done = 0
  const progress = (b: number) => {
    done += b
    o.onProgress?.(done, total)
  }
  const out: ExportOpResult[] = []
  for (const op of want) out.push(await exportOp(o, d, dsha, scen, first, cat, op, `${prefix}_${op.id}`, progress))
  return out
}
