// 本地场景适配器 —— C++ `geo::LocalSceneAdapter`（geo/src/local_scene_adapter.cpp）的浏览器一侧
// （D3-6，D-074）。100 米桶网格 + Amanatides-Woo 线段遍历。
//
// **祖本是 em-demo `src/models/occlusion.ts`**，C++ 那份就是从它来的；这次是回迁。
// 两处按 C++ 的约定改（07 报告 §2.2）：
//   ① **外环首尾不闭合**——祖本存的是闭合环（首点 == 末点），C++ 约定不闭合、闭合边由遍历
//      隐式补齐。留着重复的末点会多出一条零长边，`denom` 恰好落在 1e-12 判据的边上。
//   ② **投影挪到调用方**——祖本把西安的 LAT0/LON0 写死成模块常量，这里由 scene/occlusion/frame.ts
//      给，接口只吃平面米。
//
// 除这两处外**算法与数值一字未改**，且**不得加 C++ 没有的分支**（D-074 ①）。
// 两侧同守 tests/golden/occlusion.json 的 148 例。

import type { MapPoint } from './frame.js'

/** 建筑体块。外环顶点已经是平面米、**首尾不闭合**。与 C++ `geo::Building` 同构。 */
export interface Building {
  id: string
  ringX: number[]
  ringY: number[]
  baseM: number
  heightM: number
}

/** 线段求交结果。命中语义是「**侵入最深的等效单刀口**」，不是首个交点。 */
export interface RaycastHit {
  objectId: string
  /** 起点 → 命中点的地面距离 d1 */
  distanceM: number
  /** 视线侵入命中体块的竖直深度 */
  intrusionM: number
  /** 命中点 → 终点的地面距离 d2 */
  exitDistanceM: number
  point: MapPoint
}

const CELL_M = 100 // 桶边长（米），同祖本与 C++ 的 kCellM

function cellKey(cx: number, cy: number): number {
  // cx, cy 约在 [−70, 70]；偏到正区间避免负键冲突（同祖本与 C++）
  return (cx + 8192) * 16384 + (cy + 8192)
}

function cellOf(v: number): number {
  return Math.floor(v / CELL_M)
}

interface Indexed {
  xs: Float64Array
  ys: Float64Array
  minX: number; minY: number; maxX: number; maxY: number
  heightM: number
  baseM: number
}

export class LocalSceneAdapter {
  #buildings: Building[] = []
  #indexed: Indexed[] = []
  #grid = new Map<number, number[]>()
  #dropped = 0
  #seen = new Int32Array(0)
  #gen = 0
  #terrainHeightM = 0

  /**
   * 重建桶网格索引。顶点 < 3 或高度非正的要素剔除，剔除数由 droppedCount() 给出
   * ——**不静默丢**（铁律 15），调用方要把它记进产物或探针。
   */
  setBuildings(list: readonly Building[]): void {
    this.#buildings = []
    this.#indexed = []
    this.#grid = new Map()
    this.#dropped = 0

    for (const b of list) {
      const n = b.ringX.length
      if (n < 3 || b.ringY.length !== n) { this.#dropped++; continue }
      if (!Number.isFinite(b.heightM) || b.heightM <= 0) { this.#dropped++; continue }

      const xs = new Float64Array(n)
      const ys = new Float64Array(n)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (let i = 0; i < n; i++) {
        const x = b.ringX[i]
        const y = b.ringY[i]
        xs[i] = x; ys[i] = y
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
      this.#indexed.push({ xs, ys, minX, minY, maxX, maxY, heightM: b.heightM, baseM: b.baseM })
      this.#buildings.push(b)
    }

    // 建网格：每栋插进它包围盒覆盖的所有桶
    for (let bi = 0; bi < this.#indexed.length; bi++) {
      const b = this.#indexed[bi]
      for (let cx = cellOf(b.minX); cx <= cellOf(b.maxX); cx++) {
        for (let cy = cellOf(b.minY); cy <= cellOf(b.maxY); cy++) {
          const k = cellKey(cx, cy)
          const list_ = this.#grid.get(k)
          if (list_) list_.push(bi)
          else this.#grid.set(k, [bi])
        }
      }
    }
    this.#seen = new Int32Array(this.#indexed.length)
    this.#gen = 0
  }

  buildingCount(): number { return this.#buildings.length }
  droppedCount(): number { return this.#dropped }
  /** 显式平地假设（铁律 2）。首期是常数，遮挡本身不读它。 */
  terrainHeightM(): number { return this.#terrainHeightM }
  setTerrainHeightM(h: number): void { this.#terrainHeightM = h }

  /** 包围盒内的建筑体块。 */
  queryBuildings(minX: number, minY: number, maxX: number, maxY: number): Building[] {
    const out: Building[] = []
    for (let i = 0; i < this.#indexed.length; i++) {
      const b = this.#indexed[i]
      if (!(b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY)) {
        out.push(this.#buildings[i])
      }
    }
    return out
  }

  /** 射线投射法判断平面点是否在外环内（自遮挡排除用），同 C++ point_in_polygon。 */
  #pointInPolygon(px: number, py: number, b: Indexed): boolean {
    if (px < b.minX || px > b.maxX || py < b.minY || py > b.maxY) return false
    const { xs, ys } = b
    let inside = false
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      const yi = ys[i]
      const yj = ys[j]
      if ((yi > py) !== (yj > py)) {
        const xCross = ((xs[j] - xs[i]) * (py - yi)) / (yj - yi) + xs[i]
        if (px < xCross) inside = !inside
      }
    }
    return inside
  }

  /** 线段求交。未命中返回 null。与 C++ `raycast()` 逐行同式。 */
  raycast(p1: MapPoint, p2: MapPoint): RaycastHit | null {
    if (this.#indexed.length === 0) return null

    const x0 = p1.x, y0 = p1.y, x1 = p2.x, y1 = p2.y
    const dx = x1 - x0
    const dy = y1 - y0
    const dGround = Math.sqrt(dx * dx + dy * dy)
    if (dGround < 1e-6) return null

    if (++this.#gen === 0) { // 极罕见的回绕：重置标记
      this.#seen.fill(0)
      this.#gen = 1
    }
    const gen = this.#gen

    let maxIntrusion = 0
    let bestD1 = 0, bestD2 = 0, bestT = 0, bestIdx = -1

    // 单栋候选：求段与多边形的交点参数区间，取侵入最深那一端
    const testBuilding = (bi: number): void => {
      const b = this.#indexed[bi]
      // 排除架在楼顶（或楼内）的设备与目标：自遮挡
      if (this.#pointInPolygon(x0, y0, b) || this.#pointInPolygon(x1, y1, b)) return

      const { xs, ys } = b
      const n = xs.length
      let tMin = Infinity
      let tMax = -Infinity
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = xs[j]
        const ay = ys[j]
        const ex = xs[i] - ax
        const ey = ys[i] - ay
        const denom = dx * ey - dy * ex
        if (Math.abs(denom) < 1e-12) continue // 平行
        const wx = ax - x0
        const wy = ay - y0
        const t = (wx * ey - wy * ex) / denom // 沿射线
        const u = (wx * dy - wy * dx) / denom // 沿边
        if (t < 0 || t > 1 || u < 0 || u > 1) continue
        if (t < tMin) tMin = t
        if (t > tMax) tMax = t
      }
      if (tMax < 0) return // 不相交（含 −Infinity 初值）

      // 侵入最深处 = 遮挡区间内视线高度最低的那一端（视线高度沿 t 线性）
      const altMin = p1.z + (p2.z - p1.z) * tMin
      const altMax = p1.z + (p2.z - p1.z) * tMax
      const tDeep = altMin <= altMax ? tMin : tMax
      const rayAlt = p1.z + (p2.z - p1.z) * tDeep
      if (rayAlt < b.baseM || rayAlt >= b.heightM) return // 楼下穿过或楼顶掠过
      const intrusion = b.heightM - rayAlt
      if (intrusion > maxIntrusion) {
        maxIntrusion = intrusion
        bestD1 = tDeep * dGround
        bestD2 = (1 - tDeep) * dGround
        bestT = tDeep
        bestIdx = bi
      }
    }

    // ---- Amanatides-Woo 网格遍历：只走线段穿过的桶 ----
    let cx = cellOf(x0)
    let cy = cellOf(y0)
    const cxEnd = cellOf(x1)
    const cyEnd = cellOf(y1)
    const stepX = dx > 0 ? 1 : -1
    const stepY = dy > 0 ? 1 : -1
    const tDeltaX = dx !== 0 ? Math.abs(CELL_M / dx) : Infinity
    const tDeltaY = dy !== 0 ? Math.abs(CELL_M / dy) : Infinity
    const nextX = (dx > 0 ? cx + 1 : cx) * CELL_M
    const nextY = (dy > 0 ? cy + 1 : cy) * CELL_M
    let tMaxX = dx !== 0 ? (nextX - x0) / dx : Infinity
    let tMaxY = dy !== 0 ? (nextY - y0) / dy : Infinity

    let guard = 0
    const guardMax = Math.abs(cxEnd - cx) + Math.abs(cyEnd - cy) + 4
    for (;;) {
      const list = this.#grid.get(cellKey(cx, cy))
      if (list) {
        for (let k = 0; k < list.length; k++) {
          const bi = list[k]
          if (this.#seen[bi] === gen) continue
          this.#seen[bi] = gen
          testBuilding(bi)
        }
      }
      if (cx === cxEnd && cy === cyEnd) break
      if (++guard > guardMax) break // 数值兜底
      if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX } else { cy += stepY; tMaxY += tDeltaY }
    }

    if (maxIntrusion <= 0) return null

    const b = this.#buildings[bestIdx]
    return {
      objectId: b.id,
      distanceM: bestD1,
      intrusionM: maxIntrusion,
      exitDistanceM: bestD2,
      point: { x: p1.x + (p2.x - p1.x) * bestT, y: p1.y + (p2.y - p1.y) * bestT, z: b.heightM },
    }
  }
}
