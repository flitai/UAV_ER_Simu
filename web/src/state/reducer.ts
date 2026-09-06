// 应用状态的 reducer（09 附录 A.1）。纯函数：所有网络与定时器都在 shell/actions.ts 与 hooks 里。

import { lineFromEvent, pushLines } from './logRing.js'
import { clampViewport, fullWindow, spectrumGeomOf } from '../signal/viewport.js'
import type {
  Action, AppState, DiagramError, LogLine, ProductIndex, ResultState, RunState, TaskRecord, WsTextEvent,
} from './types.js'

export const TERMINAL: ReadonlySet<RunState> = new Set(['finished', 'failed', 'cancelled'])

export function defaultLayout(innerWidth: number): AppState['ui']['layout'] {
  // 09 §4.4：2560 宽取默认宽度的 1.25 倍
  return innerWidth >= 2560 ? { leftW: 350, rightW: 400, drawerH: 240 } : { leftW: 280, rightW: 320, drawerH: 240 }
}

export function initialState(devMode: boolean, innerWidth: number, diagramText = '', route: { view: AppState['ui']['view']; resultsTab: AppState['ui']['resultsTab'] } = { view: 'scene', resultsTab: 'signal' }): AppState {
  const parsed = parseDiagram(diagramText)
  return {
    ui: {
      view: route.view, resultsTab: route.resultsTab, devMode,
      drawer: { open: false, tab: 'log' },
      leftCollapsed: innerWidth < 1920, rightCollapsed: innerWidth < 1920,
      layout: defaultLayout(innerWidth),
      popover: null, toasts: [], nextId: 1,
    },
    context: {
      projectId: '默认项目', experimentId: parsed.json ? parsed.diagramId : null, scenarioId: null,
      diagramId: parsed.diagramId, taskId: null, mode: 'M2+M3', seed: parsed.seed, parameterVersion: null,
    },
    server: { version: null, engineAvailable: null },
    components: { status: 'loading', catalog: null },
    scene: { packageId: null, summary: null, error: null, dirty: false, editor: { tool: 'select', selection: null }, undo: { past: [], future: [] } },
    diagram: {
      text: diagramText, json: parsed.json, parseError: parsed.error, savedText: diagramText, dirty: false,
      validation: null, undo: { past: [], future: [] },
    },
    task: emptyTask(),
    entities: { byId: {}, trails: {} },
    links: { byId: {} },
    signal: emptySignal(),
    log: { ring: [], nextId: 1, filter: 'all', query: '', followTail: true },
    ws: { status: 'closed', lastSeq: 0, reconnects: 0, dropped: 0, attempt: 0, nextRetryMs: 0 },
  }
}

function emptyTask(): AppState['task'] {
  return {
    id: null, name: null, runState: null, result: null, resultProvisional: false, reasons: [],
    t_s: 0, duration_s: 0, realtimeFactor: null, liveStart: null, error: null,
    observationPoints: [], dataRefs: 0, holdoutRefs: 0, lastSeq: 0, subscribeSince: 0,
  }
}

function emptySignal(): AppState['signal'] {
  return {
    opId: null, compareOpId: null, index: null, envelopeIndex: null,
    viewport: { t0: 0, t1: 0, f0: 0, f1: 0, stat: 'max' },
    display: {
      refLevel_dB: 0, range_dB: 100, auto: true, trace: 'single', avgN: 16, freqAxis: 'rf',
      overlayDetections: false, unit: 'dBFS', calibration: null,
    },
    markers: [{ id: 'M1', freq_Hz: null, auto: true }], follow: true, cursor_t_s: null,
  }
}

export function parseDiagram(text: string): { json: Record<string, unknown> | null; error: string | null; diagramId: string | null; seed: number | null } {
  if (!text.trim()) return { json: null, error: null, diagramId: null, seed: null }
  try {
    const j = JSON.parse(text) as unknown
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { json: null, error: '框图顶层必须是对象', diagramId: null, seed: null }
    const o = j as Record<string, unknown>
    const run = (o['run'] && typeof o['run'] === 'object' ? o['run'] : {}) as Record<string, unknown>
    const seed = typeof run['seed'] === 'number' ? run['seed'] : null
    const diagramId = typeof o['diagram_id'] === 'string' ? o['diagram_id'] : null
    return { json: o, error: null, diagramId, seed }
  } catch (e) {
    return { json: null, error: `JSON 解析失败：${(e as Error).message}`, diagramId: null, seed: null }
  }
}

function provisional(rs: RunState | null): boolean { return rs === 'queued' || rs === 'running' }

function firstSpectrumOp(ops: TaskRecord['observation_points']): string | null {
  const op = ops.find((o) => o.products.includes('spectrum')) ?? ops[0]
  return op ? op.op_id : null
}

function fromRecord(rec: TaskRecord, prev: AppState['task']): AppState['task'] {
  return {
    ...prev,
    id: rec.task_id, name: rec.name ?? prev.name, runState: rec.run_state, result: rec.result,
    resultProvisional: provisional(rec.run_state), reasons: rec.reasons ?? [],
    realtimeFactor: typeof rec.realtime_factor === 'number' ? rec.realtime_factor : (TERMINAL.has(rec.run_state) ? prev.realtimeFactor : null),
    error: rec.error ?? null,
    observationPoints: rec.observation_points ?? [],
    dataRefs: (rec.data_refs ?? []).length,
    holdoutRefs: (rec.data_refs ?? []).filter((d) => d.holdout).length,
    lastSeq: rec.last_seq ?? 0,
  }
}

function toast(s: AppState, kind: LogLine['level'], text: string, sticky = false): AppState {
  return { ...s, ui: { ...s.ui, toasts: [...s.ui.toasts, { id: s.ui.nextId, kind, text, sticky }], nextId: s.ui.nextId + 1 } }
}

function clientLine(s: AppState, level: LogLine['level'], message: string): AppState {
  const line: LogLine = { id: s.log.nextId, seq: 0, t_s: s.task.t_s, level, message, origin: 'client' }
  return { ...s, log: { ...s.log, ring: pushLines(s.log.ring, [line]), nextId: s.log.nextId + 1 } }
}

/** 折叠一条任务事件。顺序敏感：调用方按 seq 递增喂。 */
export function applyEvent(s: AppState, ev: WsTextEvent, wallMs: number): AppState {
  if (ev.task_id && s.task.id && ev.task_id !== s.task.id) return s
  const p = ev.payload ?? {}
  let task = s.task
  if (ev.seq > 0 && ev.seq > task.lastSeq) task = { ...task, lastSeq: ev.seq }
  if (typeof ev.t_s === 'number' && ev.t_s > task.t_s) task = { ...task, t_s: ev.t_s }
  let next: AppState = { ...s, task }

  switch (ev.type) {
    case 'task.state': {
      const rs = p['run_state'] as RunState | undefined
      if (rs === 'running' && (p['run'] || p['observation_points'])) {
        const run = (p['run'] ?? {}) as Record<string, unknown>
        const ops = (p['observation_points'] as TaskRecord['observation_points'] | undefined) ?? task.observationPoints
        task = {
          ...task, runState: 'running', resultProvisional: true,
          name: typeof p['name'] === 'string' ? p['name'] : task.name,
          duration_s: typeof run['duration_s'] === 'number' ? run['duration_s'] : task.duration_s,
          observationPoints: ops,
        }
        next = { ...next, task }
        if (!next.signal.opId) next = { ...next, signal: { ...next.signal, opId: firstSpectrumOp(ops) } }
        next = clientLine(next, 'info', `任务开始：${task.name ?? task.id ?? ''}，时长 ${task.duration_s} s`)
        break
      }
      if (rs && TERMINAL.has(rs)) {
        const result = (p['result'] as ResultState | undefined) ?? (rs === 'cancelled' ? 'not_applicable' : rs === 'failed' ? 'invalid' : task.result)
        task = {
          ...task, runState: rs, result: result ?? null, resultProvisional: false,
          reasons: Array.isArray(p['reasons']) ? (p['reasons'] as string[]) : task.reasons,
          realtimeFactor: typeof p['realtime_factor'] === 'number' ? p['realtime_factor'] : task.realtimeFactor,
          liveStart: null,
        }
        next = { ...next, task }
        if (rs === 'finished') {
          next = toast(next, result === 'degraded' ? 'warn' : 'info',
            result === 'degraded' ? `任务完成，结果降级：${task.reasons[0] ?? ''}` : '任务完成')
        } else if (rs === 'failed') {
          next = toast(next, 'error', `任务失败：${task.error?.message ?? task.reasons[0] ?? ''}`, true)
        } else {
          next = toast(next, 'warn', '任务已取消')
        }
      }
      break
    }
    case 'progress': {
      if (task.runState === 'running' || task.runState === 'queued') {
        const start = task.liveStart ?? { wallMs, t_s: ev.t_s }
        const span = (wallMs - start.wallMs) / 1000
        const rtf = span >= 0.5 ? (ev.t_s - start.t_s) / span : task.realtimeFactor
        next = { ...next, task: { ...task, runState: 'running', liveStart: start, realtimeFactor: rtf } }
      }
      break
    }
    case 'log':
    case 'error': {
      const line = lineFromEvent(ev, next.log.nextId)
      if (line) next = { ...next, log: { ...next.log, ring: pushLines(next.log.ring, [line]), nextId: next.log.nextId + 1 } }
      if (ev.type === 'error') {
        const err: DiagramError = {
          code: String(p['code'] ?? 'error'), node_id: String(p['node_id'] ?? ''), port: String(p['port'] ?? ''),
          message: String(p['message'] ?? ''),
        }
        next = { ...next, task: { ...next.task, error: err } }
      }
      break
    }
    default:
      break
  }
  return next
}

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'ui/navigate':
      return { ...s, ui: { ...s.ui, view: a.view, resultsTab: a.view === 'results' && a.resultsTab ? a.resultsTab : s.ui.resultsTab, popover: null } }
    case 'ui/resultsTab':
      return { ...s, ui: { ...s.ui, resultsTab: a.tab } }
    case 'ui/drawer':
      return { ...s, ui: { ...s.ui, drawer: { open: a.open ?? s.ui.drawer.open, tab: a.tab ?? s.ui.drawer.tab } } }
    case 'ui/collapse':
      return { ...s, ui: { ...s.ui, [a.side === 'left' ? 'leftCollapsed' : 'rightCollapsed']: a.collapsed } }
    case 'ui/layout':
      return { ...s, ui: { ...s.ui, layout: { ...s.ui.layout, ...a.layout } } }
    case 'ui/popover':
      return { ...s, ui: { ...s.ui, popover: a.id } }
    case 'ui/toast':
      return toast(s, a.kind, a.text, a.sticky ?? false)
    case 'ui/toastDismiss':
      return { ...s, ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== a.id) } }
    case 'server/health':
      return { ...s, server: { version: a.version, engineAvailable: a.engineAvailable } }
    case 'components/loaded':
      return { ...s, components: { status: 'ok', catalog: a.catalog } }
    case 'components/unavailable':
      return { ...s, components: { status: 'unavailable', catalog: null } }
    case 'scene/loaded':
      return { ...s, scene: { ...s.scene, packageId: a.summary.id, summary: a.summary, error: null } }
    case 'scene/error':
      return { ...s, scene: { ...s.scene, error: a.message } }
    case 'diagram/setText':
    case 'diagram/loadExample': {
      const parsed = parseDiagram(a.text)
      const savedText = a.type === 'diagram/loadExample' ? a.text : s.diagram.savedText
      return {
        ...s,
        diagram: { ...s.diagram, text: a.text, json: parsed.json, parseError: parsed.error, savedText, dirty: a.text !== savedText, validation: null },
        context: { ...s.context, diagramId: parsed.diagramId, experimentId: parsed.json ? parsed.diagramId : s.context.experimentId, seed: parsed.seed },
      }
    }
    case 'diagram/markSaved':
      return { ...s, diagram: { ...s.diagram, savedText: s.diagram.text, dirty: false } }
    case 'diagram/validation':
      return { ...s, diagram: { ...s.diagram, validation: { ok: a.ok, errors: a.errors } } }
    case 'context/mode':
      return { ...s, context: { ...s.context, mode: a.mode } }
    case 'task/adopt': {
      const terminal = TERMINAL.has(a.record.run_state)
      const since = terminal ? a.record.last_seq : 0
      const task = { ...fromRecord(a.record, emptyTask()), subscribeSince: since, lastSeq: since }
      return {
        ...s, task,
        context: { ...s.context, taskId: a.record.task_id },
        // 采用已结束的任务时不回放行帧（since = last_seq），环里没有实时数据：直接进回看，索引到达后取全窗
        signal: { ...emptySignal(), opId: firstSpectrumOp(a.record.observation_points ?? []), follow: !terminal },
        ws: { ...s.ws, lastSeq: since, dropped: 0 },
      }
    }
    case 'task/created': {
      const task = { ...fromRecord(a.record, emptyTask()), subscribeSince: 0, lastSeq: 0 }
      const next: AppState = {
        ...s, task,
        context: { ...s.context, taskId: a.record.task_id },
        signal: { ...emptySignal(), opId: firstSpectrumOp(a.record.observation_points ?? []) },
        log: { ...s.log, ring: [] },
        ws: { ...s.ws, lastSeq: 0, dropped: 0 },
      }
      const warn = (a.record.warnings ?? []).length ? `；${a.record.warnings[0]}` : ''
      return toast(next, 'info', `已提交任务 ${a.record.task_id}${warn}`)
    }
    case 'task/record': {
      if (s.task.id && a.record.task_id !== s.task.id) return s
      return { ...s, task: fromRecord(a.record, s.task) }
    }
    case 'ws/status': {
      let next: AppState = { ...s, ws: a.ws }
      if (a.ws.status === 'closed' && s.ws.status !== 'closed' && s.task.id && !TERMINAL.has(s.task.runState ?? 'finished')) {
        next = toast(next, 'warn', '与服务的连接已断开')
      }
      return next
    }
    case 'ws/subscribed': {
      const task = { ...s.task }
      if (TERMINAL.has(a.run_state) && !TERMINAL.has(task.runState ?? 'queued')) {
        // 订阅应答说已结束但本地还是运行中：随后的回放会带来结束事件，这里先不改结果态
        task.runState = a.run_state
      } else if (!task.runState) {
        task.runState = a.run_state
      }
      return { ...s, task }
    }
    case 'stream/batch': {
      let next = s
      for (const ev of a.events) next = applyEvent(next, ev, a.wallMs)
      // silent：采用已结束任务时折叠的历史事件，不弹提示、不写「任务开始」日志
      if (a.silent) next = { ...next, ui: { ...next.ui, toasts: s.ui.toasts }, log: s.log }
      return next
    }
    case 'log/filter':
      return { ...s, log: { ...s.log, filter: a.filter } }
    case 'log/query':
      return { ...s, log: { ...s.log, query: a.query } }
    case 'log/followTail':
      return { ...s, log: { ...s.log, followTail: a.on } }
    case 'log/client':
      return clientLine(s, a.level, a.message)
    case 'signal/index': {
      if (s.signal.opId && a.opId !== s.signal.opId) return s
      const idx = a.index
      const first = s.signal.index === null
      const geom = spectrumGeomOf(idx)
      // 首次拿到索引：视窗 = 全窗（列边界精确到半格，与抽取端点的 X-CUAV-F0/F1 同口径）
      const viewport = first && geom ? fullWindow(geom, s.signal.viewport.stat) : s.signal.viewport
      const calibrated = idx.scale === 'dBm' && !!idx.calibration
      let next: AppState = {
        ...s,
        signal: {
          ...s.signal, opId: a.opId, index: idx, viewport,
          display: {
            ...s.signal.display,
            unit: calibrated ? 'dBm' : 'dBFS',
            calibration: idx.calibration ? { offset_dB: idx.calibration.offset_dB, source: idx.calibration.source } : null,
          },
        },
      }
      if (idx.scale === 'dBm' && !idx.calibration && s.signal.index?.scale !== 'dBm') {
        // 索引写了 dBm 却没有常数：按未标定显示并记一条，绝不显示不带来源的 dBm（铁律 15）
        next = clientLine(next, 'warn', `观测点 ${a.opId} 的索引标 dBm 但没有标定常数，按 dBFS（未标定）显示`)
      }
      return next
    }
    case 'signal/envelopeIndex':
      if (s.signal.opId && a.opId !== s.signal.opId) return s
      return { ...s, signal: { ...s.signal, envelopeIndex: a.index } }
    case 'signal/selectOp':
      return { ...s, signal: { ...emptySignal(), opId: a.opId, follow: s.signal.follow } }
    case 'signal/follow': {
      if (!a.on) return { ...s, signal: { ...s.signal, follow: false } }
      // 回到跟随：频率复位全带、时间游标清掉
      const geom = s.signal.index ? spectrumGeomOf(s.signal.index) : null
      const viewport = geom ? fullWindow(geom, s.signal.viewport.stat) : s.signal.viewport
      return { ...s, signal: { ...s.signal, follow: true, viewport, cursor_t_s: null } }
    }
    case 'signal/viewport': {
      const merged = { ...s.signal.viewport, ...a.viewport }
      const geom = s.signal.index ? spectrumGeomOf(s.signal.index) : null
      const viewport = geom ? clampViewport(merged, geom) : merged
      return { ...s, signal: { ...s.signal, viewport, follow: false } }
    }
    case 'signal/display':
      return { ...s, signal: { ...s.signal, display: { ...s.signal.display, ...a.patch } } }
    case 'signal/marker': {
      const others = s.signal.markers.filter((m) => m.id !== a.id)
      const markers = a.freq_Hz === null ? others : [...others, { id: a.id, freq_Hz: a.freq_Hz, auto: false }]
      return { ...s, signal: { ...s.signal, markers } }
    }
    case 'signal/cursor':
      return { ...s, signal: { ...s.signal, cursor_t_s: a.t_s } }
    default:
      return s
  }
}

export type { ProductIndex }
