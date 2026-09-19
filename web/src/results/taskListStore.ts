// 任务列表的外部小 store（U-4，D-075；范式同 metricsStore）。
//
// **为什么不走主 reducer**：`task/record` 对 `record.task_id !== s.task.id` 的记录直接丢弃
// （reducer.ts 的守卫，那是对的——主状态只描述「当前任务」）。列表要的是别的任务，
// 所以自己持一份。这也是 D-049 ⑩「高频量不进主 store」的同一条路数。

import { useEffect } from 'react'
import { cancelTask, listTaskPage } from '../api/client.js'
import type { RunState, TaskRecord } from '../state/types.js'

export const PAGE_SIZE = 100
const POLL_MS = 2000
const TERMINAL = new Set<RunState>(['finished', 'failed', 'cancelled'])

export type TaskListStatus = 'idle' | 'loading' | 'ok' | 'error'

export interface TaskListState {
  tasks: TaskRecord[]
  total: number
  offset: number
  /** 选中的行；未选时为 null，界面右栏落到当前任务 */
  selected: string | null
  status: TaskListStatus
  error: string | null
  fetches: number
}

const initial = (): TaskListState => ({ tasks: [], total: 0, offset: 0, selected: null, status: 'idle', error: null, fetches: 0 })

let state: TaskListState = initial()
const subs = new Set<() => void>()

export const taskListStore = {
  get: (): TaskListState => state,
  patch(p: Partial<TaskListState>): void {
    let changed = false
    for (const k of Object.keys(p) as Array<keyof TaskListState>) if (!Object.is(state[k], p[k])) { changed = true; break }
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

/** 探针：行本身不进探针（一页 100 条会把它撑大），只出计数与状态。 */
export function probeTaskList(st: TaskListState) {
  return {
    status: st.status,
    total: st.total,
    offset: st.offset,
    shown: st.tasks.length,
    selected: st.selected,
    running: st.tasks.filter((t) => t.run_state === 'queued' || t.run_state === 'running').length,
    error: st.error,
  }
}

export async function loadPage(offset: number): Promise<void> {
  taskListStore.patch({ status: 'loading' })
  try {
    const p = await listTaskPage({ limit: PAGE_SIZE, offset })
    taskListStore.patch({
      tasks: p.tasks, total: p.total, offset: p.offset, status: 'ok', error: null,
      fetches: taskListStore.get().fetches + 1,
    })
  } catch (e) {
    taskListStore.patch({ status: 'error', error: String(e), fetches: taskListStore.get().fetches + 1 })
  }
}

/** 取消列表里的某一行。`stopTask` 只认当前任务且自带确认，这里按行来。 */
export async function cancelRow(taskId: string): Promise<void> {
  const r = await cancelTask(taskId)
  if ('record' in r) {
    const rec = r.record
    taskListStore.patch({ tasks: taskListStore.get().tasks.map((t) => (t.task_id === taskId ? rec : t)) })
  } else {
    taskListStore.patch({ error: `取消 ${taskId}：${r.message}` })
  }
}

/**
 * 驱动：任务页签可见时取一页；**只有本页里还有在跑的任务才接着轮询**——
 * 941 个任务一页 220 KB，没有在跑的东西还每 2 秒拉一次是白费。
 * 当前任务的状态变化（比如刚跑完）也当作一次刷新的由头。
 */
export function useTaskList(active: boolean, currentTaskId: string | null, currentRunState: RunState | null): void {
  useEffect(() => {
    if (!active) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      await loadPage(taskListStore.get().offset)
      if (!alive) return
      const live = taskListStore.get().tasks.some((t) => !TERMINAL.has(t.run_state))
      if (live) timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => { alive = false; if (timer !== null) clearTimeout(timer) }
  }, [active, currentTaskId, currentRunState])
}
