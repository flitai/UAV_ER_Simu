// 把「渲染与物理同源」在**跑起来的画面上**核对一遍（D4，D-076）。
//
// 这是开发者模式的一条命令（`window.__cuav.scene.sameSource()`），**不是探针**：
// 它会触发建筑几何的懒加载（那是一次网络请求）。`window.__probe()` 必须保持无副作用
// （`scene/probe.ts` 的头注与 D4-3 的验收条件），两者因此分开放。
//
// 它**不放在 `occlusion/` 下面**：那个目录是遮挡的物理侧，一个文件都不认识 MapLibre，
// 这样「瓦片 `buildings` 层永不进遮挡计算」（铁律 11、D-002）才是结构上成立的，
// 而不是「目前碰巧没人这么写」。`scripts/build-all.sh` 有一条守卫盯着这件事。
// 这个文件要同时读地图和桶网格，所以它只能待在外面。

import type { Map as MLMap } from 'maplibre-gl'
import { BUILDINGS_LAYER_ID, BUILDINGS_SOURCE_ID, buildingsSourceUrl } from './layers/buildings3d.js'
import { compareSameSource, type PhysicalBuilding, type RenderedBuilding, type SameSourceResult } from './occlusion/sameSource.js'
import { ensureOcclusion, occlusionFrame, occlusionMap, occlusionState } from './occlusion/store.js'

export interface SameSourceReport extends SameSourceResult {
  /** `fill-extrusion` 数据源的地址 */
  renderUrl: string | null
  /** 遮挡侧实际取的地址 */
  physicsUrl: string | null
  /** 两个地址逐字相同——「同一份文件」这句话的字面证据 */
  sameUrl: boolean
  /** 物理侧桶网格里一共几栋（视窗外的也算） */
  physicsTotal: number
  /** `fill-extrusion` 的数据源加载完了没有。`rendered === 0` 时靠它区分「还没到」与「真的没有」 */
  sourceLoaded: boolean
  error: string | null
}

function ringPointsOf(f: { geometry?: { type?: string; coordinates?: unknown } }): number | null {
  const g = f.geometry
  if (!g) return null
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    const ring = (g.coordinates as number[][][])[0]
    if (!Array.isArray(ring) || ring.length < 2) return null
    // GeoJSON 的环是闭合的；物理侧去掉了重复的末点，这里同样去掉才可比
    const a = ring[0]
    const b = ring[ring.length - 1]
    const closed = a[0] === b[0] && a[1] === b[1]
    return ring.length - (closed ? 1 : 0)
  }
  return null
}

/** 要素外环的经纬度点（`MultiPolygon` 则是各子多边形的外环）。只为定查询范围，不参与比较。 */
function ringCoords(f: { geometry?: { type?: string; coordinates?: unknown } }): number[][] {
  const g = f.geometry
  if (!g || !Array.isArray(g.coordinates)) return []
  if (g.type === 'Polygon') return ((g.coordinates as number[][][])[0] ?? [])
  if (g.type === 'MultiPolygon') {
    const out: number[][] = []
    for (const poly of g.coordinates as number[][][][]) if (poly?.[0]) out.push(...poly[0])
    return out
  }
  return []
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 核对当前画面里的建筑。只读地图、只读桶网格；除了可能触发一次建筑几何的懒加载之外没有副作用。
 *
 * 比较范围是**当前视窗**：物理侧按视窗的经纬度包围盒投影到平面米再查桶网格，
 * 拿全量四万多栋去比会把「没画出来」误判成「对不上」。
 */
export async function sameSourceCheck(
  map: MLMap, buildingsUrl: string, originLon: number, originLat: number,
): Promise<SameSourceReport> {
  // 渲染侧的地址取自**交给 MapLibre 的那一刻**，不是 `getStyle()`：源加载完之后
  // 序列化出来的 `data` 是解析后的对象而不是地址（见 `buildings3d.buildingsSourceUrl` 的头注）。
  const renderUrl = buildingsSourceUrl()

  const sourceLoaded = !!map.getSource(BUILDINGS_SOURCE_ID) && map.isSourceLoaded(BUILDINGS_SOURCE_ID)
  const empty: SameSourceReport = {
    rendered: 0, matched: 0, missingInPhysics: [], agreedAbsent: [], diffs: [], ringPointsDiff: 0, ok: false,
    renderUrl, physicsUrl: occlusionState().url, sameUrl: false, physicsTotal: 0, sourceLoaded, error: null,
  }
  if (!map.getLayer(BUILDINGS_LAYER_ID)) return { ...empty, error: '画面上没有观测区域建筑层' }

  await ensureOcclusion(buildingsUrl, originLon, originLat)
  const adapter = occlusionMap()
  const frame = occlusionFrame()
  const physicsUrl = occlusionState().url
  if (!adapter || !frame) return { ...empty, physicsUrl, error: occlusionState().error ?? '建筑几何没加载起来' }

  const renderedFeatures = map.queryRenderedFeatures({ layers: [BUILDINGS_LAYER_ID] })
  const seen = new Set<string>()
  const rendered: RenderedBuilding[] = []
  for (const f of renderedFeatures) {
    const props = (f.properties ?? {}) as Record<string, unknown>
    const id = typeof props.id === 'string' ? props.id : typeof props.id === 'number' ? String(props.id) : null
    // 瓦片化会把一个要素切成多片，同一个 id 会出现好几次；比一次就够
    if (!id || seen.has(id)) continue
    seen.add(id)
    rendered.push({ id, height_m: num(props.height_m), base_m: num(props.base_m), ringPoints: ringPointsOf(f) })
  }

  // 物理侧的查询范围**由画出来的那些要素自己定**，不用 `map.getBounds()`。
  // 俯仰 55° 下 getBounds() 给的不是渲染范围——远处地平线附近画出来的楼会落在它外面，
  // 于是「物理侧没有它」实际上是「我没去那儿找」（2026-09-19 实测 6 栋这样的误判，D-076）。
  // 按要素自身的坐标取并集，问的就正好是那句话：**屏幕上这一栋，物理侧有没有**。
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const f of renderedFeatures) {
    for (const lonlat of ringCoords(f)) {
      const q = frame.toPlane(lonlat[0], lonlat[1])
      if (q.x < minX) minX = q.x
      if (q.x > maxX) maxX = q.x
      if (q.y < minY) minY = q.y
      if (q.y > maxY) maxY = q.y
    }
  }
  const near = Number.isFinite(minX)
    ? adapter.queryBuildings(minX - 1, minY - 1, maxX + 1, maxY + 1)
    : []
  const physical: PhysicalBuilding[] = near.map((p) => ({
    id: p.id, heightM: p.heightM, baseM: p.baseM, ringPoints: p.ringX.length,
  }))

  const cmp = compareSameSource(rendered, physical)
  return {
    ...cmp,
    renderUrl, physicsUrl,
    sameUrl: renderUrl !== null && renderUrl === physicsUrl,
    physicsTotal: adapter.buildingCount(),
    sourceLoaded,
    error: null,
  }
}
