// 时间轴命令与两个时基的换算（V-3，D-061；13 报告 §5.2）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer } from '../state/reducer.js'
import type { Action, AppState, ProductIndex } from '../state/types.js'
import { timeStore } from './timeStore.js'
import { advance, followSignalCursor, goLive, keepCursorInWindow, seekTo, syncSignalCursor, timelineDuration, timelineMarkers, togglePlay } from './timelineOps.js'

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

// ---- 2026-09-13：播放同步与窗口跟随（用户实测「播放时频谱与瀑布不动，只有时间游标在走」）----

const withRows = (dur: number, rows: number) => (s: AppState): AppState => ({
  ...s,
  task: { ...s.task, id: 't2', duration_s: dur, runState: 'finished' },
  signal: {
    ...s.signal,
    index: { t0_s: 0, rows, rows_available: rows, row_len: 8, sample_rate_Hz: 1, center_Hz: 0, frame_hop_samples: 1, nfft: 8, bin_width_Hz: 1 } as unknown as ProductIndex,
    viewport: { t0: 8, t1: 10, f0: -4, f1: 4, stat: 'max' },
  },
})

test('播放中每 0.1 s 墙钟同步一次信号游标；自己写出去的游标回来不会把播放拉停', () => {
  timeStore.reset()
  const st = mkStore(withRows(10, 10))
  timeStore.set({ speed: 1 })                      // reset() 保留倍速，上一个用例设过 5
  togglePlay(st)
  const cursors = () => st.dispatched.filter((a) => a.type === 'signal/cursor').map((a) => (a as { t_s: number }).t_s)
  assert.deepEqual(cursors(), [0], '按播放先把起点写给信号页')
  advance(st, 0.05)
  assert.deepEqual(cursors(), [0], '不到 0.1 s 不写')
  advance(st, 0.05)
  assert.equal(cursors().length, 2)
  assert.ok(Math.abs(cursors()[1]! - 0.1) < 1e-9, '攒够 0.1 s 写一次，值 = 当前 t − t0_s')
  // React 效应里时间轴会看到这次游标变化；此时 t 可能已经继续走，不能当作「信号页改了游标」
  advance(st, 0.03)
  assert.equal(followSignalCursor(st), false, '自写的游标不回写时间轴')
  assert.equal(timeStore.get().playing, true, '播放没有被拉停')
  assert.ok(Math.abs(timeStore.get().t! - 0.13) < 1e-9)
  // 信号页真的改了游标（键 / 点击）仍然跟过去
  st.dispatch({ type: 'signal/cursor', t_s: 3 })
  assert.equal(followSignalCursor(st), true)
  assert.equal(timeStore.get().t, 3)
  timeStore.set({ playing: false })
  // 回声只认一次：Home 写过 0、跟随清掉游标之后，用户按 → 得到 0 必须跟过去（slice8 实测）
  seekTo(st, 0, true)
  goLive(st)
  st.dispatch({ type: 'signal/cursor', t_s: 0 })
  assert.equal(followSignalCursor(st), true, '清过游标后同一个值不再当回声')
  assert.deepEqual([timeStore.get().mode, timeStore.get().t], ['replay', 0])
})

test('游标出了回看窗口就平移窗口：前进落在窗底 1/4、后退落在窗顶 1/4，跨度不变，夹在数据范围内', () => {
  timeStore.reset()
  const st = mkStore(withRows(10, 10))            // 数据 [0, 10]，窗口 [8, 10]，跨度 2
  const vp = () => st.getState().signal.viewport
  seekTo(st, 9, true)                              // 在窗内：窗口不动
  assert.deepEqual([vp().t0, vp().t1], [8, 10])
  seekTo(st, 2, true)                              // 后退出窗：游标在窗顶 1/4 → [0.5, 2.5]
  assert.ok(Math.abs(vp().t0 - 0.5) < 1e-9 && Math.abs(vp().t1 - 2.5) < 1e-9, `${vp().t0}–${vp().t1}`)
  seekTo(st, 6, true)                              // 前进出窗：游标在窗底 1/4 → [5.5, 7.5]
  assert.ok(Math.abs(vp().t0 - 5.5) < 1e-9 && Math.abs(vp().t1 - 7.5) < 1e-9, `${vp().t0}–${vp().t1}`)
  seekTo(st, 9.8, true)                            // 顶到数据末尾：窗口贴到 [8, 10]
  assert.deepEqual([vp().t0, vp().t1], [8, 10])
  seekTo(st, 0, true)                              // 顶到数据起点：窗口贴到 [0, 2]
  assert.deepEqual([vp().t0, vp().t1], [0, 2])
  assert.equal(st.getState().signal.follow, false)
  // 没有索引（没有产品几何）时不动窗口
  const bare = mkStore(withTask(10))
  keepCursorInWindow(bare, 5)
  assert.equal(bare.dispatched.filter((a) => a.type === 'signal/viewport').length, 0)
})
