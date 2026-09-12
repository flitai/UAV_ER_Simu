// 时间轴的命令与换算（13 报告 §5，D-061）。不依赖 React，单测可直接调。
//
// 两个时基：时间轴的 `t` 是引擎逻辑时间；信号页游标相对产品起点 `index.t0_s`。
// 同步规则：时间轴改 t → 一次 `signal/cursor`（t − t0_s）；信号页改游标（键、点击）→ 时间轴跟到 t0_s + cursor。
// 防回环靠比较数值：时间轴自己写出去的游标换算回来与 t 相等（容差 1e-6），不再写回。

import type { Action, AppState } from '../state/types.js'
import { timeStore } from './timeStore.js'
import { activities } from '../scene/editor/scenarioOps.js'

export interface StoreLike { getState(): AppState; dispatch(a: Action): void }

export const CURSOR_EPS = 1e-6

/** 产品起点在逻辑时间轴上的位置；没有索引按 0（合成链的 S 观测点都从 0 起）。 */
export function productT0(s: AppState): number {
  return s.signal.index?.t0_s ?? 0
}

/** 时间轴的总长：有任务用任务时长，否则用场景时长（未运行也能拖着看航线预览）。 */
export function timelineDuration(s: AppState): number {
  if (s.task.duration_s > 0) return s.task.duration_s
  const time = s.scene.scenario.doc?.time as { duration_s?: unknown } | undefined
  return typeof time?.duration_s === 'number' && time.duration_s > 0 ? time.duration_s : 0
}

export function clampT(t: number, duration: number): number {
  if (!Number.isFinite(t)) return 0
  return Math.min(Math.max(t, 0), duration > 0 ? duration : t)
}

/**
 * 跳到逻辑时刻 t：进回放；`syncSignal` 为真时同步信号页游标（拖动中节流的那一路传 false，松手时传 true）。
 */
export function seekTo(store: StoreLike, t: number, syncSignal: boolean): void {
  const s = store.getState()
  const tt = clampT(t, timelineDuration(s))
  timeStore.set({ t: tt, mode: 'replay' })
  if (syncSignal) syncSignalCursor(store, tt)
}

/** 把时间轴时刻写到信号页游标（跟随模式先转回看，与 stepCursor 同理由）。 */
export function syncSignalCursor(store: StoreLike, t: number): void {
  const s = store.getState()
  const cur = s.signal.cursor_t_s
  const want = t - productT0(s)
  if (cur !== null && Math.abs(cur - want) <= CURSOR_EPS) return
  if (s.signal.follow) store.dispatch({ type: 'signal/follow', on: false })
  store.dispatch({ type: 'signal/cursor', t_s: want })
}

/** 信号页游标变了（键、点击）：时间轴跟过去。返回是否真的动了。 */
export function followSignalCursor(store: StoreLike): boolean {
  const s = store.getState()
  const cur = s.signal.cursor_t_s
  if (cur === null) return false
  const t = productT0(s) + cur
  const ts = timeStore.get()
  if (ts.t !== null && Math.abs(ts.t - t) <= CURSOR_EPS && ts.mode === 'replay') return false
  timeStore.set({ t: clampT(t, timelineDuration(s)), mode: 'replay', playing: false })
  return true
}

/** 回到跟随实时：时间轴与信号页一起。 */
export function goLive(store: StoreLike): void {
  timeStore.set({ t: null, mode: 'live', playing: false })
  if (!store.getState().signal.follow) store.dispatch({ type: 'signal/follow', on: true })
}

/** 播放 / 暂停。从 live 按播放 = 从头回放。 */
export function togglePlay(store: StoreLike): void {
  const ts = timeStore.get()
  if (ts.playing) { timeStore.set({ playing: false }); syncSignalCursor(store, ts.t ?? 0); return }
  const s = store.getState()
  const dur = timelineDuration(s)
  if (dur <= 0) return
  const start = ts.mode === 'replay' && ts.t !== null && ts.t < dur - CURSOR_EPS ? ts.t : 0
  timeStore.set({ t: start, mode: 'replay', playing: true })
}

/** 播放推进一步：返回是否到头。 */
export function advance(store: StoreLike, dtWall_s: number): boolean {
  const ts = timeStore.get()
  if (!ts.playing || ts.t === null) return false
  const dur = timelineDuration(store.getState())
  const next = ts.t + dtWall_s * ts.speed
  if (dur > 0 && next >= dur) {
    timeStore.set({ t: dur, playing: false })
    syncSignalCursor(store, dur)
    return true
  }
  timeStore.set({ t: next })
  return false
}

/** 时间轴上列出的活动标记：有 t_s 且落在时长以内（任务比场景短时，之后的活动不在这次运行里）。 */
export function timelineMarkers(s: AppState): Array<{ t_s: number; event: string; emitter_id: string }> {
  const dur = timelineDuration(s)
  const out: Array<{ t_s: number; event: string; emitter_id: string }> = []
  for (const a of activities(s.scene.scenario.doc)) {
    if (typeof a.t_s !== 'number') continue
    if (dur > 0 && a.t_s > dur) continue
    out.push({ t_s: a.t_s, event: String(a.event), emitter_id: String(a.emitter_id) })
  }
  return out
}

/** 活动标记的字形（13 §5.1）。 */
export const ACTIVITY_GLYPH: Record<string, string> = {
  takeoff: '▲', cruise: '▶', hover: '◆', land: '▼', tx_on: '●', tx_off: '○', hop: '⇅',
}
