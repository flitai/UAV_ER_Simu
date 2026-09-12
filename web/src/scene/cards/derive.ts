// 目标卡与站点卡的派生读数（13 报告 §3，D-061）。
//
// 纯函数：拿场景文档 + 态势快照，出卡片数据；不碰 React、不碰地图。理由与 scenarioOps 相同——
// 探针要用同一份数据（e2e 断言卡上的数与端点行逐值相等），组件与探针各算一遍必然分叉。
//
// 数据来源（13 §3.1）：身份与配置来自场景文档；运动来自实体样点；每站一行来自链路帧（按
// `derivedLinks` 的标识精确匹配，不拆字符串）；测向来自测向报告；定位来自定位解。
// 接收电平与信噪比不在任何产品行里，按链路帧当场算，与引擎 `locate.cpp:255-257` 同式（13 §3.2）：
//   P_rx = P_tx + G_t + G_r − L；N = −174 + nf + 10·log10(fs)；SNR = P_rx − N。
// `path_loss_dB` 是纯传播损耗（D-049 ⑤），所以这三个数是链路读数，不是任何观测点的实测值。
// 缺什么就给 null，不拿默认值顶替（铁律 15）。

import type { ScenarioDoc } from '../../state/types.js'
import type { BearingSample, EntitySample, LinkSample, PositionSample } from '../sceneStore.js'
import { derivedLinks, emitters, posOf, sites, type Obj } from '../editor/scenarioOps.js'
import { lookAngles } from '../editor/preview.js'

/** 态势快照里卡片用到的四张表（与 sceneStore 的状态同形，测试可以直接造）。 */
export interface SituationLike {
  entities: Map<string, EntitySample>
  links: Map<string, LinkSample>
  bearings: Map<string, BearingSample>
  positions: Map<string, PositionSample>
}

/** 接收电平（dBm）：发射功率 + 两端天线增益 − 纯传播损耗。 */
export function rxPowerDbm(txPower_dBm: number, txGain_dBi: number, rxGain_dBi: number, pathLoss_dB: number): number {
  return txPower_dBm + txGain_dBi + rxGain_dBi - pathLoss_dB
}

/** 带内噪声功率（dBm）：热噪声 −174 dBm/Hz + 噪声系数 + 带宽积分。带宽取站的采样率，与引擎一致。 */
export function noisePowerDbm(nf_dB: number, bandwidth_Hz: number): number {
  return -174 + nf_dB + 10 * Math.log10(bandwidth_Hz)
}

/** 地面距离：斜距在水平面上的投影。 */
export function groundDistanceM(distance_m: number, elevation_deg: number): number {
  return distance_m * Math.cos((elevation_deg * Math.PI) / 180)
}

export interface BearingRow {
  bearing_deg: number
  sigma_deg: number
  df_quality: string
  state: string
  use_policy: string
  mixture: boolean
}

export interface SiteRow {
  site_id: string
  site_name: string
  /** link = 引擎链路帧；preview = 浏览器几何（未运行，只有距离与角度）；none = 站或目标位置缺 */
  source: 'link' | 'preview' | 'none'
  distance_m: number | null
  ground_m: number | null
  azimuth_deg: number | null
  elevation_deg: number | null
  path_loss_dB: number | null
  line_of_sight: boolean | null
  link_state: string | null
  rx_dBm: number | null
  snr_dB: number | null
  bearing: BearingRow | null
}

export interface FixRow {
  method: string
  lon: number
  lat: number
  cep_m: number
  gdop: number
  geometry_quality: string
  time_quality: string | null
  min_crossing_angle_deg: number
  sites: string[]
  state: string
}

export interface MotionRow {
  lon: number
  lat: number
  alt_m: number
  heading_deg: number | null
  speed_mps: number | null
  tx_on: boolean | null
  center_Hz: number | null
  /** entity = 实体样点（运行中或回放）；scenario = 场景文件里的初始位置（未运行） */
  source: 'entity' | 'scenario'
}

export interface TargetCardData {
  id: string
  name: string
  platform_type: string
  equipment_model: string | null
  center_Hz: number | null
  bw_Hz: number | null
  tx_power_dBm: number | null
  tx_gain_dBi: number | null
  polarization: string | null
  motion: MotionRow | null
  sites: SiteRow[]
  fixes: FixRow[]
  nearest_m: number | null
  /** 所在告警区（V-2 起填；本期恒 null） */
  inZone: string | null
}

export interface SiteCardData {
  id: string
  name: string
  equipment_model: string | null
  fs_Hz: number | null
  center_Hz: number | null
  bw_Hz: number | null
  nf_dB: number | null
  gain_dBi: number | null
  sync_state: string | null
  links: number
  qualities: Array<{ emitter_id: string; df_quality: string | null }>
  worst_quality: string | null
}

function num(o: Obj | undefined, k: string): number | null {
  const v = o?.[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(o: Obj | undefined, k: string): string | null {
  const v = o?.[k]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function obj(o: Obj | undefined, k: string): Obj | undefined {
  const v = o?.[k]
  return v && typeof v === 'object' ? (v as Obj) : undefined
}

/** 测向质量档的坏度：DF-Q1 最好、invalid 最坏；认不出的排在 invalid 前面。 */
const QUALITY_RANK: Record<string, number> = { 'DF-Q1': 1, 'DF-Q2': 2, 'DF-Q3': 3, 'DF-Q4': 4, invalid: 9 }
export function qualityRank(q: string | null): number {
  if (q === null) return 0
  return QUALITY_RANK[q] ?? 8
}

/** 每个辐射源一张卡，顺序同场景文件。 */
export function buildTargetCards(doc: ScenarioDoc | null, sit: SituationLike): TargetCardData[] {
  const siteList = sites(doc)
  const linkIds = derivedLinks(doc)
  const out: TargetCardData[] = []
  for (const e of emitters(doc)) {
    const id = String(e.id)
    const em = obj(e, 'emission')
    const ent = sit.entities.get(id)
    const docPos = posOf(e)
    const motion: MotionRow | null = ent
      ? { lon: ent.lon, lat: ent.lat, alt_m: ent.alt_m, heading_deg: ent.heading_deg, speed_mps: ent.speed_mps,
          tx_on: ent.tx_on, center_Hz: ent.center_Hz, source: 'entity' }
      : docPos
        ? { lon: docPos.lon, lat: docPos.lat, alt_m: docPos.alt_m, heading_deg: null, speed_mps: null, tx_on: null,
            center_Hz: null, source: 'scenario' }
        : null
    const txPower = num(em, 'tx_power_dBm')
    const txGain = num(em, 'antenna_gain_dBi')

    const rows: SiteRow[] = []
    for (const s of siteList) {
      const sid = String(s.id)
      const linkId = linkIds.find((l) => l.site === sid && l.emitter === id)?.id ?? `${sid}-${id}`
      const link = sit.links.get(linkId) ?? null
      const b = sit.bearings.get(linkId) ?? null
      const rxGain = num(obj(s, 'antenna'), 'gain_dBi')
      const rcv = obj(s, 'receiver')
      const nf = num(rcv, 'nf_dB')
      const fs = num(rcv, 'fs_Hz')
      const row: SiteRow = {
        site_id: sid, site_name: str(s, 'name') ?? sid, source: 'none',
        distance_m: null, ground_m: null, azimuth_deg: null, elevation_deg: null,
        path_loss_dB: null, line_of_sight: null, link_state: null, rx_dBm: null, snr_dB: null,
        bearing: b
          ? { bearing_deg: b.bearing_deg, sigma_deg: b.bearing_std_deg, df_quality: b.df_quality,
              state: b.df_result_state, use_policy: b.use_policy, mixture: b.mixture }
          : null,
      }
      if (link) {
        row.source = 'link'
        row.distance_m = link.distance_m
        row.ground_m = groundDistanceM(link.distance_m, link.elevation_deg)
        row.azimuth_deg = link.azimuth_deg
        row.elevation_deg = link.elevation_deg
        row.path_loss_dB = link.path_loss_dB
        row.line_of_sight = link.line_of_sight
        row.link_state = link.state
        if (txPower !== null && txGain !== null && rxGain !== null) {
          row.rx_dBm = rxPowerDbm(txPower, txGain, rxGain, link.path_loss_dB)
          if (nf !== null && fs !== null && fs > 0) row.snr_dB = row.rx_dBm - noisePowerDbm(nf, fs)
        }
      } else {
        const sp = posOf(s)
        const tp = motion ? { lon: motion.lon, lat: motion.lat, alt_m: motion.alt_m } : null
        if (sp && tp) {
          const g = lookAngles(sp, tp)
          row.source = 'preview'
          row.distance_m = g.distance_m
          row.ground_m = groundDistanceM(g.distance_m, g.elevation_deg)
          row.azimuth_deg = g.azimuth_deg
          row.elevation_deg = g.elevation_deg
        }
      }
      rows.push(row)
    }

    const fixes: FixRow[] = []
    sit.positions.forEach((p) => {
      if (p.emitter_id !== id) return
      fixes.push({ method: p.method, lon: p.lon, lat: p.lat, cep_m: p.cep_m, gdop: p.gdop,
                   geometry_quality: p.geometry_quality, time_quality: p.time_quality,
                   min_crossing_angle_deg: p.min_crossing_angle_deg, sites: p.participating_sites, state: p.state })
    })
    fixes.sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0))

    let nearest: number | null = null
    for (const r of rows) if (r.distance_m !== null && (nearest === null || r.distance_m < nearest)) nearest = r.distance_m

    out.push({
      id, name: str(e, 'name') ?? id, platform_type: str(e, 'platform_type') ?? 'multirotor',
      equipment_model: str(e, 'equipment_model'),
      center_Hz: num(em, 'center_Hz'), bw_Hz: num(em, 'bw_Hz'), tx_power_dBm: txPower, tx_gain_dBi: txGain,
      polarization: str(em, 'polarization'),
      motion, sites: rows, fixes, nearest_m: nearest, inZone: null,
    })
  }
  return out
}

/** 每个站一张卡，顺序同场景文件。 */
export function buildSiteCards(doc: ScenarioDoc | null, sit: SituationLike): SiteCardData[] {
  const emList = emitters(doc)
  const linkIds = derivedLinks(doc)
  const out: SiteCardData[] = []
  for (const s of sites(doc)) {
    const id = String(s.id)
    const rcv = obj(s, 'receiver')
    const qualities: Array<{ emitter_id: string; df_quality: string | null }> = []
    let worst: string | null = null
    for (const e of emList) {
      const eid = String(e.id)
      const linkId = linkIds.find((l) => l.site === id && l.emitter === eid)?.id ?? `${id}-${eid}`
      const b = sit.bearings.get(linkId)
      const q = b ? b.df_quality : null
      qualities.push({ emitter_id: eid, df_quality: q })
      if (q !== null && qualityRank(q) > qualityRank(worst)) worst = q
    }
    out.push({
      id, name: str(s, 'name') ?? id, equipment_model: str(s, 'equipment_model'),
      fs_Hz: num(rcv, 'fs_Hz'), center_Hz: num(rcv, 'center_Hz'), bw_Hz: num(rcv, 'bw_Hz'), nf_dB: num(rcv, 'nf_dB'),
      gain_dBi: num(obj(s, 'antenna'), 'gain_dBi'),
      sync_state: str(obj(s, 'clock'), 'sync_state'),
      links: emList.length, qualities, worst_quality: worst,
    })
  }
  return out
}

/** 探针形状（13 §3.4）：逐项挑，不整包展开。 */
export function probeCards(cards: TargetCardData[]) {
  return cards.map((c) => ({
    id: c.id,
    platform_type: c.platform_type,
    inZone: c.inZone,
    motionSource: c.motion?.source ?? null,
    nearest_m: c.nearest_m,
    sites: c.sites.map((r) => ({
      site_id: r.site_id, source: r.source, distance_m: r.distance_m, azimuth_deg: r.azimuth_deg,
      path_loss_dB: r.path_loss_dB, rx_dBm: r.rx_dBm, snr_dB: r.snr_dB,
      bearing_deg: r.bearing?.bearing_deg ?? null, sigma_deg: r.bearing?.sigma_deg ?? null,
      df_quality: r.bearing?.df_quality ?? null,
    })),
    fixes: c.fixes.map((f) => ({ method: f.method, cep_m: f.cep_m })),
  }))
}

export function probeSiteCards(cards: SiteCardData[]) {
  return cards.map((c) => ({ id: c.id, links: c.links, worst_quality: c.worst_quality, sync_state: c.sync_state }))
}
