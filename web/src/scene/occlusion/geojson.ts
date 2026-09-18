// buildings.geojson → 平面米的建筑体块 —— C++ `engine/src/buildings_json.cpp` 的浏览器一侧
// （D3-6，D-074）。**解析规则与 C++ 逐条相同**，否则「渲染与物理同源」（铁律 11）只是句口号：
//
//   · GeoJSON 的线性环是闭合的（首点 == 末点），这里**去掉重复的末点**——适配器约定首尾不闭合；
//   · `MultiPolygon` 的**每个子多边形的外环各当一栋**，id 加 `#<序号>` 后缀；
//   · 内环（孔）忽略并计数——一处会让遮挡**偏保守**的简化（07 报告 §8 第 5 条）；
//   · `height_m ≤ 0` 或外环顶点 < 3 的剔除并计数，**不拿缺省值顶替**（铁律 15）。
//
// 唯一有意的不同：C++ 遇到不认识的几何类型会**报错**（本项目的建筑集只会有这两种，出现别的
// 说明上游变了）；浏览器这一侧**计数并跳过**，因为它同时还要把这份文件交给 MapLibre 渲染，
// 一个坏要素不该让整幅图白掉。计数进 stats，照样说得出来，不是静默丢。

import type { Building } from './adapter.js'
import type { SceneFrame } from './frame.js'

export interface BuildingsStats {
  features: number
  polygons: number
  multipolygons: number
  parts: number
  holesIgnored: number
  droppedDegenerate: number
  droppedHeight: number
  skippedGeometry: number
  buildings: number
}

function emptyStats(): BuildingsStats {
  return {
    features: 0, polygons: 0, multipolygons: 0, parts: 0, holesIgnored: 0,
    droppedDegenerate: 0, droppedHeight: 0, skippedGeometry: 0, buildings: 0,
  }
}

export function summarize(s: BuildingsStats): string {
  let out = `建筑 ${s.buildings} 栋（要素 ${s.features}：Polygon ${s.polygons}、`
    + `MultiPolygon ${s.multipolygons} 拆出 ${s.parts} 件）`
  if (s.holesIgnored > 0) out += `；忽略内环 ${s.holesIgnored} 个`
  if (s.droppedDegenerate > 0) out += `；顶点不足剔除 ${s.droppedDegenerate} 件`
  if (s.droppedHeight > 0) out += `；高度非正剔除 ${s.droppedHeight} 件`
  if (s.skippedGeometry > 0) out += `；几何类型不认识跳过 ${s.skippedGeometry} 件`
  return out
}

type Ring = number[][]

function ringToBuilding(
  ring: Ring, frame: SceneFrame, id: string, baseM: number, heightM: number,
  stats: BuildingsStats,
): Building | null {
  if (!Array.isArray(ring)) { stats.droppedDegenerate++; return null }
  let n = ring.length
  // 去掉 GeoJSON 的闭合点：留着会多出一条零长边
  if (n >= 2) {
    const a = ring[0]
    const b = ring[n - 1]
    if (Array.isArray(a) && Array.isArray(b) && a.length >= 2 && b.length >= 2
      && a[0] === b[0] && a[1] === b[1]) n--
  }
  if (n < 3) { stats.droppedDegenerate++; return null }
  if (!(heightM > 0)) { stats.droppedHeight++; return null }

  const ringX: number[] = new Array(n)
  const ringY: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const pt = ring[i]
    if (!Array.isArray(pt) || pt.length < 2
      || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
      stats.droppedDegenerate++
      return null
    }
    const p = frame.toPlane(pt[0], pt[1])
    ringX[i] = p.x
    ringY[i] = p.y
  }
  return { id, ringX, ringY, baseM, heightM }
}

function featureId(f: Record<string, unknown>, index: number): string {
  const props = (f.properties ?? {}) as Record<string, unknown>
  const raw = props.id ?? f.id
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') return String(raw)
  return `feature#${index}`
}

function propNumber(f: Record<string, unknown>, key: string, def: number): number {
  const props = (f.properties ?? {}) as Record<string, unknown>
  const v = props[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}

/** GeoJSON FeatureCollection → 平面米的建筑体块。规则见本文件头注。 */
export function parseBuildings(
  doc: unknown, frame: SceneFrame,
): { buildings: Building[]; stats: BuildingsStats } {
  const stats = emptyStats()
  const out: Building[] = []
  const root = doc as { type?: unknown; features?: unknown }
  if (!root || root.type !== 'FeatureCollection' || !Array.isArray(root.features)) {
    return { buildings: out, stats }
  }
  const feats = root.features as Record<string, unknown>[]
  stats.features = feats.length

  for (let i = 0; i < feats.length; i++) {
    const f = feats[i]
    const g = f.geometry as { type?: unknown; coordinates?: unknown } | undefined
    if (!g || typeof g.type !== 'string' || !Array.isArray(g.coordinates)) {
      stats.skippedGeometry++
      continue
    }
    const id = featureId(f, i)
    const baseM = propNumber(f, 'base_m', 0)
    const heightM = propNumber(f, 'height_m', 0)

    if (g.type === 'Polygon') {
      stats.polygons++
      const rings = g.coordinates as Ring[]
      if (rings.length === 0) { stats.droppedDegenerate++; continue }
      if (rings.length > 1) stats.holesIgnored += rings.length - 1
      const b = ringToBuilding(rings[0], frame, id, baseM, heightM, stats)
      if (b) out.push(b)
    } else if (g.type === 'MultiPolygon') {
      stats.multipolygons++
      const polys = g.coordinates as Ring[][]
      for (let k = 0; k < polys.length; k++) {
        const poly = polys[k]
        if (!Array.isArray(poly) || poly.length === 0) { stats.droppedDegenerate++; continue }
        stats.parts++
        if (poly.length > 1) stats.holesIgnored += poly.length - 1
        const b = ringToBuilding(poly[0], frame, `${id}#${k}`, baseM, heightM, stats)
        if (b) out.push(b)
      }
    } else {
      stats.skippedGeometry++
    }
  }
  stats.buildings = out.length
  return { buildings: out, stats }
}
