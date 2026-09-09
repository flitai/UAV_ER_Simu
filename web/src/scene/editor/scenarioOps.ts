// 场景文档的编辑操作（06 备忘录 §9C G-4）。
//
// 全是纯函数：拿一份场景文档，返回改过的新文档，不改入参。理由是撤销栈存的就是整份文档
// （web/src/state/reducer.ts 的 scene/edit），纯函数让「一次操作一步撤销」自然成立。
//
// 这里只做结构编辑，不做校验——校验分两层：schema 由服务端与引擎守，语义由 cuav_run
// --scenario-track 守（D-042）。前端只在表单上做范围提示，不复刻规则。

import type { ScenarioDoc } from '../../state/types.js'
import type { Lla, Waypoint } from './preview.js'

export type Obj = Record<string, unknown>

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
  rs.push({ emitter_id: id, waypoints: [{ position: { lon: round6(lon), lat: round6(lat), alt_m: alt }, speed_mps: 0 }] })
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
  const speed = typeof prev?.speed_mps === 'number' ? prev.speed_mps : 15
  wps.push({ position: { lon: round6(lon), lat: round6(lat), alt_m: alt }, speed_mps: speed })
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
    speed_mps: typeof a.speed_mps === 'number' ? a.speed_mps : 15,
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

export function addActivity(doc: ScenarioDoc, emitterId: string, t_s: number, event: string): ScenarioDoc {
  const d = clone(doc)
  const list = ((d.activities ??= []) as Obj[])
  list.push({ emitter_id: emitterId, t_s, event })
  // 活动必须按时刻非降（docs/scenario-format.md §6），这里排好，免得交给引擎才发现
  list.sort((a, b) => Number(a.t_s) - Number(b.t_s))
  return d
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
