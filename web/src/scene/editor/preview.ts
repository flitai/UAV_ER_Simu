// 浏览器侧的航迹预览（06 备忘录 §9C G-4）。
//
// **只做直线插值，不做物理**（docs/scenario-format.md §1）：路损、多普勒、时延一律由引擎给，
// 这里算的只有位置、航向与速度，供编辑器画规划航线与游标预览。
//
// 与 C++ 的 geo/ 逐条同式，否则守不住「预览航迹与 cuav_run --scenario-track 逐时刻差 ≤ 1e-6 度」：
//   ① 距离一律 ECEF 弦长，不用半正矢（geo/include/cuav_geo/geodesy.h 里写明了这处偏离）；
//   ② 段时长 = 弦长 / 段起点航点速度，悬停接在到达之后；
//   ③ state_at(t) 对绝对时刻二分定位后闭式插值，不做增量积分；
//   ④ 段内经纬高各自线性。
// 改这里必须同时改 geo/src/kinematics.cpp，并重跑 tests/golden/scenario-track-demo-01.json 的对拍。

const A = 6378137.0
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const DEG = Math.PI / 180

export interface Lla { lon: number; lat: number; alt_m: number }
export interface Ecef { x: number; y: number; z: number }

export function llaToEcef(p: Lla): Ecef {
  const lat = p.lat * DEG
  const lon = p.lon * DEG
  const s = Math.sin(lat)
  const c = Math.cos(lat)
  const n = A / Math.sqrt(1 - E2 * s * s)
  return {
    x: (n + p.alt_m) * c * Math.cos(lon),
    y: (n + p.alt_m) * c * Math.sin(lon),
    z: (n * (1 - E2) + p.alt_m) * s,
  }
}

/** ECEF 弦长。与 geo::chord_distance_m 同式。 */
export function chordDistanceM(a: Lla, b: Lla): number {
  const p = llaToEcef(a)
  const q = llaToEcef(b)
  const dx = p.x - q.x
  const dy = p.y - q.y
  const dz = p.z - q.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** ECEF 矢量转站心 ENU（只旋转不平移）。 */
function rotateToEnu(v: Ecef, origin: Lla): { e: number; n: number; u: number } {
  const lat = origin.lat * DEG
  const lon = origin.lon * DEG
  const sp = Math.sin(lat)
  const cp = Math.cos(lat)
  const sl = Math.sin(lon)
  const cl = Math.cos(lon)
  return {
    e: -sl * v.x + cl * v.y,
    n: -sp * cl * v.x - sp * sl * v.y + cp * v.z,
    u: cp * cl * v.x + cp * sl * v.y + sp * v.z,
  }
}

/** 视线角：方位真北顺时针 [0,360)，俯仰水平为 0。与 geo::look_angles 同式。 */
export function lookAngles(from: Lla, to: Lla): { distance_m: number; azimuth_deg: number; elevation_deg: number } {
  const p = llaToEcef(to)
  const o = llaToEcef(from)
  const d = rotateToEnu({ x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }, from)
  const dist = Math.sqrt(d.e * d.e + d.n * d.n + d.u * d.u)
  const horiz = Math.hypot(d.e, d.n)
  let az = (Math.atan2(d.e, d.n) * 180) / Math.PI
  if (az < 0) az += 360
  if (az >= 360) az -= 360
  return { distance_m: dist, azimuth_deg: az, elevation_deg: dist > 0 ? (Math.atan2(d.u, horiz) * 180) / Math.PI : 0 }
}

export function bearingDeg(from: Lla, to: Lla): number {
  return lookAngles(from, to).azimuth_deg
}

export interface Waypoint { position: Lla; speed_mps: number; loiter_s?: number }

export interface MotionState {
  t_s: number
  position: Lla
  heading_deg: number
  speed_mps: number
  moving: boolean
}

interface Leg { from: Lla; to: Lla; travel_s: number; speed: number; heading: number }
interface Phase { t0: number; t1: number; leg: number; moving: boolean }

/** 段长小于 1 毫米即视为重合航点（与 geo/src/kinematics.cpp 的 kMinSegment_m 相同）。 */
const MIN_SEGMENT_M = 1e-3

export class RoutePreview {
  private legs: Leg[] = []
  private phases: Phase[] = []
  private single: Lla = { lon: 0, lat: 0, alt_m: 0 }
  private cycle = 0
  private finalHeading = 0
  readonly loop: boolean

  constructor(waypoints: Waypoint[], loop = false) {
    this.loop = loop
    if (!waypoints.length) return
    this.single = waypoints[0].position
    if (waypoints.length === 1) return

    const legCount = loop ? waypoints.length : waypoints.length - 1
    let t = 0
    for (let i = 0; i < legCount; i++) {
      const a = waypoints[i]
      const b = waypoints[(i + 1) % waypoints.length]
      const len = chordDistanceM(a.position, b.position)
      const leg: Leg = {
        from: a.position,
        to: b.position,
        travel_s: 0,
        speed: a.speed_mps,
        heading: this.legs.length ? this.legs[this.legs.length - 1].heading : 0,
      }
      if (len >= MIN_SEGMENT_M && a.speed_mps > 0) {
        leg.travel_s = len / a.speed_mps
        leg.heading = bearingDeg(a.position, b.position)
      }
      this.legs.push(leg)
      if (leg.travel_s > 0) {
        this.phases.push({ t0: t, t1: t + leg.travel_s, leg: this.legs.length - 1, moving: true })
        t += leg.travel_s
      }
      const loiter = b.loiter_s ?? 0
      if (loiter > 0) {
        this.phases.push({ t0: t, t1: t + loiter, leg: this.legs.length - 1, moving: false })
        t += loiter
      }
    }
    this.cycle = t
    if (this.legs.length) this.finalHeading = this.legs[this.legs.length - 1].heading
  }

  get durationS(): number {
    return this.cycle
  }

  stateAt(t_s: number): MotionState {
    const tIn = t_s
    if (!this.phases.length || this.cycle <= 0) {
      return { t_s: tIn, position: this.single, heading_deg: this.finalHeading, speed_mps: 0, moving: false }
    }
    let t = t_s < 0 ? 0 : t_s
    if (this.loop) {
      t = t % this.cycle
      if (t < 0) t += this.cycle
    } else if (t >= this.cycle) {
      const last = this.legs[this.legs.length - 1]
      return { t_s: tIn, position: last.to, heading_deg: last.heading, speed_mps: 0, moving: false }
    }
    let lo = 0
    let hi = this.phases.length
    while (lo + 1 < hi) {
      const mid = lo + ((hi - lo) >> 1)
      if (this.phases[mid].t0 <= t) lo = mid
      else hi = mid
    }
    const ph = this.phases[lo]
    const leg = this.legs[ph.leg]
    if (!ph.moving) {
      return { t_s: tIn, position: leg.to, heading_deg: leg.heading, speed_mps: 0, moving: false }
    }
    let u = (t - ph.t0) / leg.travel_s
    if (u < 0) u = 0
    if (u > 1) u = 1
    return {
      t_s: tIn,
      position: {
        lon: leg.from.lon + (leg.to.lon - leg.from.lon) * u,
        lat: leg.from.lat + (leg.to.lat - leg.from.lat) * u,
        alt_m: leg.from.alt_m + (leg.to.alt_m - leg.from.alt_m) * u,
      },
      heading_deg: leg.heading,
      speed_mps: leg.speed,
      moving: true,
    }
  }
}

/**
 * 活动时间线：发射开关与跳频（与 geo::EmitterRuntime 同语义，docs/scenario-format.md §6）。
 * 无 tx_on / tx_off 活动时自 t = 0 起恒发射；一旦有这类活动，首个 tx_on 之前视为不发射。
 */
export class ActivityPreview {
  private txT: number[] = []
  private txOn: boolean[] = []
  private hasTx = false
  private hops: Array<{ t: number; seq: number[]; dwell: number }> = []

  constructor(activities: Array<Record<string, unknown>>, emitterId: string, private readonly baseCenterHz: number) {
    for (const a of activities) {
      if (a.emitter_id !== emitterId) continue
      const t = typeof a.t_s === 'number' ? a.t_s : 0
      if (a.event === 'tx_on' || a.event === 'tx_off') {
        this.hasTx = true
        this.txT.push(t)
        this.txOn.push(a.event === 'tx_on')
      } else if (a.event === 'hop') {
        const args = (a.args ?? {}) as Record<string, unknown>
        if (typeof args.center_Hz === 'number') this.hops.push({ t, seq: [args.center_Hz], dwell: 0 })
        else if (Array.isArray(args.sequence)) {
          this.hops.push({ t, seq: args.sequence as number[], dwell: typeof args.dwell_s === 'number' ? args.dwell_s : 0 })
        }
      }
    }
  }

  txOnAt(t_s: number): boolean {
    if (!this.hasTx) return true
    let on = false
    for (let i = 0; i < this.txT.length; i++) {
      if (this.txT[i] <= t_s) on = this.txOn[i]
      else break
    }
    return on
  }

  centerHzAt(t_s: number): number {
    let f = this.baseCenterHz
    for (const h of this.hops) {
      if (h.t > t_s) break
      if (!h.seq.length) continue
      if (h.dwell > 0) {
        const k = Math.floor((t_s - h.t) / h.dwell)
        f = h.seq[((k % h.seq.length) + h.seq.length) % h.seq.length]
      } else {
        f = h.seq[0]
      }
    }
    return f
  }
}
