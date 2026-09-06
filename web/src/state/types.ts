// 应用状态的形状（09 报告附录 A.1）与 reducer 动作。零依赖 useReducer + context（D-032）。
//
// 规则：频谱、包络、散点的 Float32 数据不进 store，放在 signal/buffer.ts 的缓冲对象里；
// store 只存视窗、仪表设置与元信息。

export type View = 'scene' | 'diagram' | 'results' | 'data'
export type ResultsTab = 'signal' | 'detections' | 'tasks'
export type DrawerTab = 'log' | 'alerts' | 'flow' | 'resources'
export type RunState = 'queued' | 'running' | 'finished' | 'failed' | 'cancelled'
export type ResultState = 'valid' | 'degraded' | 'invalid' | 'not_applicable'
export type CalibrationSource = 'measured' | 'paper' | 'assumed' | 'model'
export type Mode = 'M2+M3' | 'M1+M2'
export type LogLevel = 'info' | 'warn' | 'error'
export type WsStatus = 'connected' | 'reconnecting' | 'closed'

export interface DiagramError { code: string; node_id: string; port: string; message: string }

export interface LogLine {
  id: number
  seq: number
  t_s: number
  level: LogLevel
  message: string
  node_id?: string
  port?: string
  origin: 'engine' | 'client'
}

export interface Toast { id: number; kind: LogLevel; text: string; sticky: boolean }

export interface UndoStack<T> { past: T[]; future: T[] }

/** 产品索引端点的返回（docs/display-products.md §2 加 §3.1 的三个附加字段） */
export interface ProductIndex {
  kind: 'spectrum' | 'envelope'
  op_id: string
  row_len: number
  rows: number
  sample_rate_Hz: number
  center_Hz: number
  bin_width_Hz?: number
  frame_hop_samples?: number
  bucket_samples?: number
  t0_s: number
  nfft?: number
  window?: string
  /** dBm / dBFS（谱）、sqrt_mW / linear_FS（包络）；有 calibration 才是 dBm（D-047） */
  scale: string
  calibration?: { offset_dB: number; source: CalibrationSource; note?: string }
  state: ResultState
  state_reasons: string[]
  rows_available: number
  index_final: boolean
  run_state: RunState
}

/** 与 server/src/tasks/store.ts 的 TaskRecord 同构（只列前端用到的键） */
export interface ObservationPointSummary { op_id: string; node: string; port: string; products: string[] }
export interface TaskRecord {
  task_id: string
  diagram_id: string
  name: string
  seed: number | null
  run_state: RunState
  result: ResultState
  reasons: string[]
  created_utc: string
  wall_s?: number
  realtime_factor?: number
  error?: DiagramError
  observation_points: ObservationPointSummary[]
  data_refs: { node_id: string; data_id: string; holdout: boolean }[]
  warnings: string[]
  last_seq: number
}

/** WebSocket 文本帧与引擎 stdout 事件同构（docs/api-versions.md §4） */
export interface WsTextEvent {
  seq: number
  task_id: string
  type: string
  t_s: number
  payload: Record<string, unknown>
}

export interface WsState {
  status: WsStatus
  lastSeq: number
  reconnects: number
  dropped: number
  attempt: number
  nextRetryMs: number
}

export interface Cursor { lng: number; lat: number; insideAoi: boolean }

export interface AppState {
  ui: {
    view: View
    resultsTab: ResultsTab
    devMode: boolean
    drawer: { open: boolean; tab: DrawerTab }
    leftCollapsed: boolean
    rightCollapsed: boolean
    layout: { leftW: number; rightW: number; drawerH: number }
    popover: null | 'experiment' | 'menu' | 'layers' | 'about'
    toasts: Toast[]
    nextId: number
  }
  context: {
    projectId: string
    experimentId: string | null
    scenarioId: string | null
    diagramId: string | null
    taskId: string | null
    mode: Mode
    seed: number | null
    parameterVersion: string | null
  }
  server: { version: string | null; engineAvailable: boolean | null }
  components: { status: 'loading' | 'ok' | 'unavailable'; catalog: unknown | null }
  scene: {
    packageId: string | null
    summary: SceneSummaryLite | null
    error: string | null
    dirty: boolean
    editor: { tool: 'select'; selection: null }
    undo: UndoStack<never>
  }
  diagram: {
    text: string
    json: Record<string, unknown> | null
    parseError: string | null
    savedText: string
    dirty: boolean
    validation: { ok: boolean; errors: DiagramError[] } | null
    undo: UndoStack<never>
  }
  task: {
    id: string | null
    name: string | null
    runState: RunState | null
    result: ResultState | null
    resultProvisional: boolean
    reasons: string[]
    t_s: number
    duration_s: number
    realtimeFactor: number | null
    liveStart: { wallMs: number; t_s: number } | null
    error: DiagramError | null
    observationPoints: ObservationPointSummary[]
    dataRefs: number
    holdoutRefs: number
    lastSeq: number
    subscribeSince: number
  }
  entities: { byId: Record<string, never>; trails: Record<string, never> }
  links: { byId: Record<string, never> }
  signal: {
    opId: string | null
    compareOpId: null
    index: ProductIndex | null
    viewport: { t0: number; t1: number; f0: number; f1: number; stat: 'max' | 'mean' | 'min' }
    display: {
      refLevel_dB: number
      range_dB: number
      auto: boolean
      trace: 'single'
      avgN: number
      freqAxis: 'rf'
      overlayDetections: boolean
      unit: 'dBm' | 'dBFS'
      calibration: { offset_dB: number; source: CalibrationSource } | null
    }
    markers: never[]
    follow: boolean
    cursor_t_s: number | null
  }
  log: { ring: LogLine[]; nextId: number; filter: 'all' | 'warn' | 'error'; query: string; followTail: boolean }
  ws: WsState
}

/** 场景数据包摘要在 store 里的形状（与 scene/scenePackage.ts 的 SceneSummary 同构，避免循环依赖只重复类型） */
export interface SceneSummaryLite {
  id: string
  name: string
  bbox: [number, number, number, number]
  center: [number, number]
  extentKm: [number, number]
  buildings: { features: number; srcPct: Record<string, number>; heightQ50: number | null; heightMax: number | null }
  basemapUrl: string
  demTiles: string
  buildingsUrl: string
  osmSnapshot: string | null
  attribution: string | null
}

export type Action =
  | { type: 'ui/navigate'; view: View; resultsTab?: ResultsTab }
  | { type: 'ui/resultsTab'; tab: ResultsTab }
  | { type: 'ui/drawer'; open?: boolean; tab?: DrawerTab }
  | { type: 'ui/collapse'; side: 'left' | 'right'; collapsed: boolean }
  | { type: 'ui/layout'; layout: Partial<AppState['ui']['layout']> }
  | { type: 'ui/popover'; id: AppState['ui']['popover'] }
  | { type: 'ui/toast'; kind: LogLevel; text: string; sticky?: boolean }
  | { type: 'ui/toastDismiss'; id: number }
  | { type: 'server/health'; version: string | null; engineAvailable: boolean | null }
  | { type: 'components/loaded'; catalog: unknown }
  | { type: 'components/unavailable' }
  | { type: 'scene/loaded'; summary: SceneSummaryLite }
  | { type: 'scene/error'; message: string }
  | { type: 'diagram/setText'; text: string }
  | { type: 'diagram/loadExample'; text: string }
  | { type: 'diagram/markSaved' }
  | { type: 'diagram/validation'; ok: boolean; errors: DiagramError[] }
  | { type: 'context/mode'; mode: Mode }
  | { type: 'task/adopt'; record: TaskRecord }
  | { type: 'task/created'; record: TaskRecord }
  | { type: 'task/record'; record: TaskRecord }
  | { type: 'ws/status'; ws: WsState }
  | { type: 'ws/subscribed'; last_seq: number; run_state: RunState }
  | { type: 'stream/batch'; events: WsTextEvent[]; wallMs: number; silent?: boolean }
  | { type: 'log/filter'; filter: AppState['log']['filter'] }
  | { type: 'log/query'; query: string }
  | { type: 'log/followTail'; on: boolean }
  | { type: 'log/client'; level: LogLevel; message: string }
  | { type: 'signal/index'; opId: string; index: ProductIndex }
  | { type: 'signal/selectOp'; opId: string }
  | { type: 'signal/follow'; on: boolean }
