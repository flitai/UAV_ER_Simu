import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer } from '../state/reducer.js'
import type { Action, AppState, ProductIndex } from '../state/types.js'
import { deleteMarker, placeMarker, stepCursor } from './commands.js'
import { viewStore } from './viewStore.js'

function makeStore(): { getState(): AppState; dispatch(a: Action): void; actions: Action[] } {
  let s = initialState(false, 1920, '')
  const actions: Action[] = []
  return { getState: () => s, dispatch: (a) => { actions.push(a); s = reducer(s, a) }, actions }
}
const idx: ProductIndex = { kind: 'spectrum', op_id: 's4', row_len: 1024, rows: 10, sample_rate_Hz: 1e6, center_Hz: 2.44e9, bin_width_Hz: 976.5625, frame_hop_samples: 1024, t0_s: 0, nfft: 1024, window: 'hann', scale: 'dBm', calibration: { offset_dB: 0, source: 'model' }, state: 'valid', state_reasons: [], rows_available: 1000, index_final: false, run_state: 'running' }

test('placeMarker：优先悬停频率，其次 M1；都没有则不动', () => {
  viewStore.reset()
  const st = makeStore()
  assert.equal(placeMarker(st), false)
  viewStore.patch({ m1: { k: 614, f: 2.4401e9, v: -70 } })
  assert.equal(placeMarker(st), true)
  assert.equal(st.getState().signal.markers.find((m) => m.id === 'M2')?.freq_Hz, 2.4401e9)
  viewStore.patch({ hover: { f: 2.4405e9, t: null, v: null } })
  placeMarker(st)
  assert.equal(st.getState().signal.markers.find((m) => m.id === 'M2')?.freq_Hz, 2.4405e9)
  deleteMarker(st)
  assert.equal(st.getState().signal.markers.length, 1)
  viewStore.reset()
})

test('stepCursor：跟随模式先按当前画面转回看，再按 dt 步进', () => {
  viewStore.reset()
  const st = makeStore()
  st.dispatch({ type: 'signal/index', opId: 's4', index: idx })
  assert.equal(stepCursor(st, -1, false), false)            // 还没画面
  viewStore.patch({ shown: { t0: 0.5, t1: 1.0, f0: -5e5, f1: 5e5 } })
  assert.equal(stepCursor(st, -1, false), true)
  const s = st.getState()
  assert.equal(s.signal.follow, false)
  assert.ok(Math.abs(s.signal.viewport.t0 - 0.5) < 1e-12 && Math.abs(s.signal.viewport.t1 - 1.0) < 1e-12)
  const dt = 1024 / 1e6
  assert.ok(Math.abs(s.signal.cursor_t_s! - (Math.round((1.0 - dt) / dt - 1) * dt)) < 1e-9)
  stepCursor(st, 1, true)
  assert.ok(st.getState().signal.cursor_t_s! <= 1.0 - dt + 1e-12)
  viewStore.reset()
})
