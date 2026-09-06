// 信号页自己的外部小 store（cursorStore 范式）：高频量与 Float32 结果不进主 store（09 附录 A.1）。
// 画布、读数栏、探针都从这里读；主 store 只存视窗、仪表设置与元信息。

import type { WindowMeta } from '../api/window.js'
import type { FetchKey, FetchStatus } from './fetcher.js'
import type { Extract } from './reduce.js'

export interface LastFetch {
  key: FetchKey
  spec: Extract
  env: Extract | null
  /** 索引里的结果四态（响应头 X-CUAV-State） */
  state: string
  meta: WindowMeta
}

export interface SignalViewState {
  mode: 'follow' | 'browse'
  /** 瀑布画布设备像素尺寸 */
  W: number
  H: number
  dpr: number
  lastFetch: LastFetch | null
  drawnRows: number
  hatchedRows: number
  fetchStatus: FetchStatus
  fetchDetail: string | null
  /** M1 自动峰值：bin、绝对频率、电平 */
  m1: { k: number; f: number; v: number } | null
  /** M2 在当前迹线上的电平 */
  m2Level: number | null
  hover: { f: number; t: number | null; v: number | null } | null
  /** 频谱与瀑布画布在页面里的左右边界（设备像素），供 e2e 断言两者对齐 */
  bounds: { spectrum: [number, number] | null; waterfall: [number, number] | null }
  /** 当前画面覆盖的时间窗（相对 t0_s）与频段（相对 center_Hz） */
  shown: { t0: number; t1: number; f0: number; f1: number } | null
  envRange: { lo: number; hi: number } | null
  /** 环里已收到的谱行数（页脚「已收 n 行」） */
  liveRows: number
  /** 跟随模式画过的帧数（探针用：证明实时绘制发生过） */
  liveFrames: number
}

const initial = (): SignalViewState => ({
  mode: 'follow', W: 0, H: 0, dpr: 1, lastFetch: null, drawnRows: 0, hatchedRows: 0, fetchStatus: 'idle', fetchDetail: null,
  m1: null, m2Level: null, hover: null, bounds: { spectrum: null, waterfall: null }, shown: null, envRange: null, liveRows: 0, liveFrames: 0,
})

let state: SignalViewState = initial()
const subs = new Set<() => void>()

export const viewStore = {
  get: (): SignalViewState => state,
  patch(p: Partial<SignalViewState>): void {
    let changed = false
    for (const k of Object.keys(p) as Array<keyof SignalViewState>) if (!Object.is(state[k], p[k])) { changed = true; break }
    if (!changed) return
    state = { ...state, ...p }
    for (const f of subs) f()
  },
  reset(): void {
    state = initial()
    for (const f of subs) f()
  },
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f) } },
}

/** 渲染器挂到这里的命令：导出与清除保持（给页脚按钮与 ?dev=1 钩子用），信号页没挂载时为 null。 */
export const signalHooks: {
  csv: (() => { name: string; text: string } | null) | null
  png: (() => Promise<{ name: string; blob: Blob } | null>) | null
  clearHold: (() => void) | null
} = { csv: null, png: null, clearHold: null }
