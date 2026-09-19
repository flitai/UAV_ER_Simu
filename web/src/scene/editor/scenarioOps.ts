// 场景文档的编辑操作（06 备忘录 §9C G-4）。
//
// 全是纯函数：拿一份场景文档，返回改过的新文档，不改入参。理由是撤销栈存的就是整份文档
// （web/src/state/reducer.ts 的 scene/edit），纯函数让「一次操作一步撤销」自然成立。
//
// 这里只做结构编辑，不做校验——校验分两层：schema 由服务端与引擎守，语义由 cuav_run
// --scenario-track 守（D-042）。前端只在表单上做范围提示，不复刻规则。

import type { ScenarioDoc } from '../../state/types.js'
import { chordDistanceM, type Lla, type Waypoint } from './preview.js'

export type Obj = Record<string, unknown>

/**
 * 新航点的缺省速度（m/s）。
 *
 * **必须为正**：schema 是 `exclusiveMinimum: 0`，引擎 `scenario_json.cpp` 也调 `positive()`，
 * 所以 0 的航点存不进去——服务端 `PUT` 会起 `cuav_run --scenario-track` 校验，直接被拒。
 * 2026-09-19 用户实测撞到：布一个目标、画几个航点，保存报
 * 「`routes[2].waypoints[0]` 的 `speed_mps` 必须为正」。根子是 `addEmitter` 当初给首个航点写了 0，
 * 而后续航点「继承上一个的速度」，于是一路传下去。
 */
export const DEFAULT_SPEED_MPS = 15

/**
 * 沿用上一个航点的速度。**非正的不算数**——`typeof x === 'number'` 对 0 为真，
 * 原来的 `?? 15` 式兜底因此从不触发，一个坏值会顺着整条航线传下去。
 */
function speedFrom(prev: Obj | undefined): number {
  const v = prev?.speed_mps
  return typeof v === 'number' && v > 0 ? v : DEFAULT_SPEED_MPS
}

function clone(doc: ScenarioDoc): ScenarioDoc {
  return JSON.parse(JSON.stringify(doc)) as ScenarioDoc
}

export function sites(doc: ScenarioDoc | null): Obj[] {
  return Array.isArray(doc?.sites) ? (doc!.sites as Obj[]) : []
}

export function emitters(doc: ScenarioDoc | null): Obj[] {
  return Array.isArray(doc?.emitters) ? (doc!.emitters as Obj[]) : []
}

export function routes(doc: ScenarioDoc | null): Obj[] {
  return Array.isArray(doc?.routes) ? (doc!.routes as Obj[]) : []
}

export function activities(doc: ScenarioDoc | null): Obj[] {
  return Array.isArray(doc?.activities) ? (doc!.activities as Obj[]) : []
}

/**
 * 某辐射源可能用到的全部中心频点：基频 + 每条 hop 活动的 `center_Hz` 或 `sequence[]`。
 * 与 C++ 的 `geo::emitter_center_set`（geo/src/activity.cpp）同一口径，
 * 铁律 4 的闸要对每个频点都成立——基频过闸不代表序列里每一跳都过得了（G-6，D-069）。
 */
export function emitterCenters(doc: ScenarioDoc | null, emitterId: string): number[] {
  const em = emitters(doc).find((e) => String(e.id) === emitterId)
  const base = Number((((em?.emission ?? {}) as Record<string, unknown>).center_Hz) ?? NaN)
  const out: number[] = Number.isFinite(base) ? [base] : []
  for (const a of activities(doc)) {
    if (String(a.emitter_id) !== emitterId || String(a.event) !== 'hop') continue
    const args = (a.args ?? {}) as Record<string, unknown>
    if (typeof args.center_Hz === 'number' && Number.isFinite(args.center_Hz)) out.push(args.center_Hz)
    if (Array.isArray(args.sequence)) {
      for (const f of args.sequence) if (typeof f === 'number' && Number.isFinite(f)) out.push(f)
    }
  }
  return out
}

export function routeOf(doc: ScenarioDoc | null, emitterId: string): Obj | null {
  return routes(doc).find((r) => r.emitter_id === emitterId) ?? null
}

export function waypointsOf(doc: ScenarioDoc | null, emitterId: string): Waypoint[] {
  const r = routeOf(doc, emitterId)
  return Array.isArray(r?.waypoints) ? (r!.waypoints as Waypoint[]) : []
}

export function posOf(o: Obj | undefined): Lla | null {
  const p = o?.position as Obj | undefined
  if (!p || typeof p.lon !== 'number' || typeof p.lat !== 'number') return null
  return { lon: p.lon, lat: p.lat, alt_m: typeof p.alt_m === 'number' ? p.alt_m : 0 }
}

/** 派生的链路对象：站点 × 辐射源，不入场景文件（09 §5.1）。 */
export function derivedLinks(doc: ScenarioDoc | null): Array<{ id: string; site: string; emitter: string }> {
  const out: Array<{ id: string; site: string; emitter: string }> = []
  for (const s of sites(doc)) {
    for (const e of emitters(doc)) {
      out.push({ id: `${String(s.id)}-${String(e.id)}`, site: String(s.id), emitter: String(e.id) })
    }
  }
  return out
}

/**
 * 把链路标识拆回站与源。`link_id = "<site_id>-<emitter_id>"`（geo/src/scenario.cpp），而站与源的 id 本身就含 `-`
 * （`site-1-uav-1`）：按最后一个连字符拆会得到 `site-1-uav` 与 `1`，站查不到，链路线因此从未画出（13 报告 §6.2，D-061）。
 * 这里按文档里已知的站与源精确匹配，不猜分隔位置；对不上返回 null，不拿半截标识顶替（铁律 15）。
 */
export function splitLinkId(doc: ScenarioDoc | null, linkId: string): { site: string; emitter: string } | null {
  for (const l of derivedLinks(doc)) if (l.id === linkId) return { site: l.site, emitter: l.emitter }
  return null
}

/** 圆形告警区（D-061；docs/scenario-format.md §6.1）。只作显示语义，不进物理。 */
export function zones(doc: ScenarioDoc | null): Obj[] {
  return Array.isArray(doc?.zones) ? (doc!.zones as Obj[]) : []
}

/** 布告警区：缺省半径 500 m、类别 alert、不限高；半径与限高在表单里改。 */
export function addZone(doc: ScenarioDoc, lon: number, lat: number): { doc: ScenarioDoc; id: string } {
  const d = clone(doc)
  const list = (d.zones ??= []) as Obj[]
  const id = freshId(new Set(list.map((x) => String(x.id))), 'z')
  list.push({
    id, name: `告警区 ${list.length + 1}`, kind: 'alert', shape: 'circle',
    center: { lon: round6(lon), lat: round6(lat) }, radius_m: 500,
  })
  return { doc: d, id }
}

/** 删告警区：删空了就把键一起去掉，没写过 zones 的文件不会凭空多出一个空数组。 */
export function removeZone(doc: ScenarioDoc, id: string): ScenarioDoc {
  const d = clone(doc)
  const rest = zones(d).filter((z) => z.id !== id)
  if (rest.length) d.zones = rest
  else delete d.zones
  return d
}

export function moveZone(doc: ScenarioDoc, id: string, lon: number, lat: number): ScenarioDoc {
  const d = clone(doc)
  const z = zones(d).find((x) => x.id === id)
  if (z) z.center = { lon: round6(lon), lat: round6(lat) }
  return d
}

/**
 * 目标在哪个告警区里（13 报告 §4.3）：到圆心的水平弦长 ≤ 半径，且（无限高或离地高 ≤ 上限）。
 * 多个命中取文件里的第一个。纯几何，不进引擎与产品。
 */
export function zoneOf(doc: ScenarioDoc | null, lon: number, lat: number, alt_m: number): Obj | null {
  for (const z of zones(doc)) {
    const c = z.center as Obj | undefined
    if (!c || typeof c.lon !== 'number' || typeof c.lat !== 'number' || typeof z.radius_m !== 'number') continue
    const d = chordDistanceM({ lon: c.lon, lat: c.lat, alt_m: 0 }, { lon, lat, alt_m: 0 })
    if (d > z.radius_m) continue
    if (typeof z.alt_max_m === 'number' && alt_m > z.alt_max_m) continue
    return z
  }
  return null
}

/** 生成一个不与现有标识冲突的新标识。 */
function freshId(existing: Set<string>, prefix: string): string {
  for (let i = 1; i < 1000; i++) {
    const id = `${prefix}-${i}`
    if (!existing.has(id)) return id
  }
  return `${prefix}-${Date.now()}`
}

/** 布站：默认参数取 docs/scenario-format.md §3（09 §5.2）。 */
export function addSite(doc: ScenarioDoc, lon: number, lat: number): { doc: ScenarioDoc; id: string } {
  const d = clone(doc)
  const list = (d.sites ??= []) as Obj[]
  const id = freshId(new Set(list.map((x) => String(x.id))), 'site')
  const first = list[0] as Obj | undefined
  const rx = (first?.receiver as Obj | undefined) ?? { fs_Hz: 500000, center_Hz: 2440500000, bw_Hz: 400000, nf_dB: 6 }
  list.push({
    id,
    name: `侦察站 ${list.length + 1}`,
    position: { lon: round6(lon), lat: round6(lat), alt_m: 30 },
    antenna: { gain_dBi: 3, pattern: 'omni' },
    receiver: { ...rx },
  })
  return { doc: d, id }
}

/**
 * 布目标（D-053 §5.3）。照 `addSite` 的模式：新源复制第一个源的 `emission` 作为参数模板，
 * 并建一条**只有一个航点**的航线——静止的目标同样要有航线，否则运行时取不到位置。
 * 新源的中心频率沿用模板，用户随后在表单里改；同频是多源混叠演示要的，不在这里替用户避开。
 */
export function addEmitter(doc: ScenarioDoc, lon: number, lat: number): { doc: ScenarioDoc; id: string } {
  const d = clone(doc)
  const list = (d.emitters ??= []) as Obj[]
  const id = freshId(new Set(list.map((x) => String(x.id))), 'uav')
  const first = list[0] as Obj | undefined
  const em = (first?.emission as Obj | undefined) ?? {
    center_Hz: 2440500000, bw_Hz: 400000, tx_power_dBm: 20, antenna_gain_dBi: 2,
    waveform: { type: 'tone', offset_Hz: 0 },
  }
  const alt = Number((posOf(first)?.alt_m ?? 80))
  list.push({
    id,
    name: `目标 ${list.length + 1}`,
    platform_type: String(first?.platform_type ?? 'multirotor'),
    position: { lon: round6(lon), lat: round6(lat), alt_m: alt },
    emission: clone(em) as Obj,
  })
  const rs = (d.routes ??= []) as Obj[]
  rs.push({ emitter_id: id, waypoints: [{ position: { lon: round6(lon), lat: round6(lat), alt_m: alt }, speed_mps: DEFAULT_SPEED_MPS }] })
  return { doc: d, id }
}

/** 删目标：连同它的航线与活动一起删，留下悬空引用会让场景的跨引用校验失败。 */
export function removeEmitter(doc: ScenarioDoc, id: string): ScenarioDoc {
  const d = clone(doc)
  d.emitters = emitters(d).filter((x) => x.id !== id)
  d.routes = routes(d).filter((r) => r.emitter_id !== id)
  if (Array.isArray(d.activities)) d.activities = activities(d).filter((a) => a.emitter_id !== id)
  return d
}

/** 移动目标：没有航线时改 `position`，有航线时改第一个航点（拖的是它的起点）。 */
export function moveEmitter(doc: ScenarioDoc, id: string, lon: number, lat: number): ScenarioDoc {
  const d = clone(doc)
  const r = routeOf(d, id)
  const wps = Array.isArray(r?.waypoints) ? (r!.waypoints as Obj[]) : []
  if (wps.length) {
    wps[0]!.position = { ...(wps[0]!.position as Obj), lon: round6(lon), lat: round6(lat) }
  }
  const e = emitters(d).find((x) => x.id === id)
  if (e) e.position = { ...(e.position as Obj), lon: round6(lon), lat: round6(lat) }
  return d
}

export function removeSite(doc: ScenarioDoc, id: string): ScenarioDoc {
  const d = clone(doc)
  d.sites = sites(d).filter((x) => x.id !== id)
  return d
}

/** 移动站点或航点：拖动结束时调一次，一次拖动一步撤销（09 §5.2）。 */
export function moveSite(doc: ScenarioDoc, id: string, lon: number, lat: number): ScenarioDoc {
  const d = clone(doc)
  const s = sites(d).find((x) => x.id === id)
  if (s) s.position = { ...(s.position as Obj), lon: round6(lon), lat: round6(lat) }
  return d
}

export function moveWaypoint(doc: ScenarioDoc, emitterId: string, index: number, lon: number, lat: number): ScenarioDoc {
  const d = clone(doc)
  const r = routeOf(d, emitterId)
  const wps = (r?.waypoints as Obj[] | undefined) ?? []
  const w = wps[index]
  if (w) w.position = { ...(w.position as Obj), lon: round6(lon), lat: round6(lat) }
  // 首航点即辐射源初始位置（docs/scenario-format.md §4）
  if (index === 0) {
    const e = emitters(d).find((x) => x.id === emitterId)
    if (e && w) e.position = { ...(w.position as Obj) }
  }
  return d
}

/** 画航点：接在末尾。没有航线就先建一条。 */
export function addWaypoint(doc: ScenarioDoc, emitterId: string, lon: number, lat: number): ScenarioDoc {
  const d = clone(doc)
  let r = routeOf(d, emitterId)
  if (!r) {
    r = { emitter_id: emitterId, loop: false, waypoints: [] }
    ;(d.routes ??= []) as Obj[]
    ;(d.routes as Obj[]).push(r)
  }
  const wps = ((r.waypoints ??= []) as Obj[])
  const prev = wps[wps.length - 1] as Obj | undefined
  const prevPos = posOf(prev)
  const alt = prevPos ? prevPos.alt_m : 100
  wps.push({ position: { lon: round6(lon), lat: round6(lat), alt_m: alt }, speed_mps: speedFrom(prev) })
  if (wps.length === 1) {
    const e = emitters(d).find((x) => x.id === emitterId)
    if (e) e.position = { lon: round6(lon), lat: round6(lat), alt_m: alt }
  }
  return d
}

export function insertWaypoint(doc: ScenarioDoc, emitterId: string, index: number): ScenarioDoc {
  const d = clone(doc)
  const r = routeOf(d, emitterId)
  const wps = (r?.waypoints as Obj[] | undefined) ?? []
  const a = wps[index]
  const b = wps[index + 1] ?? a
  if (!a) return doc
  const pa = posOf(a)!
  const pb = posOf(b)!
  wps.splice(index + 1, 0, {
    position: { lon: round6((pa.lon + pb.lon) / 2), lat: round6((pa.lat + pb.lat) / 2), alt_m: (pa.alt_m + pb.alt_m) / 2 },
    speed_mps: speedFrom(a),
  })
  return d
}

export function removeWaypoint(doc: ScenarioDoc, emitterId: string, index: number): ScenarioDoc {
  const d = clone(doc)
  const r = routeOf(d, emitterId)
  const wps = (r?.waypoints as Obj[] | undefined) ?? []
  if (wps.length <= 1) return doc     // 至少留一个航点（schema minItems: 1）
  wps.splice(index, 1)
  if (index === 0) {
    const e = emitters(d).find((x) => x.id === emitterId)
    const p = posOf(wps[0])
    if (e && p) e.position = { ...p }
  }
  return d
}

/**
 * 按点路径改一个字段，如 `sites.0.receiver.fs_Hz`。
 *
 * 中间的**对象**缺席时按需建出来（D-054）：场景里 `clock` 与 `equipment_model` 这类可选字段
 * 一开始就不存在，不建的话「给这个站配一个站钟」这件事在界面上永远做不成，而且是静默做不成——
 * 用户填了数字、面板没报错、文件里什么也没有（铁律 15）。
 *
 * 只建对象，**不建数组元素**：`sites.7.xxx` 在只有三个站时仍原样返回。凭一个下标去补一个空站
 * 会造出没有 id 的半个对象，引擎那边直接是「缺必填字段」，报错还指不到真正的原因。
 */
export function setPath(doc: ScenarioDoc, path: string, value: unknown): ScenarioDoc {
  const d = clone(doc)
  const parts = path.split('.')
  let cur: unknown = d
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return doc
    const holder = cur as Obj
    const key = parts[i]
    const next = holder[key]
    if (next === undefined || next === null) {
      // 下一段是数字下标说明这里该是数组，而数组元素不凭空造（见上）
      if (/^\d+$/.test(parts[i + 1] ?? '')) return doc
      if (Array.isArray(holder)) return doc
      holder[key] = {}
    }
    cur = holder[key]
  }
  if (cur === null || typeof cur !== 'object') return doc
  const last = parts[parts.length - 1]!
  // `undefined` 表示「清掉这个可选字段」。写 undefined 进去虽然 JSON.stringify 会丢掉它，
  // 但内存里的文档就留了一个值为 undefined 的键，读回来分不清「没设过」与「设成了空」。
  if (value === undefined) delete (cur as Obj)[last]
  else (cur as Obj)[last] = value
  return d
}

export function addActivity(doc: ScenarioDoc, emitterId: string, t_s: number, event: string,
                            args?: Obj): ScenarioDoc {
  const d = clone(doc)
  const list = ((d.activities ??= []) as Obj[])
  // 只有 hop 带 args（G-6，D-069）。其余事件不写这个键，既有场景文件的形状因此不变。
  list.push(args === undefined ? { emitter_id: emitterId, t_s, event }
                               : { emitter_id: emitterId, t_s, event, args })
  // 活动必须按时刻非降（docs/scenario-format.md §6），这里排好，免得交给引擎才发现
  list.sort((a, b) => Number(a.t_s) - Number(b.t_s))
  return d
}

/**
 * 改跳频活动的序列与停留时长（G-6，D-069）。序列用逗号分隔的 MHz 文本，空串即不改。
 * 写回的是 Hz 整数：场景文件里的频点一律是 Hz（docs/scenario-format.md §6）。
 */
export function setHopArgs(doc: ScenarioDoc, index: number,
                           seqMHz: string | undefined, dwell_s: number | undefined): ScenarioDoc {
  const d = clone(doc)
  const list = activities(d)
  const a = list[index]
  if (!a || String(a.event) !== 'hop') return doc
  const args = { ...((a.args ?? {}) as Obj) }
  if (seqMHz !== undefined) {
    const seq = seqMHz.split(/[,，\s]+/).map((t) => Number(t)).filter((v) => Number.isFinite(v) && v > 0)
    if (seq.length) {
      args.sequence = seq.map((mhz) => Math.round(mhz * 1e6))
      delete args.center_Hz          // 序列与单值互斥（geo::Scenario::cross_check 会拒同时给）
    }
  }
  if (dwell_s !== undefined && Number.isFinite(dwell_s) && dwell_s > 0) args.dwell_s = dwell_s
  a.args = args
  d.activities = list
  return d
}

/** 跳频序列的显示形式：MHz、逗号分隔。非 hop 或没有序列时给空串。 */
export function hopSequenceMHz(a: Obj | undefined): string {
  const args = (a?.args ?? {}) as Obj
  const seq = Array.isArray(args.sequence) ? (args.sequence as number[]) : []
  if (!seq.length && typeof args.center_Hz === 'number') return String(args.center_Hz / 1e6)
  return seq.map((f) => String(f / 1e6)).join(', ')
}

export function removeActivity(doc: ScenarioDoc, index: number): ScenarioDoc {
  const d = clone(doc)
  const list = activities(d)
  if (index < 0 || index >= list.length) return doc
  list.splice(index, 1)
  d.activities = list
  return d
}

/** 经纬度存六位小数（约 0.1 米，09 §5.3）：避免拖动产生一长串无意义的尾数。 */
export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}
