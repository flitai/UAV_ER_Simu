// 建筑刀口衍射 —— C++ `geo::segment_occlusion`（geo/src/occlusion.cpp）与
// `geo::legacy::{fresnel_v, knife_edge_loss_dB}` 的浏览器一侧（D3-6，D-074）。
//
// 物理与地图解耦：本文件只做刀口衍射，桶网格与线段几何全在 adapter.ts（05 §3.1）。
// 黄金基准 tests/golden/occlusion.json 的 148 例 + propagation.json 的 fresnelV 108 例、
// knifeEdgeLoss_dB 14 例，判据 rel ≤ 1e-9，**与 C++ 各守一遍**。

import type { MapPoint } from './frame.js'
import type { LocalSceneAdapter } from './adapter.js'

export interface OcclusionResult {
  /** 单程刀口衍射损耗。无遮挡为 0 */
  obstructionLossDb: number
  /** 视线侵入建筑的竖直深度，仅信息性 */
  intrusionM: number
  /** 视线在几何上有没有被楼切断 */
  blocked: boolean
}

const ZERO: OcclusionResult = { obstructionLossDb: 0, intrusionM: 0, blocked: false }

/**
 * **光速取 3e8，不是 299792458**（D-009）。刀口衍射这一整套是被 148 例黄金基准**整体**
 * 钉住的一个模块，只换其中一个常数会让它内部自相矛盾——几何走严格站心坐标、波长却走旧光速。
 * 量级是 **3e-3 dB**（07 报告 §14.3 修正过这个数），物理上无关紧要、1e-9 的基准上是硬伤。
 * C++ 侧同样把它留在 `geo::legacy` 里，两边一致。
 */
const SPEED_OF_LIGHT_GOLDEN = 3e8

/** Fresnel-Kirchhoff 衍射参数 v。obstacleHeightM 是视线侵入刀口的深度。 */
export function fresnelV(
  obstacleHeightM: number, d1M: number, d2M: number, frequencyHz: number,
): number {
  const lambda = SPEED_OF_LIGHT_GOLDEN / frequencyHz
  return obstacleHeightM * Math.sqrt((2 * (d1M + d2M)) / (lambda * d1M * d2M))
}

/**
 * ITU-R P.526 单刀口衍射损耗（dB，**单程**）。v ≤ −0.78 时为 0；
 * 掠射（v = 0）解析值 6.9 + 20·log10(√1.01 − 0.1) = 6.0329 dB。
 */
export function knifeEdgeLossDb(v: number): number {
  if (v <= -0.78) return 0
  const t = v - 0.1
  return 6.9 + 20 * Math.log10(Math.sqrt(t * t + 1) + t)
}

/**
 * tx → rx 视线被建筑切断时的刀口衍射损耗。两个端点都是**平面米**（投影由调用方做，
 * 见 frame.ts）。没有建筑或未命中时优雅降级返回全 0。
 *
 * **单程 ×1，不乘 2**：emcore 的原注写的是「雷达双程 ×2、单向链路 ×1」，本系统是电子侦察
 * 单向链路。这是从雷达代码移植过来时最容易顺手抄错的地方。
 */
export function segmentOcclusion(
  map: LocalSceneAdapter, tx: MapPoint, rx: MapPoint, frequencyHz: number,
): OcclusionResult {
  const hit = map.raycast(tx, rx)
  if (!hit || hit.intrusionM <= 0) return ZERO

  // d1 / d2 下限 1 米：端点贴着障碍时 Fresnel 参数发散的工程钳位（同 C++ 与祖本）
  const d1 = Math.max(hit.distanceM, 1)
  const d2 = Math.max(hit.exitDistanceM, 1)
  const v = fresnelV(hit.intrusionM, d1, d2, frequencyHz)
  return { obstructionLossDb: knifeEdgeLossDb(v), intrusionM: hit.intrusionM, blocked: true }
}

/** 视距 = 没被楼切断。**与损耗大小无关**：掠射只损几分贝也算非视距（07 §5.1、D-039）。 */
export function lineOfSight(r: OcclusionResult): boolean {
  return !r.blocked
}
