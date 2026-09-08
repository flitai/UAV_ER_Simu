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

/** 一条航迹最多留这么多顶点：20 km 观测区域上够画满全程，再多也看不出差别。 */
const TRAIL_MAX = 4000

interface SceneState {
  /** 每个实体的最新状态 */
  entities: Map<string, EntitySample>
  /** 每条链路的最新读数 */
  links: Map<string, LinkSample>
  /** 抽稀后的航迹 */
  trails: Map<string, Array<[number, number]>>
  /** 已收到的最大 t_s，状态条与游标用 */
  lastT: number
  /** 版本号：地图按它判断要不要重画，避免每帧都拼一遍 GeoJSON */
  rev: number
}

function empty(): SceneState {
  return { entities: new Map(), links: new Map(), trails: new Map(), lastT: 0, rev: 0 }
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
    if (l.t_s > state.lastT) state.lastT = l.t_s
    notify()
  },
  /** 回看：整批替换。航迹按给定的样点重建，不做增量抽稀之外的处理。 */
  replaceFromTrack(samples: EntitySample[], links: LinkSample[]) {
    state = empty()
    for (const e of samples) {
      state.entities.set(e.id, e)
      if (e.t_s > state.lastT) state.lastT = e.t_s
      let tr = state.trails.get(e.id)
      if (!tr) {
        tr = []
        state.trails.set(e.id, tr)
      }
      const last = tr[tr.length - 1]
      if (!last || Math.abs(last[0] - e.lon) + Math.abs(last[1] - e.lat) >= TRAIL_MIN_STEP_DEG) tr.push([e.lon, e.lat])
    }
    for (const l of links) state.links.set(l.link_id, l)
    notify()
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

/** 探针快照（09 §10）：把当前实体与链路摊平成数组，供 e2e 与黄金航迹对拍。 */
export function situationSnapshot(): {
  entities: Array<{ id: string; t_s: number; lon: number; lat: number; alt_m: number; heading_deg: number; speed_mps: number; tx_on: boolean }>
  links: Array<{ id: string; t_s: number; los: boolean; distance_m: number; pathLoss_dB: number; doppler_Hz: number }>
} {
  const entities: Array<{ id: string; t_s: number; lon: number; lat: number; alt_m: number; heading_deg: number; speed_mps: number; tx_on: boolean }> = []
  state.entities.forEach((e) => {
    entities.push({ id: e.id, t_s: e.t_s, lon: e.lon, lat: e.lat, alt_m: e.alt_m, heading_deg: e.heading_deg, speed_mps: e.speed_mps, tx_on: e.tx_on })
  })
  const links: Array<{ id: string; t_s: number; los: boolean; distance_m: number; pathLoss_dB: number; doppler_Hz: number }> = []
  state.links.forEach((l) => {
    links.push({ id: l.link_id, t_s: l.t_s, los: l.line_of_sight, distance_m: l.distance_m, pathLoss_dB: l.path_loss_dB, doppler_Hz: l.doppler_Hz })
  })
  entities.sort((a, b) => (a.id < b.id ? -1 : 1))
  links.sort((a, b) => (a.id < b.id ? -1 : 1))
  return { entities, links }
}
