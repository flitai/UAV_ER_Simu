// 时间轴命令与两个时基的换算（V-3，D-061；13 报告 §5.2）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer } from '../state/reducer.js'
import type { Action, AppState, ProductIndex } from '../state/types.js'
import { timeStore } from './timeStore.js'
import { advance, followSignalCursor, goLive, seekTo, syncSignalCursor, timelineDuration, timelineMarkers, togglePlay } from './timelineOps.js'

function mkStore(mutate?: (s: AppState) => AppState) {
  let state = initialState(false, 2560, '')
  if (mutate) state = mutate(state)
  const dispatched: Action[] = []
  return {
    getState: () => state,
    dispatch: (a: Action) => { dispatched.push(a); state = reducer(state, a) },
    dispatched,
  }
}
const withTask = (dur: number, t0 = 0) => (s: AppState): AppState => ({
  ...s,
  task: { ...s.task, id: 't1', duration_s: dur, runState: 'finished' },
  signal: { ...s.signal, index: { t0_s: t0, rows: 10, row_len: 8, sample_rate_Hz: 1, center_Hz: 0, frame_hop_samples: 1, nfft: 8, bin_width_Hz: 1 } as unknown as ProductIndex },
})

test('seekTo 进回放并夹到时长内；同步信号游标时换算 t − t0_s 并转回看', () => {
  timeStore.reset()
  const st = mkStore(withTask(120, 2))
  seekTo(st, 200, true)
  assert.equal(timeStore.get().mode, 'replay')
  assert.equal(timeStore.get().t, 120)
  assert.equal(st.getState().signal.follow, false)
  assert.equal(st.getState().signal.cursor_t_s, 118)
  seekTo(st, -5, false)
  assert.equal(timeStore.get().t, 0)
  assert.equal(st.getState().signal.cursor_t_s, 118, '不同步那一路不动游标')
})

test('信号页改游标 → 时间轴跟到 t0_s + cursor；时间轴自己写的游标换算回来不再写回（防回环）', () => {
  timeStore.reset()
  const st = mkStore(withTask(120, 2))
  st.dispatch({ type: 'signal/cursor', t_s: 10 })
  assert.equal(followSignalCursor(st), true)
  assert.equal(timeStore.get().t, 12)
  assert.equal(followSignalCursor(st), false, '同一值不再动')
  syncSignalCursor(st, 12)
  assert.equal(st.dispatched.filter((a) => a.type === 'signal/cursor').length, 1, '数值相等不重复 dispatch')
})

test('播放：从 live 按播放从头回放，按倍速推进，到头停下并同步游标；goLive 两边一起回跟随', () => {
  timeStore.reset()
  const st = mkStore(withTask(10))
  togglePlay(st)
  assert.deepEqual([timeStore.get().mode, timeStore.get().t, timeStore.get().playing], ['replay', 0, true])
  timeStore.set({ speed: 5 })
  assert.equal(advance(st, 1), false)
  assert.equal(timeStore.get().t, 5)
  assert.equal(advance(st, 1.2), true, '到头')
  assert.equal(timeStore.get().t, 10)
  assert.equal(timeStore.get().playing, false)
  assert.equal(st.getState().signal.cursor_t_s, 10)
  goLive(st)
  assert.deepEqual([timeStore.get().mode, timeStore.get().t], ['live', null])
  assert.equal(st.getState().signal.follow, true)
})

test('没有任务时时长取场景 time.duration_s，有任务取任务时长', () => {
  const s0 = mkStore((s) => ({ ...s, scene: { ...s.scene, scenario: { ...s.scene.scenario, doc: { time: { duration_s: 90 } } } } }))
  assert.equal(timelineDuration(s0.getState()), 90)
  assert.equal(timelineDuration(mkStore(withTask(20)).getState()), 20)
  assert.equal(timelineDuration(mkStore().getState()), 0)
  timeStore.reset()
})

test('活动标记只列时长以内的：任务 70 s 时场景里 70 s 之后的活动不进时间轴', () => {
  const doc = { time: { duration_s: 120 }, activities: [
    { t_s: 5, event: 'takeoff', emitter_id: 'a' }, { t_s: 60, event: 'tx_on', emitter_id: 'a' }, { t_s: 100, event: 'land', emitter_id: 'a' }, { event: 'hop', emitter_id: 'a' },
  ] }
  const noTask = mkStore((s) => ({ ...s, scene: { ...s.scene, scenario: { ...s.scene.scenario, doc } } }))
  assert.deepEqual(timelineMarkers(noTask.getState()).map((m) => m.t_s), [5, 60, 100])
  const task70 = mkStore((s) => withTask(70)({ ...s, scene: { ...s.scene, scenario: { ...s.scene.scenario, doc } } }))
  assert.deepEqual(timelineMarkers(task70.getState()).map((m) => m.event), ['takeoff', 'tx_on'])
})
