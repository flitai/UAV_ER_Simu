// 建筑几何的**懒加载**小 store（D3-6，D-074；范式同 scene/sceneStore.ts）。
//
// **为什么必须懒**：`buildings.geojson` 是 15.9 MB，实测浏览器 `JSON.parse` 要 72 ms、
// 堆涨 41 MB（07 报告 §2.3）。场景页平时用不到它——MapLibre 渲染那份是在 worker 里另外拉的，
// 那是私有结构，**不复用**（拿它等于把渲染实现细节焊进物理，铁律 11 要的是同一份**数据**
// 而不是同一份内存）。所以只有真的要算遮挡（点选探测、覆盖场）才取。
//
// **不进主 store**：主 store 的 reducer 每次更新都会触发整棵界面树重渲染，
// 而这里装的是几万栋楼的 Float64Array。与 sceneStore / cursorStore 同一条理由。

import { LocalSceneAdapter } from './adapter.js'
import { SceneFrame } from './frame.js'
import { parseBuildings, summarize, type BuildingsStats } from './geojson.js'

export interface OcclusionState {
  /** 'idle' 从没取过 | 'loading' 正在取 | 'ready' 可用 | 'error' 取失败 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  stats: BuildingsStats | null
  /** 取 + 解析 + 建桶网格的墙钟毫秒，供探针核对「懒加载没白懒」 */
  ms: number
  error: string | null
  /**
   * 实际取的那个地址（D4，D-076）。同源这件事要**验得出来**而不只是声明：
   * 端到端拿它与 `fill-extrusion` 数据源的 `data` 逐字比，两者相同才算一份文件驱动两边。
   */
  url: string | null
}

let state: OcclusionState = { status: 'idle', stats: null, ms: 0, error: null, url: null }
let adapter: LocalSceneAdapter | null = null
let frame: SceneFrame | null = null
let inflight: Promise<LocalSceneAdapter | null> | null = null
const listeners = new Set<() => void>()

function emit(): void { for (const fn of listeners) fn() }

export function subscribeOcclusion(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function occlusionState(): OcclusionState { return state }
/** 已经加载好的适配器；没加载过返回 null（**不会顺手去加载**，那是 ensure 的事）。 */
export function occlusionMap(): LocalSceneAdapter | null { return adapter }
export function occlusionFrame(): SceneFrame | null { return frame }

/**
 * 取建筑几何并建索引。重复调用只做一次；已经好了就直接返回。
 *
 * `originLon / originLat` 取观测区域清单的 `aoi.center`——**必须与引擎那边同一个原点**
 * （C++ 走 `aoi_buildings_ref()` 读的也是它），否则整份建筑集相对视线平移且不报警。
 */
export function ensureOcclusion(
  url: string, originLon: number, originLat: number,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalSceneAdapter | null> {
  if (adapter) return Promise.resolve(adapter)
  if (inflight) return inflight

  state = { status: 'loading', stats: null, ms: 0, error: null, url }
  emit()
  const t0 = Date.now()
  const f = new SceneFrame(originLon, originLat)

  inflight = fetchImpl(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    })
    .then((doc: unknown) => {
      const { buildings, stats } = parseBuildings(doc, f)
      const a = new LocalSceneAdapter()
      a.setBuildings(buildings)
      // 适配器自己也会剔退化件；两边口径一致时它应当为零，不为零就并进计数（铁律 15）
      stats.droppedDegenerate += a.droppedCount()
      stats.buildings = a.buildingCount()
      adapter = a
      frame = f
      state = { status: 'ready', stats, ms: Date.now() - t0, error: null, url }
      emit()
      return a
    })
    .catch((e: unknown) => {
      state = {
        status: 'error', stats: null, ms: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e), url,
      }
      emit()
      return null
    })
    .finally(() => { inflight = null })

  return inflight
}

/** 探针用的一行人话。没加载过就说没加载过，不编。 */
export function occlusionNote(): string {
  if (state.status === 'idle') return '未加载'
  if (state.status === 'loading') return '加载中'
  if (state.status === 'error') return `加载失败：${state.error ?? ''}`
  return `${summarize(state.stats!)}，${state.ms} ms`
}

/** 只给单测用：把 store 清回从没取过的状态。 */
export function resetOcclusionForTest(): void {
  state = { status: 'idle', stats: null, ms: 0, error: null, url: null }
  adapter = null
  frame = null
  inflight = null
}
