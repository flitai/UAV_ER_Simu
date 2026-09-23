// 时间轴的外部小 store（13 报告 §5.2，D-061）。与 cursorStore / sceneStore 同一范式：
// 拖动按指针频率写它，不进主 reducer——`signal/cursor` 走主 reducer 会让整棵界面树重渲染（D-048 ⑩ 的教训）。
//
// 时基：`t` 是引擎逻辑时间（与 task.t_s 同基，0 … duration_s）。信号页的游标是相对产品起点 `index.t0_s` 的秒数，
// 换算 `cursor = t − t0_s`，在 shell/timelineOps.ts 里做。
//
// 模式：live = 地图与卡片显示每键最新一帧（今天的行为）；replay = 按 `t` 从历史里取快照。
// 任何拖动 / 播放进 replay；勾「跟随」或新任务开始回 live。

export type TimeMode = 'live' | 'replay'
export type TimeSpeed = 1 | 2 | 5

export interface TimeState {
  t: number | null
  mode: TimeMode
  playing: boolean
  speed: TimeSpeed
}

let state: TimeState = { t: null, mode: 'live', playing: false, speed: 1 }
const subs = new Set<() => void>()

function notify(): void {
  for (const f of subs) f()
}

export const timeStore = {
  get: () => state,
  subscribe(f: () => void) {
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  },
  set(patch: Partial<TimeState>) {
    const next = { ...state, ...patch }
    if (next.t === state.t && next.mode === state.mode && next.playing === state.playing && next.speed === state.speed) return
    state = next
    notify()
  },
  /** 新任务开始 / 换任务：回到跟随。 */
  reset() {
    state = { t: null, mode: 'live', playing: false, speed: state.speed }
    notify()
  },
}
