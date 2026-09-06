// 信号页的键盘命令（U-3，09 §11）：放 / 删 M2、时间游标步进。不依赖 React，单测可直接调。

import type { Action, AppState } from '../state/types.js'
import { viewStore } from './viewStore.js'
import { cursorStep, spectrumGeomOf } from './viewport.js'

export interface StoreLike { getState(): AppState; dispatch(a: Action): void }

/** `M`：在悬停频率处放 M2；没有悬停就放在 M1（峰值）处。 */
export function placeMarker(store: StoreLike): boolean {
  const v = viewStore.get()
  const f = v.hover?.f ?? v.m1?.f ?? null
  if (f === null) return false
  store.dispatch({ type: 'signal/marker', id: 'M2', freq_Hz: f })
  return true
}

export function deleteMarker(store: StoreLike): void {
  store.dispatch({ type: 'signal/marker', id: 'M2', freq_Hz: null })
}

/** `←/→`：时间游标一帧（Shift 十帧）。跟随模式先以当前画面为窗口转回看。 */
export function stepCursor(store: StoreLike, dir: -1 | 1, times10: boolean): boolean {
  const s = store.getState()
  const geom = s.signal.index ? spectrumGeomOf(s.signal.index) : null
  if (!geom) return false
  const shown = viewStore.get().shown
  let win = { t0: s.signal.viewport.t0, t1: s.signal.viewport.t1 }
  if (s.signal.follow) {
    if (!shown) return false
    store.dispatch({ type: 'signal/viewport', viewport: { t0: shown.t0, t1: shown.t1, f0: shown.f0, f1: shown.f1 } })
    win = { t0: shown.t0, t1: shown.t1 }
  } else if (shown) {
    win = { t0: shown.t0, t1: shown.t1 }
  }
  const t = cursorStep(s.signal.cursor_t_s, dir, times10, geom.dt, win)
  store.dispatch({ type: 'signal/cursor', t_s: t })
  return true
}
