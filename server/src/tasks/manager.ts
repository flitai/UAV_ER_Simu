// 任务管理器（06 备忘录 §9A B-5；决策 D-042）。
//
// 状态机 queued → running → finished / failed / cancelled，结果四态与运行态正交（09 §13.1）。
// 提交流程：最小结构检查 → 内部参数检查（D-037）→ data_id 解析 → 建目录落盘 → 同步 `cuav_run --validate`
// （不过即 400 并删目录）→ 入队。队列 FIFO，缺省同时只跑一个；「关浏览器任务不停」天然成立，因为子进程
// 归本服务进程而不归 HTTP 连接。
//
// 事件：引擎 stdout 每行经脱敏器（resolve.ts）后解析，折进任务记录并放入每任务的环形缓冲；B-6 只需在
// subscribe() / events() 上加 WebSocket 传输。服务端自己决定的终态（取消、进程异常退出）以一条
// `task.state` 事件追加到缓冲末尾（payload.source = "server"），序号接在引擎之后，事件流对读端仍然完整。
//
// 取消：引擎没有信号处理（B-4 待办），只能杀——先 SIGTERM，宽限后 SIGKILL；Windows 上两者都是 TerminateProcess。
// 服务退出：同步杀掉全部运行中子进程并把它们标成 failed，否则 tsx watch 重启与 Windows 关窗会留下孤儿。

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import {
  Engine,
  EngineUnavailableError,
  parseEvent,
  type CatalogInfo,
  type DiagramError,
  type EngineEvent,
  type EngineExit,
  type EngineProcess,
  type ValidateResult,
} from './engine.js'
import { DataIndex, buildSidecar, makeRedactor, resolveDataIds } from './resolve.js'
import {
  DEFAULT_RUNS_REL,
  FILE_DIAGRAM,
  FILE_EVENTS,
  FILE_RESOLVED,
  TASK_SCHEMA,
  createTaskFiles,
  foldEvent,
  newTaskId,
  readSidecarData,
  reconcile,
  removeTaskDir,
  scanTasks,
  sha256Hex,
  taskDirAbs,
  taskDirRel,
  utcNow,
  writeTask,
  writeTaskSync,
  type DataRef,
  type StoreConfig,
  type TaskRecord,
} from './store.js'

export const DIAGRAM_SCHEMA = 'cuav-diagram/1'

/** 带 HTTP 状态码的错误，路由层直接转成响应。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === 'string' ? body.message : String(body.error ?? status))
    this.name = 'HttpError'
  }
}

function diagramInvalid(detail: DiagramError): HttpError {
  return new HttpError(400, { error: 'diagram_invalid', detail })
}

export interface ManagerConfig {
  /** 仓库根 = 引擎 cwd */
  root: string
  engine: Engine
  /** 任务根目录，相对仓库根、`/` 分隔；缺省 data/runs */
  runsRel?: string
  dataIndex?: DataIndex
  /** 同时运行的任务数上限，缺省 1（用户 2026-09-05 拍板） */
  maxConcurrent?: number
  /** 每任务事件环形缓冲深度，缺省 4096（docs/api-versions.md §4） */
  eventBufferDepth?: number
  /** SIGTERM 到 SIGKILL 的宽限，缺省 3000 ms */
  killGraceMs?: number
  /** 透传给引擎的 --progress-interval-ms；不给则用引擎缺省 */
  progressIntervalMs?: number
}

export interface SubmitInput {
  /** 已解析的框图 JSON */
  body: unknown
  idempotencyKey?: string
}

export interface SubmitResult {
  /** 201 新建；200 幂等命中 */
  status: 200 | 201
  task: TaskRecord
}

export type EventListener = (ev: EngineEvent) => void

interface Live {
  rec: TaskRecord
  buffer: EngineEvent[]
  redact: (line: string) => string
  listeners: Set<EventListener>
  proc?: EngineProcess
  killTimer?: NodeJS.Timeout
  writeChain: Promise<void>
}

export class TaskManager {
  private readonly store: StoreConfig
  private readonly engine: Engine
  private readonly dataIndex: DataIndex
  private readonly maxConcurrent: number
  private readonly depth: number
  private readonly killGraceMs: number
  private readonly progressIntervalMs: number | undefined
  private readonly tasks = new Map<string, Live>()
  private readonly queue: string[] = []
  private readonly idem = new Map<string, string>()
  private running = 0
  private shuttingDown = false
  private initialized = false

  constructor(cfg: ManagerConfig) {
    this.store = { root: cfg.root, runsRel: cfg.runsRel ?? DEFAULT_RUNS_REL }
    this.engine = cfg.engine
    this.dataIndex = cfg.dataIndex ?? new DataIndex(cfg.root)
    this.maxConcurrent = Math.max(1, cfg.maxConcurrent ?? 1)
    this.depth = Math.max(16, cfg.eventBufferDepth ?? 4096)
    this.killGraceMs = cfg.killGraceMs ?? 3000
    this.progressIntervalMs = cfg.progressIntervalMs
  }

  get storeConfig(): StoreConfig {
    return this.store
  }

  /** 启动：建任务根目录、扫描已有任务、对账、重建幂等表。构造函数不做这些，import 时无副作用。 */
  async init(): Promise<void> {
    await fsp.mkdir(join(this.store.root, ...this.store.runsRel.split('/')), { recursive: true })
    const recs = await scanTasks(this.store)
    for (const rec of recs) {
      const data = rec.files.resolved ? await readSidecarData(this.store, rec.task_id) : {}
      const redact = makeRedactor(this.store.root, data)
      if (reconcile(this.store, rec, redact)) await writeTask(this.store, rec)
      this.tasks.set(rec.task_id, { rec, buffer: [], redact, listeners: new Set(), writeChain: Promise.resolve() })
      if (rec.idempotency_key) this.idem.set(rec.idempotency_key, rec.task_id)
    }
    this.initialized = true
  }

  list(limit = 100): TaskRecord[] {
    const all = [...this.tasks.values()].map((l) => l.rec)
    all.sort((a, b) => (a.created_utc < b.created_utc ? 1 : a.created_utc > b.created_utc ? -1 : a.task_id < b.task_id ? 1 : -1))
    return all.slice(0, Math.max(1, limit))
  }

  get(taskId: string): TaskRecord | null {
    return this.tasks.get(taskId)?.rec ?? null
  }

  /** 缓冲里序号大于 since 的事件，最多 limit 条；任务不存在返回 null。缓冲之外的补取（读 events.jsonl）留 B-6。 */
  events(taskId: string, since = 0, limit = 1000): EngineEvent[] | null {
    const live = this.tasks.get(taskId)
    if (!live) return null
    const out: EngineEvent[] = []
    for (const e of live.buffer) {
      if (e.seq > since) {
        out.push(e)
        if (out.length >= limit) break
      }
    }
    return out
  }

  /** 缓冲里现存的序号范围；空缓冲返回 null。 */
  bufferRange(taskId: string): { first: number; last: number } | null {
    const b = this.tasks.get(taskId)?.buffer
    if (!b || !b.length) return null
    return { first: b[0].seq, last: b[b.length - 1].seq }
  }

  subscribe(taskId: string, listener: EventListener): () => void {
    const live = this.tasks.get(taskId)
    if (!live) throw new HttpError(404, { error: 'not_found', task_id: taskId })
    live.listeners.add(listener)
    return () => live.listeners.delete(listener)
  }

  // -------------------------------------------------------------------------
  // 提交

  async submit(input: SubmitInput): Promise<SubmitResult> {
    if (this.shuttingDown) throw new HttpError(503, { error: 'shutting_down' })
    const d = checkShape(input.body)
    // 落盘与哈希都用原始框图（缩进 2 重排，键序不变），不是检查用的视图
    const text = JSON.stringify(d.raw, null, 2) + '\n'
    const sha = sha256Hex(text)

    if (input.idempotencyKey) {
      const prev = this.idem.get(input.idempotencyKey)
      const live = prev ? this.tasks.get(prev) : undefined
      if (live) {
        if (live.rec.diagram_sha256 === sha) return { status: 200, task: live.rec }
        throw new HttpError(409, {
          error: 'idempotency_conflict',
          message: '同一 Idempotency-Key 已用于另一份框图',
          task_id: live.rec.task_id,
        })
      }
    }

    let catalog: CatalogInfo
    try {
      catalog = await this.engine.catalog()
    } catch (e) {
      throw engineFailure(e)
    }

    // 内部参数出现即 400（D-037）；节点与观测点都查
    for (const n of d.nodes) {
      const internal = catalog.internal.get(n.type)
      if (!internal) continue
      for (const k of Object.keys(n.params)) {
        if (internal.has(k)) {
          throw diagramInvalid({
            code: 'internal_param',
            node_id: n.id,
            port: '',
            message: `框图里出现内部参数 ${k}（组件 ${n.type}）：数据引用只能写 data_id，路径由服务端解析`,
          })
        }
      }
    }
    const tapInternal = catalog.internal.get('ObservationTap')
    if (tapInternal) {
      for (const o of d.observation_points) {
        for (const k of Object.keys(o.params ?? {})) {
          if (tapInternal.has(k)) {
            throw diagramInvalid({ code: 'internal_param', node_id: o.id, port: '', message: `观测点里出现内部参数 ${k}` })
          }
        }
      }
    }

    // data_id 解析 → 旁挂
    const refs: Array<{ node_id: string; data_id: string }> = []
    for (const n of d.nodes) {
      const v = n.params.data_id
      if (typeof v === 'string') refs.push({ node_id: n.id, data_id: v })
    }
    let sidecar: ReturnType<typeof buildSidecar> | null = null
    const dataRefs: DataRef[] = []
    const warnings: string[] = []
    if (refs.length) {
      const r = await resolveDataIds(this.dataIndex, this.store.root, refs.map((x) => x.data_id))
      if (r.missing.length) {
        const m = r.missing[0]
        const node = refs.find((x) => x.data_id === m.data_id)!
        throw diagramInvalid({ code: 'data_id', node_id: node.node_id, port: '', message: m.reason })
      }
      sidecar = buildSidecar(r.data, sha)
      for (const x of refs) dataRefs.push({ ...x, holdout: r.holdout.includes(x.data_id) })
      for (const id of r.holdout) warnings.push(`验收集片段 ${id} 用于回放：只作演示，不得据此调参（D-038）`)
    }

    // 落盘 → 同步校验 → 入队
    const taskId = await this.freshTaskId()
    await createTaskFiles(this.store, taskId, text, sidecar)
    const dirRel = taskDirRel(this.store, taskId)
    let v: ValidateResult
    try {
      v = await this.engine.validate(`${dirRel}/${FILE_DIAGRAM}`, sidecar ? `${dirRel}/${FILE_RESOLVED}` : undefined, taskId)
    } catch (e) {
      await removeTaskDir(this.store, taskId)
      throw engineFailure(e)
    }
    if (!v.ok) {
      await removeTaskDir(this.store, taskId)
      throw diagramInvalid(v.error)
    }

    const rec: TaskRecord = {
      schema_version: TASK_SCHEMA,
      task_id: taskId,
      diagram_id: d.diagram_id,
      name: d.name,
      diagram_sha256: sha,
      seed: typeof d.run.seed === 'number' ? d.run.seed : null,
      seed_source: null,
      run_state: 'queued',
      result: 'not_applicable',
      reasons: [],
      created_utc: utcNow(),
      cancel_requested: false,
      observation_points: [],
      data_refs: dataRefs,
      warnings,
      last_seq: 0,
      files: { diagram: FILE_DIAGRAM, events: FILE_EVENTS, ...(sidecar ? { resolved: FILE_RESOLVED } : {}) },
    }
    if (d.scenario_ref && typeof d.scenario_ref.sha256 === 'string') rec.scenario_sha256 = d.scenario_ref.sha256
    if (input.idempotencyKey) rec.idempotency_key = input.idempotencyKey
    await writeTask(this.store, rec)

    const live: Live = {
      rec,
      buffer: [],
      redact: makeRedactor(this.store.root, sidecar?.data ?? {}),
      listeners: new Set(),
      writeChain: Promise.resolve(),
    }
    this.tasks.set(taskId, live)
    if (input.idempotencyKey) this.idem.set(input.idempotencyKey, taskId)
    this.queue.push(taskId)
    this.pump()
    return { status: 201, task: rec }
  }

  private async freshTaskId(): Promise<string> {
    for (let i = 0; i < 16; i++) {
      const id = newTaskId()
      if (this.tasks.has(id)) continue
      try {
        await fsp.access(taskDirAbs(this.store, id))
      } catch {
        return id
      }
    }
    throw new HttpError(500, { error: 'task_id_exhausted', message: '连续 16 次生成的 task_id 都已存在' })
  }

  // -------------------------------------------------------------------------
  // 运行

  private pump(): void {
    while (!this.shuttingDown && this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!
      const live = this.tasks.get(id)
      if (!live || live.rec.run_state !== 'queued') continue
      this.start(live)
    }
  }

  private start(live: Live): void {
    const rec = live.rec
    const dirRel = taskDirRel(this.store, rec.task_id)
    const args = [`${dirRel}/${FILE_DIAGRAM}`, '--out', dirRel, '--task-id', rec.task_id]
    if (rec.files.resolved) args.push('--resolved', `${dirRel}/${FILE_RESOLVED}`)
    if (this.progressIntervalMs !== undefined) args.push('--progress-interval-ms', String(this.progressIntervalMs))

    this.running++
    rec.run_state = 'running'
    rec.started_utc = utcNow()
    this.persist(live)
    live.proc = this.engine.run(args, { onLine: (line) => this.ingest(live, line) })
    void live.proc.done.then((exit) => this.finish(live, exit))
  }

  /** 唯一的事件入口：先整行脱敏再解析；折进记录、进缓冲、通知订阅者。 */
  private ingest(live: Live, rawLine: string): void {
    const ev = parseEvent(live.redact(rawLine))
    if (!ev) return // 非事件行（不应出现：诊断走 stderr），忽略
    this.push(live, ev)
    if (ev.type === 'task.state' || ev.type === 'error') this.persist(live)
  }

  private push(live: Live, ev: EngineEvent): void {
    foldEvent(live.rec, ev)
    live.buffer.push(ev)
    if (live.buffer.length > this.depth) live.buffer.splice(0, live.buffer.length - this.depth)
    for (const l of live.listeners) {
      try {
        l(ev)
      } catch {
        // 订阅者自己的错误不影响任务
      }
    }
  }

  /** 服务端决定的终态以一条 task.state 事件追加到缓冲，序号接在引擎之后，B-6 的读端因此总能收到终态。 */
  private emitServerState(live: Live): void {
    const rec = live.rec
    this.push(live, {
      seq: rec.last_seq + 1,
      task_id: rec.task_id,
      type: 'task.state',
      t_s: 0,
      payload: {
        run_state: rec.run_state,
        result: rec.result,
        reasons: rec.reasons,
        source: 'server',
        ended_utc: rec.ended_utc,
        exit_code: rec.exit_code ?? null,
        signal: rec.signal ?? null,
      },
    })
  }

  private finish(live: Live, exit: EngineExit): void {
    this.running--
    if (live.killTimer) {
      clearTimeout(live.killTimer)
      live.killTimer = undefined
    }
    live.proc = undefined
    const rec = live.rec
    rec.exit_code = exit.code
    rec.signal = exit.signal
    if (exit.stderrTail) rec.stderr_tail = live.redact(exit.stderrTail)

    if (rec.run_state === 'finished' || rec.run_state === 'failed') {
      // 引擎给了终态，信它（退出码与四态正交，D-041 ④）
    } else if (rec.cancel_requested) {
      rec.run_state = 'cancelled'
      rec.result = 'not_applicable'
      rec.reasons = ['用户取消']
      rec.ended_utc = utcNow()
      this.emitServerState(live)
    } else {
      const why = exit.error
        ? `引擎起不来：${exit.error}`
        : `引擎进程异常退出（退出码 ${exit.code ?? '无'}，信号 ${exit.signal ?? '无'}）`
      rec.run_state = 'failed'
      rec.result = 'invalid'
      rec.reasons = [why]
      rec.ended_utc = utcNow()
      if (!rec.error) {
        rec.error = { code: 'engine', node_id: '', port: '', message: rec.stderr_tail ? `${why}：${rec.stderr_tail.trim()}` : why }
      }
      this.emitServerState(live)
    }
    if (!rec.ended_utc) rec.ended_utc = utcNow()
    this.persist(live)
    this.pump()
  }

  private persist(live: Live): void {
    live.writeChain = live.writeChain
      .then(() => writeTask(this.store, live.rec))
      .catch((e) => console.error(`task.json 写入失败 ${live.rec.task_id}：${String(e)}`))
  }

  /** 等所有待写的 task.json 落盘（测试用）。 */
  async flush(): Promise<void> {
    await Promise.all([...this.tasks.values()].map((l) => l.writeChain))
  }

  // -------------------------------------------------------------------------
  // 取消与退出

  async cancel(taskId: string): Promise<TaskRecord> {
    const live = this.tasks.get(taskId)
    if (!live) throw new HttpError(404, { error: 'not_found', task_id: taskId })
    const rec = live.rec
    if (rec.run_state === 'queued') {
      const i = this.queue.indexOf(taskId)
      if (i >= 0) this.queue.splice(i, 1)
      rec.cancel_requested = true
      rec.run_state = 'cancelled'
      rec.result = 'not_applicable'
      rec.reasons = ['排队中取消']
      rec.ended_utc = utcNow()
      this.emitServerState(live)
      this.persist(live)
      await live.writeChain
      return rec
    }
    if (rec.run_state === 'running') {
      if (!rec.cancel_requested) {
        rec.cancel_requested = true
        this.persist(live)
        const proc = live.proc?.proc
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGTERM')
          live.killTimer = setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
          }, this.killGraceMs)
          live.killTimer.unref?.()
        }
      }
      await live.writeChain
      return rec
    }
    throw new HttpError(409, { error: 'task_finished', run_state: rec.run_state, task_id: taskId })
  }

  /** 进程退出时同步收尾：杀掉运行中的引擎并把未结束的任务标 failed。不能等 Promise。 */
  shutdownSync(reason = '服务停止时任务被中止'): void {
    this.shuttingDown = true
    for (const live of this.tasks.values()) {
      const rec = live.rec
      if (rec.run_state === 'running') {
        try {
          live.proc?.proc.kill('SIGTERM')
        } catch {
          // 已退出
        }
        rec.run_state = 'failed'
        rec.result = 'invalid'
        rec.reasons = [reason]
      } else if (rec.run_state === 'queued') {
        rec.run_state = 'failed'
        rec.result = 'invalid'
        rec.reasons = ['服务停止时任务尚在排队']
      } else {
        continue
      }
      rec.ended_utc = utcNow()
      try {
        writeTaskSync(this.store, rec)
      } catch (e) {
        console.error(`task.json 收尾写入失败 ${rec.task_id}：${String(e)}`)
      }
    }
    this.queue.length = 0
  }

  installShutdownHandlers(): void {
    const onSignal = (sig: NodeJS.Signals) => {
      this.shutdownSync()
      process.exit(sig === 'SIGINT' ? 130 : 143)
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }

  get isInitialized(): boolean {
    return this.initialized
  }
}

export function createTaskManager(cfg: ManagerConfig): TaskManager {
  return new TaskManager(cfg)
}

// ---------------------------------------------------------------------------
// 最小结构检查：只保证后面的遍历安全并能取出 data_id 与参数名，其余校验全部交给引擎 --validate
// （docs/diagram-format.md §3：语义只在引擎一处解释）。

interface ShapedNode {
  id: string
  type: string
  params: Record<string, unknown>
}
interface ShapedTap {
  id: string
  params?: Record<string, unknown>
}
interface ShapedDiagram {
  /** 原始框图对象，落盘与哈希用它 */
  raw: Record<string, unknown>
  diagram_id: string
  name: string
  nodes: ShapedNode[]
  observation_points: ShapedTap[]
  run: Record<string, unknown>
  scenario_ref?: Record<string, unknown>
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function schemaError(message: string, node_id = ''): HttpError {
  return diagramInvalid({ code: 'schema', node_id, port: '', message })
}

function checkShape(body: unknown): ShapedDiagram {
  if (!isObj(body)) throw schemaError('框图必须是 JSON 对象')
  if (body.schema_version !== DIAGRAM_SCHEMA) throw schemaError(`schema_version 必须是 ${DIAGRAM_SCHEMA}`)
  if (typeof body.diagram_id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(body.diagram_id)) throw schemaError('diagram_id 缺失或不合法')
  if (typeof body.name !== 'string') throw schemaError('name 缺失')
  if (!Array.isArray(body.nodes) || !body.nodes.length) throw schemaError('nodes 必须是非空数组')
  if (!isObj(body.run)) throw schemaError('run 缺失')
  const nodes: ShapedNode[] = []
  for (const n of body.nodes as unknown[]) {
    if (!isObj(n) || typeof n.id !== 'string' || typeof n.type !== 'string') throw schemaError('节点缺 id 或 type')
    if (n.params !== undefined && !isObj(n.params)) throw schemaError('params 必须是对象', n.id)
    nodes.push({ id: n.id, type: n.type, params: (n.params as Record<string, unknown>) ?? {} })
  }
  const taps: ShapedTap[] = []
  if (body.observation_points !== undefined) {
    if (!Array.isArray(body.observation_points)) throw schemaError('observation_points 必须是数组')
    for (const o of body.observation_points as unknown[]) {
      if (!isObj(o) || typeof o.id !== 'string') throw schemaError('观测点缺 id')
      if (o.params !== undefined && !isObj(o.params)) throw schemaError('观测点 params 必须是对象', o.id)
      taps.push({ id: o.id, params: o.params as Record<string, unknown> | undefined })
    }
  }
  return {
    raw: body,
    diagram_id: body.diagram_id,
    name: body.name,
    nodes,
    observation_points: taps,
    run: body.run,
    scenario_ref: isObj(body.scenario_ref) ? body.scenario_ref : undefined,
  }
}

function engineFailure(e: unknown): HttpError {
  if (e instanceof EngineUnavailableError) return new HttpError(503, { error: 'engine_unavailable', message: e.message })
  return new HttpError(500, { error: 'engine_error', message: String(e instanceof Error ? e.message : e) })
}
