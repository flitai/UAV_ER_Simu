// 态势数据的外部小 store（09 附录 A.2 的高频量范式，与 shell/cursorStore 同法）。
//
// 为什么不进主 store：参数帧按 10–100 Hz 出，一次运行有几千条 entity / link 事件。
// 主 store 的 reducer 每条都要走一遍不可变更新并触发整棵界面树重渲染，
// U-3 已经踩过「一帧折叠 2447 条事件 = 84 ms 长任务」。这里只做累积，地图按 20 Hz 定频取值画。
//
// 主 store 里留低频摘要（对象树的实体清单、当前选中链路的读数），逐帧位置只在这里。

import { TRAIL_MIN_STEP_DEG } from './style/situation.js'

export interface EntitySample {
  t_s: number
  id: string
  lon: number
  lat: number
  alt_m: number
  heading_deg: number
  speed_mps: number
  tx_on: boolean
  center_Hz: number
}

export interface LinkSample {
  t_s: number
  link_id: string
  line_of_sight: boolean
  distance_m: number
  azimuth_deg: number
  elevation_deg: number
  path_loss_dB: number
  delay_s: number
  doppler_Hz: number
  valid_from_s: number
  valid_to_s: number
  update_rate_Hz: number
  state: string
}

/** 一条测向报告（D-053）。只留画图与读数要用的字段，六个 σ 分量不进这里——
 *  它们是模型卡与评价页的事，地图上用不到，逐帧存 K×N 份没必要。 */
export interface BearingSample {
  t_s: number
  site_id: string
  emitter_id: string
  link_id: string
  bearing_deg: number
  bearing_std_deg: number
  snr_dB: number
  level_dBm: number
  df_quality: string
  df_result_state: string
  use_policy: string
  mixture: boolean
}

/** 一个定位解（D-053）。椭圆按 2σ 存，二维包含概率 86.5%——不是一维的 95%。 */
export interface PositionSample {
  t_s: number
  emitter_id: string
  method: string
  lon: number
  lat: number
  semi_major_m: number
  semi_minor_m: number
  rotation_deg: number
  cep_m: number
  gdop: number
  /** 最小两两交会角（度）。它比 `geometry_quality` 更能说明交汇好不好——
   *  后者按最大张角分级，看不见「两条近乎平行的线 + 一条好线」（D-053 §11.3）。 */
  min_crossing_angle_deg: number
  geometry_quality: string
  time_quality: string | null
  participating_sites: string[]
  state: string
}

/** 一条航迹最多留这么多顶点：20 km 观测区域上够画满全程，再多也看不出差别。 */
const TRAIL_MAX = 4000

/** 每键一条按 t_s 非降的历史（回放用，D-061）。 */
interface History {
  entities: Map<string, EntitySample[]>
  links: Map<string, LinkSample[]>
  bearings: Map<string, BearingSample[]>
  positions: Map<string, PositionSample[]>
}

/** 每键最多留这么多样点：100 Hz × 20 分钟；再长的任务本期没有 */
const HISTORY_MAX = 120000

export interface SituationSnapshot {
  entities: Map<string, EntitySample>
  links: Map<string, LinkSample>
  bearings: Map<string, BearingSample>
  positions: Map<string, PositionSample>
  trails: Map<string, Array<[number, number]>>
}

interface SceneState {
  /** 按时间索引的历史，回放时按 t 取（13 报告 §5.3） */
  history: History
  /** 每个实体的最新状态 */
  entities: Map<string, EntitySample>
  /** 每条链路的最新读数 */
  links: Map<string, LinkSample>
  /** 抽稀后的航迹 */
  trails: Map<string, Array<[number, number]>>
  /** 每条链路的最新测向报告，键 link_id */
  bearings: Map<string, BearingSample>
  /** 每个目标每种方法的最新定位解，键 `<emitter_id>:<method>` */
  positions: Map<string, PositionSample>
  /** 已收到的最大 t_s，状态条与游标用 */
  lastT: number
  /** 版本号：地图按它判断要不要重画，避免每帧都拼一遍 GeoJSON */
  rev: number
}

function empty(): SceneState {
  return { history: { entities: new Map(), links: new Map(), bearings: new Map(), positions: new Map() },
           entities: new Map(), links: new Map(), trails: new Map(),
           bearings: new Map(), positions: new Map(), lastT: 0, rev: 0 }
}

/** 追加进历史：几乎总是按时间顺序到达，乱序的插到正确位置，超长丢最旧的。 */
function pushHistory<T extends { t_s: number }>(m: Map<string, T[]>, key: string, x: T): void {
  let arr = m.get(key)
  if (!arr) {
    arr = []
    m.set(key, arr)
  }
  const last = arr[arr.length - 1]
  if (!last || x.t_s >= last.t_s) arr.push(x)
  else {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid]!.t_s <= x.t_s) lo = mid + 1
      else hi = mid
    }
    arr.splice(lo, 0, x)
  }
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX)
}

/** 最后一条 t_s ≤ t 的样点；没有则 null。 */
function lastAtOrBefore<T extends { t_s: number }>(arr: T[], t: number): T | null {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]!.t_s <= t) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? arr[lo - 1]! : null
}

/** 航迹抽稀，与实时 push 同一规则。 */
function thinTrail(samples: EntitySample[], upto: number): Array<[number, number]> {
  const tr: Array<[number, number]> = []
  for (const e of samples) {
    if (e.t_s > upto) break
    const last = tr[tr.length - 1]
    if (!last || Math.abs(last[0] - e.lon) + Math.abs(last[1] - e.lat) >= TRAIL_MIN_STEP_DEG) tr.push([e.lon, e.lat])
  }
  if (tr.length > TRAIL_MAX) tr.splice(0, tr.length - TRAIL_MAX)
  return tr
}

let state = empty()
const subs = new Set<() => void>()

function notify(): void {
  state.rev++
  for (const f of subs) f()
}

export const sceneStore = {
  get: () => state,
  subscribe(f: () => void) {
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  },
  /** 换任务、换场景、开始回看之前调一次。 */
  reset() {
    state = empty()
    notify()
  },
  pushEntity(e: EntitySample) {
    state.entities.set(e.id, e)
    pushHistory(state.history.entities, e.id, e)
    if (e.t_s > state.lastT) state.lastT = e.t_s
    let tr = state.trails.get(e.id)
    if (!tr) {
      tr = []
      state.trails.set(e.id, tr)
    }
    const last = tr[tr.length - 1]
    // 抽稀：位移小于阈值就不新增顶点（docs/display-route.md 第 3 节）
    if (!last || Math.abs(last[0] - e.lon) + Math.abs(last[1] - e.lat) >= TRAIL_MIN_STEP_DEG) {
      tr.push([e.lon, e.lat])
      if (tr.length > TRAIL_MAX) tr.splice(0, tr.length - TRAIL_MAX)
    }
    notify()
  },
  pushLink(l: LinkSample) {
    state.links.set(l.link_id, l)
    pushHistory(state.history.links, l.link_id, l)
    if (l.t_s > state.lastT) state.lastT = l.t_s
    notify()
  },
  pushBearing(b: BearingSample) {
    state.bearings.set(b.link_id, b)
    pushHistory(state.history.bearings, b.link_id, b)
    if (b.t_s > state.lastT) state.lastT = b.t_s
    notify()
  },
  pushPosition(p: PositionSample) {
    state.positions.set(`${p.emitter_id}:${p.method}`, p)
    pushHistory(state.history.positions, `${p.emitter_id}:${p.method}`, p)
    if (p.t_s > state.lastT) state.lastT = p.t_s
    notify()
  },
  /** 回看：整批替换。航迹按给定的样点重建，不做增量抽稀之外的处理。 */
  replaceFromTrack(samples: EntitySample[], links: LinkSample[]) {
    state = empty()
    for (const e of samples) {
      state.entities.set(e.id, e)
      pushHistory(state.history.entities, e.id, e)
      if (e.t_s > state.lastT) state.lastT = e.t_s
      let tr = state.trails.get(e.id)
      if (!tr) {
        tr = []
        state.trails.set(e.id, tr)
      }
      const last = tr[tr.length - 1]
      if (!last || Math.abs(last[0] - e.lon) + Math.abs(last[1] - e.lat) >= TRAIL_MIN_STEP_DEG) tr.push([e.lon, e.lat])
    }
    for (const l of links) {
      state.links.set(l.link_id, l)
      pushHistory(state.history.links, l.link_id, l)
    }
    notify()
  },
  /** 回看：整批灌入测向与定位（每条曲线只留最后一条，与实时同语义）。 */
  replaceFromReports(bearings: BearingSample[], positions: PositionSample[]) {
    for (const b of bearings) {
      state.bearings.set(b.link_id, b)
      pushHistory(state.history.bearings, b.link_id, b)
      if (b.t_s > state.lastT) state.lastT = b.t_s
    }
    for (const p of positions) {
      state.positions.set(`${p.emitter_id}:${p.method}`, p)
      pushHistory(state.history.positions, `${p.emitter_id}:${p.method}`, p)
      if (p.t_s > state.lastT) state.lastT = p.t_s
    }
    notify()
  },
  /** 有没有可回放的历史（任何一个实体样点即算有）。 */
  hasHistory(): boolean {
    return state.history.entities.size > 0
  },
  /**
   * 按时刻取快照（13 报告 §5.3）：每键最后一条 t_s ≤ t 的样点；航迹只画到 t。
   * 纯读、不改状态，同一 t 多次调用结果相同。
   */
  snapshotAt(t: number): SituationSnapshot {
    const entities = new Map<string, EntitySample>()
    const trails = new Map<string, Array<[number, number]>>()
    state.history.entities.forEach((arr, id) => {
      const e = lastAtOrBefore(arr, t)
      if (e) {
        entities.set(id, e)
        trails.set(id, thinTrail(arr, t))
      }
    })
    const links = new Map<string, LinkSample>()
    state.history.links.forEach((arr, id) => { const x = lastAtOrBefore(arr, t); if (x) links.set(id, x) })
    const bearings = new Map<string, BearingSample>()
    state.history.bearings.forEach((arr, id) => { const x = lastAtOrBefore(arr, t); if (x) bearings.set(id, x) })
    const positions = new Map<string, PositionSample>()
    state.history.positions.forEach((arr, id) => { const x = lastAtOrBefore(arr, t); if (x) positions.set(id, x) })
    return { entities, links, bearings, positions, trails }
  },
}

/** 从 WS 事件的 payload 取实体样点。字段不全即返回 null，不拿默认值顶替（铁律 15）。 */
export function entityFromPayload(t_s: number, p: Record<string, unknown>): EntitySample | null {
  if (typeof p.id !== 'string' || typeof p.lon !== 'number' || typeof p.lat !== 'number') return null
  return {
    t_s,
    id: p.id,
    lon: p.lon,
    lat: p.lat,
    alt_m: typeof p.alt_m === 'number' ? p.alt_m : 0,
    heading_deg: typeof p.heading_deg === 'number' ? p.heading_deg : 0,
    speed_mps: typeof p.speed_mps === 'number' ? p.speed_mps : 0,
    tx_on: p.tx_on !== false,
    center_Hz: typeof p.center_Hz === 'number' ? p.center_Hz : 0,
  }
}

export function linkFromPayload(t_s: number, p: Record<string, unknown>): LinkSample | null {
  if (typeof p.link_id !== 'string') return null
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0)
  return {
    t_s,
    link_id: p.link_id,
    line_of_sight: p.line_of_sight !== false,
    distance_m: num('distance_m'),
    azimuth_deg: num('azimuth_deg'),
    elevation_deg: num('elevation_deg'),
    path_loss_dB: num('path_loss_dB'),
    delay_s: num('delay_s'),
    doppler_Hz: num('doppler_Hz'),
    valid_from_s: num('valid_from_s'),
    valid_to_s: num('valid_to_s'),
    update_rate_Hz: num('update_rate_Hz'),
    state: typeof p.state === 'string' ? p.state : 'valid',
  }
}

/** 从 WS 事件的 payload 取一条测向报告。关键字段缺失即返回 null（铁律 15）。 */
export function bearingFromPayload(t_s: number, p: Record<string, unknown>): BearingSample | null {
  if (typeof p.link_id !== 'string' || typeof p.bearing_deg !== 'number') return null
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0)
  const str = (k: string, d = '') => (typeof p[k] === 'string' ? (p[k] as string) : d)
  return {
    t_s,
    site_id: str('site_id'),
    emitter_id: str('emitter_id'),
    link_id: p.link_id,
    bearing_deg: p.bearing_deg,
    bearing_std_deg: num('bearing_std_deg'),
    snr_dB: num('snr_dB'),
    level_dBm: num('level_dBm'),
    df_quality: str('df_quality', 'invalid'),
    df_result_state: str('df_result_state', 'invalid'),
    use_policy: str('use_policy', 'exclude'),
    mixture: p.mixture === true,
  }
}

/** 从 WS 事件的 payload 取一个定位解。 */
export function positionFromPayload(t_s: number, p: Record<string, unknown>): PositionSample | null {
  if (typeof p.emitter_id !== 'string' || typeof p.lon !== 'number' || typeof p.lat !== 'number') return null
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0)
  const el = (p.ellipse ?? {}) as Record<string, unknown>
  const eln = (k: string) => (typeof el[k] === 'number' ? (el[k] as number) : 0)
  const sites = Array.isArray(p.participating_sites)
    ? (p.participating_sites as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  return {
    t_s,
    emitter_id: p.emitter_id,
    method: typeof p.method === 'string' ? p.method : 'aoa',
    lon: p.lon,
    lat: p.lat,
    semi_major_m: eln('semi_major_m'),
    semi_minor_m: eln('semi_minor_m'),
    rotation_deg: eln('rotation_deg'),
    cep_m: num('cep_m'),
    gdop: num('gdop'),
    min_crossing_angle_deg: num('min_crossing_angle_deg'),
    geometry_quality: typeof p.geometry_quality === 'string' ? p.geometry_quality : 'degenerate',
    time_quality: typeof p.time_quality === 'string' ? p.time_quality : null,
    participating_sites: sites,
    state: typeof p.state === 'string' ? p.state : 'valid',
  }
}

/** 探针快照（09 §10）：把当前实体与链路摊平成数组，供 e2e 与黄金航迹对拍。不传则取 live 状态。 */
export function situationSnapshot(sit?: SituationSnapshot): {
  entities: Array<{ id: string; t_s: number; lon: number; lat: number; alt_m: number; heading_deg: number; speed_mps: number; tx_on: boolean }>
  links: Array<{ id: string; t_s: number; los: boolean; distance_m: number; pathLoss_dB: number; doppler_Hz: number }>
  bearings: Array<{ id: string; t_s: number; bearing_deg: number; sigma_deg: number; quality: string; state: string; mixture: boolean }>
  positions: Array<{ id: string; t_s: number; method: string; lon: number; lat: number; cep_m: number; crossing_deg: number; sites: number }>
} {
  const src = sit ?? state
  const entities: Array<{ id: string; t_s: number; lon: number; lat: number; alt_m: number; heading_deg: number; speed_mps: number; tx_on: boolean }> = []
  src.entities.forEach((e) => {
    entities.push({ id: e.id, t_s: e.t_s, lon: e.lon, lat: e.lat, alt_m: e.alt_m, heading_deg: e.heading_deg, speed_mps: e.speed_mps, tx_on: e.tx_on })
  })
  const links: Array<{ id: string; t_s: number; los: boolean; distance_m: number; pathLoss_dB: number; doppler_Hz: number }> = []
  src.links.forEach((l) => {
    links.push({ id: l.link_id, t_s: l.t_s, los: l.line_of_sight, distance_m: l.distance_m, pathLoss_dB: l.path_loss_dB, doppler_Hz: l.doppler_Hz })
  })
  const bearings: Array<{ id: string; t_s: number; bearing_deg: number; sigma_deg: number; quality: string; state: string; mixture: boolean }> = []
  src.bearings.forEach((b) => {
    bearings.push({ id: b.link_id, t_s: b.t_s, bearing_deg: b.bearing_deg, sigma_deg: b.bearing_std_deg,
                    quality: b.df_quality, state: b.df_result_state, mixture: b.mixture })
  })
  const positions: Array<{ id: string; t_s: number; method: string; lon: number; lat: number; cep_m: number; crossing_deg: number; sites: number }> = []
  src.positions.forEach((p, k) => {
    positions.push({ id: k, t_s: p.t_s, method: p.method, lon: p.lon, lat: p.lat,
                     cep_m: p.cep_m, crossing_deg: p.min_crossing_angle_deg,
                     sites: p.participating_sites.length })
  })
  entities.sort((a, b) => (a.id < b.id ? -1 : 1))
  links.sort((a, b) => (a.id < b.id ? -1 : 1))
  bearings.sort((a, b) => (a.id < b.id ? -1 : 1))
  positions.sort((a, b) => (a.id < b.id ? -1 : 1))
  return { entities, links, bearings, positions }
}
