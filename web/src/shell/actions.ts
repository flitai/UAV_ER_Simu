// 非 React 的命令：开页面引导、运行、停止（09 附录 A.2 数据流）。

import {
  listDiagrams, getDiagram, putDiagram, putScenario, cancelTask, createTask, getComponents, getEvents, getHealth, getScenario, listScenarios, listTasks } from '../api/client.js'
import { idempotencyKey } from '../api/hash.js'
import { listScenes, loadScene } from '../scene/scenePackage.js'
import { TERMINAL } from '../state/reducer.js'
import type { StoreApi } from '../state/store.js'
import type { ScenarioSummary, TaskRecord } from '../state/types.js'
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
    // 场景与最近任务是**一个**作业：先采用最近任务（它带着自己的场景），再决定缺省场景。
    // 原来两路并发、场景恒取清单第一项，刷新后就会出现「任务是 demo-03、场景页是 demo-01」，
    // 地图上只剩 site-1 的测向线（13 报告 §6.1，D-061）。
    // 地址栏 `?scenario=` 点名要开哪个场景（与 `?aoi=` 同法）：优先于最近任务的场景，
    // 演示时可以直接把人带到某个场景，端到端也靠它不受盘上任务历史影响。
    const want = new URLSearchParams(location.search).get('scenario')
    let list: ScenarioSummary[] = []
    try {
      list = await listScenarios()
      if (!alive()) return
      dispatch({ type: 'scene/scenarioList', list })
    } catch (e) { if (alive()) dispatch({ type: 'scene/scenarioError', message: String((e as Error).message ?? e) }) }
    const wanted = want && list.some((x) => x.scenario_id === want) ? want : null
    try {
      const tasks = await listTasks(1)
      if (alive() && tasks.length) await adoptTask(store, tasks[0]!, alive, { loadScenario: !wanted })
    } catch (e) { if (alive()) dispatch({ type: 'log/client', level: 'warn', message: `恢复最近任务失败：${(e as Error).message}` }) }
    if (!alive()) return
    if (wanted) await loadScenarioInto(store, wanted, alive)
    if (!alive()) return
    // 没有任务、旧记录没有 scenario_id、或它的场景已不存在：退到清单第一项
    if (store.getState().scene.scenario.status !== 'ok' && list.length) await loadScenarioInto(store, list[0]!.scenario_id, alive)
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
    // 载入最近保存的框图（C-6 / C-7）。没有保存过就保持 App.tsx 给的内置缺省典型链路——
    // 这里不 dispatch，静默留用缺省，而不是弹一条「没找到框图」的提示。
    try {
      const list = await listDiagrams()
      if (!alive() || list.length === 0) return
      const newest = [...list].sort((a, b) => b.modified_utc.localeCompare(a.modified_utc))[0]!
      const got = await getDiagram(newest.diagram_id)
      if (!alive() || !got) return
      dispatch({ type: 'diagram/loadExample', text: got.text })
    } catch (e) {
      if (alive()) dispatch({ type: 'log/client', level: 'warn', message: `读取已保存框图失败：${(e as Error).message}` })
    }
  })())
  await Promise.all(jobs)
}

/** 载入一个场景到 store：读全文与**落盘字节**的哈希，后者写进框图 scenario_ref 用。 */
export async function loadScenarioInto(store: StoreApi, id: string, alive: () => boolean): Promise<void> {
  const { dispatch } = store
  dispatch({ type: 'scene/scenarioLoading', id })
  try {
    const r = await getScenario(id)
    if (!alive()) return
    if (!r) { dispatch({ type: 'scene/scenarioError', message: `没有场景 ${id}` }); return }
    dispatch({ type: 'scene/scenarioLoaded', id, doc: r.doc, sha256: r.sha256 })
  } catch (e) {
    if (alive()) dispatch({ type: 'scene/scenarioError', message: String((e as Error).message ?? e) })
  }
}

/** 采用一个已有任务：已结束的先补首尾两条事件（时长与最终逻辑时间），再以 since = last_seq 订阅。 */
export async function adoptTask(
  store: StoreApi, rec: TaskRecord, alive: () => boolean, opts: { loadScenario?: boolean } = {},
): Promise<void> {
  const { dispatch } = store
  signalBuffer.reset(rec.task_id)
  dispatch({ type: 'task/adopt', record: rec })
  // 任务带着自己的场景（D-061，13 报告 §6.1）：与场景页当前载入的不同就换过来。
  // 旧 task.json 没有这个键则不动，缺省场景由 bootstrap 决定；场景已不存在会落成 scenarioError，同样由它回退。
  if (opts.loadScenario !== false && rec.scenario_id && store.getState().scene.scenario.id !== rec.scenario_id) {
    await loadScenarioInto(store, rec.scenario_id, alive)
    if (!alive()) return
  }
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

/**
 * 保存框图到服务端（C-6 的端点，D-051）。此前 `Ctrl+S` 只标记本页，刷新即丢。
 * 服务端只做最小检查、语义交引擎，所以校验失败的框图存不进去——错误照 `runDiagram` 的路数
 * 落到画面上，而不是弹一句「保存失败」就完了。
 */
export async function saveDiagram(store: StoreApi): Promise<void> {
  const { dispatch, getState } = store
  const s = getState()
  const id = s.context.diagramId
  if (!id) {
    dispatch({ type: 'ui/toast', kind: 'error', text: '框图没有标识，存不了' })
    return
  }
  let r
  try {
    r = await putDiagram(id, s.diagram.text)
  } catch (e) {
    dispatch({ type: 'ui/toast', kind: 'error', text: `保存失败：${(e as Error).message}`, sticky: true })
    return
  }
  if (r.ok) {
    dispatch({ type: 'diagram/markSaved' })
    dispatch({ type: 'diagram/validation', ok: true, errors: [] })
    for (const w of r.warnings) dispatch({ type: 'ui/toast', kind: 'warn', text: w })
    dispatch({ type: 'ui/toast', kind: 'info', text: `已保存 ${id}（${r.bytes} 字节）` })
    return
  }
  dispatch({ type: 'diagram/validation', ok: false, errors: [{ code: r.code, node_id: r.node_id, port: '', message: r.message }] })
  dispatch({ type: 'ui/toast', kind: 'error', text: `保存失败：${r.code}${r.node_id ? ` @ ${r.node_id}` : ''}`, sticky: true })
  dispatch({ type: 'ui/navigate', view: 'diagram' })
}

/**
 * 保存场景到服务端（G-4 的端点）。原先只长在 `SceneView` 里，自 D-054 起框图页也要用它
 * ——在框图页改站点采样率、天线增益这些**场景里的**设备参数，改完要能存下去。
 *
 * 回填的 `sha256` 是**服务端落盘字节**的哈希，不是本地算的：两端各自序列化再各自算必然对不上
 * （D-049 ⑧）。框图的 `scenario_ref.sha256` 靠它跟着走。
 *
 * 防重入：上一次还没回来就不发下一次。服务端每次 PUT 都要起一次 `cuav_run --scenario-track`
 * 做语义校验，叠着发等于排队起子进程。
 */
let scenarioSaveInFlight = false

export function scenarioSaving(): boolean { return scenarioSaveInFlight }

export async function saveScenario(store: StoreApi): Promise<boolean> {
  const { dispatch, getState } = store
  const s = getState()
  const doc = s.scene.scenario.doc
  const id = s.scene.scenario.id
  if (!doc || !id || scenarioSaveInFlight) return false
  scenarioSaveInFlight = true
  try {
    const r = await putScenario(id, doc)
    if (r.ok) {
      dispatch({ type: 'scene/saved', sha256: r.sha256 })
      return true
    }
    // 失败不清 dirty：下次改动会再试一次，改坏的场景不会被悄悄当成存好了（铁律 15）
    dispatch({ type: 'ui/toast', kind: 'error', text: `场景保存失败 [${r.code}] ${r.message}`, sticky: true })
    return false
  } catch (e) {
    dispatch({ type: 'ui/toast', kind: 'error', text: `场景保存失败：${(e as Error).message}`, sticky: true })
    return false
  } finally {
    scenarioSaveInFlight = false
  }
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
