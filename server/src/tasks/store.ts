// 任务目录与 task.json（06 备忘录 §9A B-5；docs/display-products.md §1）。
//
// 任务目录 data/runs/<task_id>/ 是引擎产品目录，服务端在里面放三样东西：框图副本 diagram.json（原样落盘，
// 永不含内部参数）、解析旁挂 diagram.resolved.json（只在有回放节点时写）、任务摘要 task.json（cuav-task/1）。
// events.jsonl 与 <op_id>/ 由引擎写，服务端不改。
//
// 持久化 = 内存表 + 每任务一份 task.json（原型阶段；SQLite 留 P2）。task.json 用「写临时文件再改名」
// 的方式落盘，读端不会读到半个文件。启动时扫描目录重建内存表；上一世代遗留的 queued / running 任务按
// events.jsonl 尾部的最后一条 task.state 对账，没有终态就标 failed。
//
// events.jsonl 的两种读法都在这里：启动期倒着读尾部（对账），以及 B-6 补取时从头顺序读（缓冲之外的事件）。
// 服务端自己决定的终态不在 events.jsonl 里（那是引擎的文件），重启后由 task.json 合成，序号 = last_seq。

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, promises as fsp, writeFileSync, renameSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { asDiagramError, parseEvent, splitLines, type DiagramError, type EngineEvent } from './engine.js'

export const TASK_SCHEMA = 'cuav-task/1'
export const DEFAULT_RUNS_REL = 'data/runs'

export type RunState = 'queued' | 'running' | 'finished' | 'failed' | 'cancelled'
export type ResultState = 'valid' | 'degraded' | 'invalid' | 'not_applicable'

export interface ObservationPointSummary {
  op_id: string
  node: string
  port: string
  products: string[]
  /** 服务端按 product_row 事件计数；是下界（引擎先刷盘再发事件，被杀时文件可能多一行）。读端以文件长度为准 */
  rows_seen: Record<string, number>
}

export interface DataRef {
  node_id: string
  data_id: string
  holdout: boolean
}

export interface TaskRecord {
  schema_version: typeof TASK_SCHEMA
  task_id: string
  diagram_id: string
  name: string
  diagram_sha256: string
  scenario_sha256?: string
  seed: number | null
  seed_source: 'diagram' | 'cli' | null
  run_state: RunState
  result: ResultState
  reasons: string[]
  created_utc: string
  started_utc?: string
  ended_utc?: string
  wall_s?: number
  realtime_factor?: number
  rounds?: number
  engine_version?: string
  exit_code?: number | null
  signal?: string | null
  cancel_requested: boolean
  error?: DiagramError
  observation_points: ObservationPointSummary[]
  data_refs: DataRef[]
  warnings: string[]
  idempotency_key?: string
  /** 已折入本记录的最大事件序号 */
  last_seq: number
  stderr_tail?: string
  /** 任务目录内的相对文件名，绝不是服务器路径 */
  files: { diagram: string; resolved?: string; events: string }
}

export interface StoreConfig {
  /** 仓库根（引擎 cwd） */
  root: string
  /** 任务根目录，相对仓库根、`/` 分隔，缺省 data/runs */
  runsRel: string
}

export const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isTaskId(s: string): boolean {
  return TASK_ID_RE.test(s)
}

/** `t<YYYYMMDD>-<HHMMSS>-<4 hex>`：可排序、纯 ASCII、可直接作目录名与引擎 task_id。 */
export function newTaskId(now: Date = new Date()): string {
  const p = (n: number, w: number) => String(n).padStart(w, '0')
  const d = `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1, 2)}${p(now.getUTCDate(), 2)}`
  const t = `${p(now.getUTCHours(), 2)}${p(now.getUTCMinutes(), 2)}${p(now.getUTCSeconds(), 2)}`
  return `t${d}-${t}-${randomBytes(2).toString('hex')}`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 任务目录，相对仓库根、`/` 分隔——这是传给引擎的形式。 */
export function taskDirRel(cfg: StoreConfig, taskId: string): string {
  return `${cfg.runsRel}/${taskId}`
}

/** 任务目录的绝对路径——这是 Node 自己读写用的形式。 */
export function taskDirAbs(cfg: StoreConfig, taskId: string): string {
  return join(cfg.root, ...taskDirRel(cfg, taskId).split('/'))
}

export const FILE_DIAGRAM = 'diagram.json'
export const FILE_RESOLVED = 'diagram.resolved.json'
export const FILE_EVENTS = 'events.jsonl'
export const FILE_TASK = 'task.json'

/** 建任务目录并写框图副本与旁挂。目录已存在即抛错（task_id 撞了）。 */
export async function createTaskFiles(
  cfg: StoreConfig,
  taskId: string,
  diagramText: string,
  sidecar: object | null,
): Promise<void> {
  const abs = taskDirAbs(cfg, taskId)
  await fsp.mkdir(join(cfg.root, ...cfg.runsRel.split('/')), { recursive: true })
  await fsp.mkdir(abs)
  await fsp.writeFile(join(abs, FILE_DIAGRAM), diagramText, 'utf8')
  if (sidecar) await fsp.writeFile(join(abs, FILE_RESOLVED), JSON.stringify(sidecar, null, 2) + '\n', 'utf8')
}

/** 删掉刚建的任务目录（只在提交阶段校验失败时用；目录里只有服务端自己写的两个文件）。 */
export async function removeTaskDir(cfg: StoreConfig, taskId: string): Promise<void> {
  if (!isTaskId(taskId)) return
  await fsp.rm(taskDirAbs(cfg, taskId), { recursive: true, force: true })
}

export async function readSidecarData(cfg: StoreConfig, taskId: string): Promise<Record<string, string>> {
  try {
    const j = JSON.parse(await fsp.readFile(join(taskDirAbs(cfg, taskId), FILE_RESOLVED), 'utf8')) as Record<string, unknown>
    const data = j?.data
    if (!data || typeof data !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

function taskJsonText(rec: TaskRecord): string {
  return JSON.stringify(rec, null, 2) + '\n'
}

/** 原子落盘：写 task.json.tmp 再改名。 */
export async function writeTask(cfg: StoreConfig, rec: TaskRecord): Promise<void> {
  const dir = taskDirAbs(cfg, rec.task_id)
  const tmp = join(dir, FILE_TASK + '.tmp')
  await fsp.writeFile(tmp, taskJsonText(rec), 'utf8')
  await fsp.rename(tmp, join(dir, FILE_TASK))
}

/** 同步版本，只给进程退出处理器用（那里不能等 Promise）。 */
export function writeTaskSync(cfg: StoreConfig, rec: TaskRecord): void {
  const dir = taskDirAbs(cfg, rec.task_id)
  const tmp = join(dir, FILE_TASK + '.tmp')
  writeFileSync(tmp, taskJsonText(rec), 'utf8')
  renameSync(tmp, join(dir, FILE_TASK))
}

export async function readTask(cfg: StoreConfig, taskId: string): Promise<TaskRecord | null> {
  if (!isTaskId(taskId)) return null
  try {
    const j = JSON.parse(await fsp.readFile(join(taskDirAbs(cfg, taskId), FILE_TASK), 'utf8')) as TaskRecord
    if (j?.schema_version !== TASK_SCHEMA || j.task_id !== taskId) return null
    return j
  } catch {
    return null
  }
}

/** 扫描任务根目录，读出全部合法 task.json；坏的跳过。 */
export async function scanTasks(cfg: StoreConfig): Promise<TaskRecord[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(join(cfg.root, ...cfg.runsRel.split('/')), { withFileTypes: true })
  } catch {
    return []
  }
  const out: TaskRecord[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !isTaskId(e.name)) continue
    const rec = await readTask(cfg, e.name)
    if (rec) out.push(rec)
  }
  return out
}

/**
 * 把一条（已脱敏的）引擎事件折进任务记录。task.state 与 error 决定状态，product_row 计行，其余只推进 last_seq。
 * 折叠不改 run_state 为 cancelled：取消是服务端的决定，由管理器在进程退出后定。
 */
export function foldEvent(rec: TaskRecord, ev: EngineEvent): void {
  if (ev.seq > rec.last_seq) rec.last_seq = ev.seq
  const p = ev.payload
  switch (ev.type) {
    case 'task.state': {
      const rs = p.run_state
      if (rs === 'running') {
        rec.run_state = 'running'
        if (typeof p.started_utc === 'string') rec.started_utc = p.started_utc
        if (typeof p.seed === 'number') rec.seed = p.seed
        if (p.seed_source === 'diagram' || p.seed_source === 'cli') rec.seed_source = p.seed_source
        if (typeof p.engine_version === 'string') rec.engine_version = p.engine_version
        if (Array.isArray(p.observation_points)) {
          rec.observation_points = (p.observation_points as Array<Record<string, unknown>>).map((o) => ({
            op_id: String(o.op_id ?? ''),
            node: String(o.node ?? ''),
            port: String(o.port ?? ''),
            products: Array.isArray(o.products) ? o.products.map(String) : [],
            rows_seen: {},
          }))
        }
      } else if (rs === 'finished' || rs === 'failed') {
        rec.run_state = rs
        rec.result = asResult(p.result, rs === 'failed' ? 'invalid' : 'valid')
        rec.reasons = Array.isArray(p.reasons) ? p.reasons.map(String) : []
        if (typeof p.rounds === 'number') rec.rounds = p.rounds
        if (typeof p.wall_s === 'number') rec.wall_s = p.wall_s
        if (typeof p.realtime_factor === 'number') rec.realtime_factor = p.realtime_factor
        if (typeof p.engine_version === 'string') rec.engine_version = p.engine_version
        if (typeof p.started_utc === 'string') rec.started_utc = p.started_utc
        rec.ended_utc = typeof p.ended_utc === 'string' ? p.ended_utc : utcNow()
      }
      break
    }
    case 'error':
      rec.error = asDiagramError(p)
      break
    case 'product_row': {
      const opId = String(p.op_id ?? '')
      const kind = String(p.kind ?? '')
      let op = rec.observation_points.find((o) => o.op_id === opId)
      if (!op) {
        op = { op_id: opId, node: '', port: '', products: [], rows_seen: {} }
        rec.observation_points.push(op)
      }
      op.rows_seen[kind] = (op.rows_seen[kind] ?? 0) + 1
      break
    }
    default:
      break
  }
}

function asResult(v: unknown, fallback: ResultState): ResultState {
  return v === 'valid' || v === 'degraded' || v === 'invalid' || v === 'not_applicable' ? v : fallback
}

/**
 * 服务端自己决定终态时补发的 task.state 载荷（payload.source = "server"）。管理器在进程退出时用它造事件推给订阅者；
 * 重启后缓冲为空，readEvents 用同一个函数按 task.json 合成同一条事件，两条路径的读端看到的东西一样。
 */
export function serverStatePayload(rec: TaskRecord): Record<string, unknown> {
  return {
    run_state: rec.run_state,
    result: rec.result,
    reasons: rec.reasons,
    source: 'server',
    ended_utc: rec.ended_utc,
    exit_code: rec.exit_code ?? null,
    signal: rec.signal ?? null,
  }
}

/** 造出服务端终态事件本身；序号由调用方给（进程内 = 引擎最后序号 + 1；重启后 = rec.last_seq）。 */
export function serverStateEvent(rec: TaskRecord, seq: number): EngineEvent {
  return { seq, task_id: rec.task_id, type: 'task.state', t_s: 0, payload: serverStatePayload(rec) }
}

/** 一组（未脱敏的）事件行里可解析事件的最大序号；没有可解析的行返回 0。 */
export function lastSeqInLines(lines: string[], redact: (line: string) => string): number {
  let max = 0
  for (const l of lines) {
    const ev = parseEvent(redact(l))
    if (ev && ev.seq > max) max = ev.seq
  }
  return max
}

/** 读文件末尾至多 `bytes` 字节里的完整行（丢掉可能被截断的首行与没有换行的末行）。同步，启动期用。 */
export function readTailLines(path: string, bytes = 65536): string[] {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
    if (lines.length && !text.endsWith('\n')) lines.pop()
    return lines.filter((l) => l.length > 0)
  } catch {
    return []
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/**
 * 上一世代遗留的 queued / running 任务对账：events.jsonl 尾部若有终态 task.state 就采纳（经脱敏器），
 * 否则标 failed。返回是否改动了记录。已结束的任务原样返回。
 */
export function reconcile(cfg: StoreConfig, rec: TaskRecord, redact: (line: string) => string): boolean {
  if (rec.run_state !== 'queued' && rec.run_state !== 'running') return false
  const lines = readTailLines(join(taskDirAbs(cfg, rec.task_id), FILE_EVENTS))
  for (let i = lines.length - 1; i >= 0; i--) {
    const ev = parseEvent(redact(lines[i]))
    if (!ev || ev.type !== 'task.state') continue
    const rs = ev.payload.run_state
    if (rs === 'finished' || rs === 'failed') {
      foldEvent(rec, ev)
      if (rs === 'failed' && !rec.error) {
        const errLine = lines.slice(0, i).reverse().map((l) => parseEvent(redact(l))).find((e) => e?.type === 'error')
        if (errLine) foldEvent(rec, errLine)
      }
      rec.warnings.push('服务重启后按 events.jsonl 对账得到终态')
      return true
    }
    break
  }
  if (rec.cancel_requested) {
    rec.run_state = 'cancelled'
    rec.result = 'not_applicable'
    rec.reasons = ['服务重启前已请求取消']
  } else {
    rec.run_state = 'failed'
    rec.result = 'invalid'
    rec.reasons = ['服务重启时任务未结束']
  }
  rec.ended_utc = utcNow()
  // 这条终态是服务端定的，序号接在引擎最后一条之后（与进程内 emitServerState 同规则）。task.json 里的
  // last_seq 只在状态事件时落盘、通常落后，所以以文件尾部为准。B-6 的补取据此合成同序号的 task.state。
  rec.last_seq = Math.max(rec.last_seq, lastSeqInLines(lines, redact)) + 1
  return true
}

/**
 * 从头顺序读 events.jsonl，返回序号大于 since 的事件，最多 limit 条（B-6 补取，缓冲之外的路径）。
 * 每行先经脱敏器再解析（与实时路径同一入口）；字节级切行复用 splitLines（去尾 `\r`，多字节字符可跨 chunk）；
 * **末尾没有换行的残片一律丢弃**——引擎可能正在写这一行。文件不存在返回空数组。够 limit 条即销毁流，不再读。
 */
export function readEventLines(path: string, since: number, limit: number, redact: (line: string) => string): Promise<EngineEvent[]> {
  return new Promise((resolve) => {
    const out: EngineEvent[] = []
    if (limit <= 0) return resolve(out)
    let carry: Buffer = Buffer.alloc(0)
    let settled = false
    const stream = createReadStream(path)
    const finish = () => {
      if (settled) return
      settled = true
      resolve(out)
    }
    stream.on('data', (chunk) => {
      const r = splitLines(chunk as Buffer, carry)
      carry = r.carry
      for (const line of r.lines) {
        if (!line.length) continue
        const ev = parseEvent(redact(line))
        if (!ev || ev.seq <= since) continue
        out.push(ev)
        if (out.length >= limit) {
          stream.destroy()
          finish()
          return
        }
      }
    })
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', finish) // ENOENT 等：当作没有事件
  })
}
