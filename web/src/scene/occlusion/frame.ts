// 遮挡几何的平面工作帧 —— C++ `geo::SceneFrame`（cuav_geo/map.h）的浏览器一侧（D3-6，D-074）。
//
// **真理源是 C++**（D-074 ①）。三条纪律：
//   1. 改动顺序固定为 改 C++ → 重生成 golden → 这边对拍；
//   2. 这边**不得有 C++ 没有的分支**（按视窗裁剪一类只能写在调用侧）；
//   3. 两侧同守 `tests/golden/occlusion.json` 的 148 例，`rel ≤ 1e-9`。
//
// 两套投影并存，**按用途选，别混**（与 `geo::legacy` 的分工逐条对应）：
//   · `SceneFrame`        —— 严格站心地平的东 / 北，引擎实际运行走这一套（铁律 1）；
//   · `legacyFrameOcclusion` —— 148 例黄金基准当年那把尺子（纬向 110540、经向 111320·cosφ），
//     **只用于回放黄金基准**。拿它去对引擎结果会差 0.1 dB（07 报告 §6.2）。
//
// `z` 不由本帧产生：高度一律用离地高差另给（铁律 2）。拿 ENU 的 up 当高度是错的——
// 10 km 外它已因地球曲率低了 7.8 m，而建筑的 base_m / height_m 是离地高差。

import { llaToEcef, rotateToEnu } from '../editor/preview.js'

/** 平面局部坐标，米。x 东、y 北、z 离地高。与 C++ `geo::MapPoint` 同构。 */
export interface MapPoint { x: number; y: number; z: number }

/** 局部等距圆柱投影的尺度（米/度）。与 C++ `geo::legacy::LocalFrame` 同构。 */
export interface LocalFrame { mPerDegLat: number; mPerDegLon: number }

/**
 * 建筑遮挡那批黄金基准的投影：纬向 **110540**。
 * 与 `geo::legacy::local_frame_occlusion()` 逐字同式，**一个数不许改**，否则那 148 例就废了（D-009）。
 * 注意定位那批用的是 111320，两把尺子只有纬向不同，光看经向分不出来。
 */
export function legacyFrameOcclusion(refLatDeg: number): LocalFrame {
  return { mPerDegLat: 110540, mPerDegLon: 111320 * Math.cos((refLatDeg * Math.PI) / 180) }
}

/** 按旧投影把经纬度打到平面米。只在回放黄金基准时用。 */
export function legacyToPlane(
  fr: LocalFrame, refLon: number, refLat: number, lon: number, lat: number,
): { x: number; y: number } {
  return { x: (lon - refLon) * fr.mPerDegLon, y: (lat - refLat) * fr.mPerDegLat }
}

/**
 * 严格站心地平的平面帧。原点取观测区域清单的 `aoi.center`——它是数据包的属性，
 * 与场景无关、与站点无关，于是同一个数据包的所有站、所有场景共用同一把尺子。
 *
 * 与引擎的差别只有椭球换算那一层：引擎自 D3-2 起走 vendored GeographicLib，这边走
 * `preview.ts` 的自写闭式。两家实测差 **1.7e-9 m**（07 报告 §3.2），对建筑轮廓这个尺度
 * 无关紧要；真要逐位一致得把 GeographicLib 也搬进浏览器，不值得。
 */
export class SceneFrame {
  readonly originLon: number
  readonly originLat: number

  constructor(originLon: number, originLat: number) {
    this.originLon = originLon
    this.originLat = originLat
  }

  /** 经纬度 → 平面米。高度取原点高度，故只反映水平位置。 */
  toPlane(lon: number, lat: number): { x: number; y: number } {
    const o = { lon: this.originLon, lat: this.originLat, alt_m: 0 }
    const p = llaToEcef({ lon, lat, alt_m: 0 })
    const q = llaToEcef(o)
    const d = rotateToEnu({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z }, o)
    return { x: d.e, y: d.n }
  }

  /** 经纬度 + **离地高差** → 遮挡几何的平面点。 */
  point(lon: number, lat: number, heightAglM: number): MapPoint {
    const { x, y } = this.toPlane(lon, lat)
    return { x, y, z: heightAglM }
  }
}
