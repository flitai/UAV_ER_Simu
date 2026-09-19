// 渲染与物理同源的**核对**（D4，D-076；铁律 11）。
//
// 铁律 11 要求 `buildings.geojson` 这一份数据同时驱动 `fill-extrusion` 渲染与遮挡桶网格。
// 到 D3-6 为止这件事是**按结构成立的**——两侧读同一个 URL、解析规则逐条对齐——但从来没有人
// 在跑起来的画面上核对过一遍。这里把它变成可验的：把屏幕上画出来的那些要素的属性，
// 与物理侧桶网格里的那些体块，按 id 逐个比。
//
// 三点口径：
//
//   · **比的是身份与高度，不是几何**。环的顶点在渲染侧是经纬度、在物理侧是投影后的平面米，
//     逐点比要把投影再算一遍，那等于拿被测件测自己。**顶点数也不能当判据**——实测两侧常差几个点
//     （13 对 18、17 对 18、5 对 6…），那不是数据不同，是 MapLibre 对 GeoJSON 源做瓦片化时
//     按 `tolerance` 简化并在瓦片边界切开的结果：顶点数是渲染的产物，不是这份数据的属性。
//     所以它只**报出来**（`ringPointsDiff`），不进 `ok`。D4-2 要核对的本来也就是 id / height_m / base_m。
//   · **`MultiPolygon` 在物理侧按子多边形拆开并给 id 加 `#k` 后缀**（`geojson.ts`），
//     渲染侧 MapLibre 给出的是整个要素。所以按 id 找不到时先剥掉后缀再找一次。
//   · **只在视窗内比**。物理侧有四万多栋，渲染侧只给当前画面里的那些；拿全量比会把
//     「没画出来」误判成「对不上」。

export interface RenderedBuilding {
  id: string
  height_m: number | null
  base_m: number | null
  /** 外环顶点数（GeoJSON 闭合点已去掉），对不上说明两侧读的不是同一份几何 */
  ringPoints: number | null
}

export interface PhysicalBuilding {
  id: string
  heightM: number
  baseM: number
  ringPoints: number
}

export interface SameSourceDiff {
  id: string
  field: string
  rendered: string
  physical: string
}

export interface SameSourceResult {
  /** 画面上取到的要素数 */
  rendered: number
  /** 其中在物理侧找得到对应体块的 */
  matched: number
  /** 画面上有、物理侧没有的（缺高度的要素会落在这里，那是**两侧同义**的情形，另计） */
  missingInPhysics: string[]
  /** 画面上有、物理侧没有，且渲染侧的高度也是缺或非正——这一类两侧同义，不算不一致 */
  agreedAbsent: string[]
  diffs: SameSourceDiff[]
  /** 顶点数对不上的件数。**只报不判**，理由见头注（MapLibre 的瓦片化简化） */
  ringPointsDiff: number
  ok: boolean
}

/** 物理侧 `MultiPolygon` 的 id 带 `#k` 后缀；按渲染侧的 id 归并回去。 */
function baseId(id: string): string {
  const i = id.indexOf('#')
  return i < 0 ? id : id.slice(0, i)
}

export function compareSameSource(
  rendered: RenderedBuilding[], physical: PhysicalBuilding[],
): SameSourceResult {
  const byId = new Map<string, PhysicalBuilding>()
  for (const p of physical) {
    // 同一个 MultiPolygon 拆出的几件高度相同，取第一件即可代表这个要素的高度
    const k = baseId(p.id)
    if (!byId.has(k)) byId.set(k, p)
  }
  const diffs: SameSourceDiff[] = []
  let ringPointsDiff = 0
  const missingInPhysics: string[] = []
  const agreedAbsent: string[] = []
  let matched = 0

  for (const r of rendered) {
    const p = byId.get(r.id)
    if (!p) {
      // 渲染侧高度缺或非正时，物理侧本来就该没有它——两侧同义（HEIGHT_FALLBACK_M = 0 保证屏幕上也看不见）
      if (r.height_m === null || !(r.height_m > 0)) agreedAbsent.push(r.id)
      else missingInPhysics.push(r.id)
      continue
    }
    matched++
    if (r.height_m !== p.heightM) {
      diffs.push({ id: r.id, field: 'height_m', rendered: String(r.height_m), physical: String(p.heightM) })
    }
    if ((r.base_m ?? 0) !== p.baseM) {
      diffs.push({ id: r.id, field: 'base_m', rendered: String(r.base_m ?? 0), physical: String(p.baseM) })
    }
    // MultiPolygon 的渲染侧顶点数是整个要素的，与拆出来的某一件本来就对不上，那种不计（id 带 # 即是）
    if (r.ringPoints !== null && !physicalIsPart(physical, r.id) && r.ringPoints !== p.ringPoints) ringPointsDiff++
  }
  return {
    rendered: rendered.length, matched, missingInPhysics, agreedAbsent, diffs, ringPointsDiff,
    // **比了零个不算通过**：`rendered === 0` 说明画面上还没有建筑（瓦片没到），
    // 这时候「没有不一致」是空话。2026-09-19 实测撞到过——同一个页面两次调用，
    // 一次 2738 个要素、一次 0 个，后者当时返回了 ok（D-076）。
    ok: rendered.length > 0 && diffs.length === 0 && missingInPhysics.length === 0,
  }
}

function physicalIsPart(physical: PhysicalBuilding[], id: string): boolean {
  const prefix = `${id}#`
  for (const p of physical) if (p.id.startsWith(prefix)) return true
  return false
}
