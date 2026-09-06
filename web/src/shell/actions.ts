// 非 React 的命令：开页面引导、运行、停止（09 附录 A.2 数据流）。

import { cancelTask, createTask, getComponents, getEvents, getHealth, listTasks } from '../api/client.js'
import { idempotencyKey } from '../api/hash.js'
import { listScenes, loadScene } from '../scene/scenePackage.js'
import { TERMINAL } from '../state/reducer.js'
import type { StoreApi } from '../state/store.js'
import type { TaskRecord } from '../state/types.js'
import { signalBuffer } from '../signal/buffer.js'

export async function bootstrap(store: StoreApi, alive: () => boolean): Promise<void> {
  const { dispatch } = store
  const jobs: Promise<void>[] = []
  jobs.push((async () => {
    try {
      const h = await getHealth()
      if (alive()) dispatch({ type: 'server/health', version: h.version ?? null, engineAvailable: h.engine?.available ?? null })
    } catch { if (alive()) dispatch({ type: 'server/health', version: null, engineAvailable: null }) }
  })())
  jobs.push((async () => {
    try {
      const want = new URLSearchParams(location.search).get('aoi')
      const ids = await listScenes()
      if (ids.length === 0) throw new Error('服务端没有任何场景数据包，先跑 scene/ 下的建库脚本')
      const id = want && ids.includes(want) ? want : ids[0]!
      const summary = await loadScene(id)
      if (alive()) dispatch({ type: 'scene/loaded', summary })
    } catch (e) { if (alive()) dispatch({ type: 'scene/error', message: String(e) }) }
  })())
  jobs.push((async () => {
    try {
      const c = await getComponents()
      if (!alive()) return
      if (c.ok) dispatch({ type: 'components/loaded', catalog: c.catalog })
      else dispatch({ type: 'components/unavailable' })
    } catch { if (alive()) dispatch({ type: 'components/unavailable' }) }
  })())
  jobs.push((async () => {
    try {
      const tasks = await listTasks(1)
      if (!alive() || tasks.length === 0) return
      await adoptTask(store, tasks[0]!, alive)
    } catch (e) { if (alive()) dispatch({ type: 'log/client', level: 'warn', message: `恢复最近任务失败：${(e as Error).message}` }) }
  })())
  await Promise.all(jobs)
}

/** 采用一个已有任务：已结束的先补首尾两条事件（时长与最终逻辑时间），再以 since = last_seq 订阅。 */
export async function adoptTask(store: StoreApi, rec: TaskRecord, alive: () => boolean): Promise<void> {
  const { dispatch } = store
  signalBuffer.reset(rec.task_id)
  dispatch({ type: 'task/adopt', record: rec })
  if (TERMINAL.has(rec.run_state) && rec.last_seq > 0) {
    try {
      const first = await getEvents(rec.task_id, 0, 1)
      const last = rec.last_seq > 1 ? await getEvents(rec.task_id, rec.last_seq - 1, 1) : { events: [] }
      if (!alive() || store.getState().task.id !== rec.task_id) return
      const wall = performance.now()
      const evs = [...first.events, ...last.events].filter((e) => e.type === 'task.state')
      if (evs.length) dispatch({ type: 'stream/batch', events: evs.map((e) => ({ ...e })), wallMs: wall, silent: true })
      // 上面折叠的结束事件会推进 lastSeq；订阅仍按记录里的 last_seq
    } catch { /* 拿不到就只显示记录里的信息 */ }
  }
}

export async function runDiagram(store: StoreApi): Promise<void> {
  const { dispatch, getState } = store
  const s = getState()
  if (s.task.runState === 'queued' || s.task.runState === 'running') return
  if (s.diagram.parseError || !s.diagram.json) {
    dispatch({ type: 'diagram/validation', ok: false, errors: [{ code: 'json_parse', node_id: '', port: '', message: s.diagram.parseError ?? '框图为空' }] })
    dispatch({ type: 'ui/navigate', view: 'diagram' })
    return
  }
  if (s.components.status !== 'ok') {
    dispatch({ type: 'ui/toast', kind: 'error', text: '组件目录不可用（引擎未就绪），不能运行', sticky: true })
    return
  }
  const text = s.diagram.text
  let r
  try {
    r = await createTask(text, await idempotencyKey(text))
  } catch (e) {
    dispatch({ type: 'ui/toast', kind: 'error', text: `提交失败：${(e as Error).message}`, sticky: true })
    return
  }
  if (r.status === 201 || r.status === 200) {
    const rec = (r as { record: TaskRecord }).record
    signalBuffer.reset(rec.task_id)
    dispatch({ type: 'task/created', record: rec })
    dispatch({ type: 'diagram/validation', ok: true, errors: [] })
    dispatch({ type: 'diagram/markSaved' })
    return
  }
  if (r.status === 400) {
    const err = (r as { error: { code: string; node_id: string; port: string; message: string } }).error
    dispatch({ type: 'diagram/validation', ok: false, errors: [err] })
    dispatch({ type: 'ui/toast', kind: 'error', text: `框图校验未通过：${err.code}${err.node_id ? ` @ ${err.node_id}` : ''}`, sticky: true })
    dispatch({ type: 'ui/navigate', view: 'diagram' })
    return
  }
  if (r.status === 503) dispatch({ type: 'components/unavailable' })
  dispatch({ type: 'ui/toast', kind: 'error', text: `提交失败：${(r as { message: string }).message}`, sticky: true })
}

export async function stopTask(store: StoreApi): Promise<void> {
  const { dispatch, getState } = store
  const id = getState().task.id
  if (!id) return
  if (!window.confirm(`停止任务 ${id}？已产出的结果保留，结果态记为「不适用」。`)) return
  try {
    const r = await cancelTask(id)
    if (r.status === 200) dispatch({ type: 'task/record', record: (r as { record: TaskRecord }).record })
    else dispatch({ type: 'ui/toast', kind: 'warn', text: `取消未成功：${(r as { message: string }).message}` })
  } catch (e) {
    dispatch({ type: 'ui/toast', kind: 'error', text: `取消失败：${(e as Error).message}` })
  }
}
