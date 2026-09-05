// 引擎子进程封装（06 备忘录 §9A B-5；决策 D-031 子进程形态、D-041 事件与退出码、D-042 路径约定）。
//
// 三条硬约束：
//   1. `spawn` 数组参数，不走 shell。Windows 上不必考虑引号转义。
//   2. 传给引擎的所有路径都相对仓库根、纯 ASCII、字面 `/` 分隔，子进程 cwd = 仓库根。
//      引擎的 main(int, char**) 在 Windows 上收 ANSI 码页参数，含中文或空格的绝对根目录会出问题；
//      相对路径让引擎永远见不到根目录，Unicode 的 cwd 由 Node 处理。platform::make_dirs 只按 `/` 切分，
//      所以这里禁止用 path.join 拼引擎参数。
//   3. stdout 按字节切行、去尾 `\r`（Windows 文本模式写 `\r\n`）、逐行 UTF-8 解码，多字节字符可能跨 chunk。
//
// 事件信封与 docs/api-versions.md §4.1 一致：{seq, task_id, type, t_s, payload}。诊断文字在 stderr，只留尾部。

import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import { join } from 'node:path'

export interface EngineConfig {
  /** 可执行文件的绝对路径（可含非 ASCII，由 Node 处理） */
  bin: string
  /** 子进程工作目录 = 仓库根；传给引擎的所有路径都相对它 */
  cwd: string
  /** 放在真正参数之前的固定参数（测试用：bin = node，prefixArgs = [假引擎脚本]） */
  prefixArgs?: string[]
}

/** 缺省二进制位置：环境变量 CUAV_RUN，否则 <仓库根>/engine/build/cuav_run（Windows 加 .exe）。 */
export function defaultEngineBinary(root: string): string {
  const env = process.env.CUAV_RUN
  if (env) return env
  return join(root, 'engine', 'build', process.platform === 'win32' ? 'cuav_run.exe' : 'cuav_run')
}

export interface EngineEvent {
  seq: number
  task_id: string
  type: string
  t_s: number
  payload: Record<string, unknown>
}

/** 引擎 DiagramError 的四字段（docs/diagram-format.md §4）。 */
export interface DiagramError {
  code: string
  node_id: string
  port: string
  message: string
}

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineUnavailableError'
  }
}

const LF = 0x0a
const CR = 0x0d

/**
 * 字节级切行。返回完整行（去尾 `\r`，UTF-8 解码）与残片；残片是拷贝，不与输入共享内存。
 * 空行由调用方过滤。
 */
export function splitLines(chunk: Buffer, carry: Buffer): { lines: string[]; carry: Buffer } {
  const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
  const lines: string[] = []
  let start = 0
  for (;;) {
    const i = buf.indexOf(LF, start)
    if (i < 0) break
    let end = i
    if (end > start && buf[end - 1] === CR) end--
    lines.push(buf.subarray(start, end).toString('utf8'))
    start = i + 1
  }
  return { lines, carry: Buffer.from(buf.subarray(start)) }
}

/** 把一行解析成事件；不是合法信封返回 null（诊断文字混进 stdout 时不至于炸）。 */
export function parseEvent(line: string): EngineEvent | null {
  let j: unknown
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  if (typeof o.seq !== 'number' || typeof o.type !== 'string' || typeof o.task_id !== 'string') return null
  return {
    seq: o.seq,
    task_id: o.task_id,
    type: o.type,
    t_s: typeof o.t_s === 'number' ? o.t_s : 0,
    payload: o.payload && typeof o.payload === 'object' ? (o.payload as Record<string, unknown>) : {},
  }
}

export function asDiagramError(p: Record<string, unknown>): DiagramError {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
  return { code: s(p.code) || 'graph', node_id: s(p.node_id), port: s(p.port), message: s(p.message) }
}

export interface SpawnHandlers {
  onLine?: (line: string) => void
  onStderr?: (text: string) => void
}

export interface EngineExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** 进程起不来（找不到二进制、无执行权限）时的错误文字 */
  error?: string
  stderrTail: string
}

export interface EngineProcess {
  proc: ChildProcess
  done: Promise<EngineExit>
}

const STDERR_TAIL_CHARS = 8192

/** 起子进程。stdout 逐行回调，stderr 只留尾部；`done` 在 stdio 关闭后兑现，因此残行一定先于 done 送出。 */
export function spawnEngine(cfg: EngineConfig, args: string[], h: SpawnHandlers = {}): EngineProcess {
  const proc = spawn(cfg.bin, [...(cfg.prefixArgs ?? []), ...args], { cwd: cfg.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let carry: Buffer = Buffer.alloc(0)
  let tail = ''
  let spawnError: string | undefined

  proc.stdout!.on('data', (chunk: Buffer) => {
    const r = splitLines(chunk, carry)
    carry = r.carry
    for (const l of r.lines) if (l.length) h.onLine?.(l)
  })
  proc.stdout!.on('end', () => {
    if (carry.length) {
      const l = carry.toString('utf8').replace(/\r$/, '')
      carry = Buffer.alloc(0)
      if (l.length) h.onLine?.(l)
    }
  })
  proc.stderr!.on('data', (chunk: Buffer) => {
    const t = chunk.toString('utf8')
    tail = (tail + t).slice(-STDERR_TAIL_CHARS)
    h.onStderr?.(t)
  })

  const done = new Promise<EngineExit>((resolve) => {
    let settled = false
    const settle = (r: EngineExit) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    proc.on('error', (e) => {
      spawnError = e.message
      settle({ code: null, signal: null, error: spawnError, stderrTail: tail })
    })
    proc.on('close', (code, signal) => settle({ code, signal, error: spawnError, stderrTail: tail }))
  })
  return { proc, done }
}

export interface CatalogInfo {
  /** 引擎输出的目录原文加 `generated_at`（服务端记录取得时间，docs/component-catalog.md §2） */
  catalog: Record<string, unknown>
  engine_version: string
  generated_at: string
  /** 组件类型名集合 */
  types: Set<string>
  /** 每个组件的内部参数名（`internal: true`），框图里出现即 400（D-037） */
  internal: Map<string, Set<string>>
}

export type ValidateResult =
  | { ok: true; event: EngineEvent }
  | { ok: false; error: DiagramError }

/** 引擎客户端：目录缓存、只校验、拉起运行。运行进程的生命周期由任务管理器掌管。 */
export class Engine {
  private catalogCache: Promise<CatalogInfo> | null = null

  constructor(readonly cfg: EngineConfig) {}

  async available(): Promise<boolean> {
    try {
      await fsp.access(this.cfg.bin, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }

  /** 组件目录，进程内只取一次；失败不缓存，下次再试。 */
  catalog(): Promise<CatalogInfo> {
    if (!this.catalogCache) {
      this.catalogCache = this.loadCatalog().catch((e) => {
        this.catalogCache = null
        throw e
      })
    }
    return this.catalogCache
  }

  /** 已缓存的目录（不触发加载），健康检查用。 */
  async cachedCatalog(): Promise<CatalogInfo | null> {
    if (!this.catalogCache) return null
    try {
      return await this.catalogCache
    } catch {
      return null
    }
  }

  private async loadCatalog(): Promise<CatalogInfo> {
    const lines: string[] = []
    const ep = spawnEngine(this.cfg, ['--catalog'], { onLine: (l) => lines.push(l) })
    const exit = await ep.done
    if (exit.error) throw new EngineUnavailableError(`引擎起不来：${exit.error}`)
    if (exit.code !== 0) throw new Error(`cuav_run --catalog 退出码 ${exit.code}：${exit.stderrTail.trim()}`)
    const cat = JSON.parse(lines.join('\n')) as Record<string, unknown>
    if (cat.schema_version !== 'cuav-catalog/1' || !Array.isArray(cat.components)) {
      throw new Error('cuav_run --catalog 输出不是 cuav-catalog/1')
    }
    const types = new Set<string>()
    const internal = new Map<string, Set<string>>()
    for (const c of cat.components as Array<Record<string, unknown>>) {
      if (typeof c.type !== 'string') continue
      types.add(c.type)
      const names = new Set<string>()
      for (const p of (Array.isArray(c.params) ? c.params : []) as Array<Record<string, unknown>>) {
        if (p.internal === true && typeof p.name === 'string') names.add(p.name)
      }
      if (names.size) internal.set(c.type, names)
    }
    const generated_at = new Date().toISOString()
    return {
      catalog: { ...cat, generated_at },
      engine_version: typeof cat.engine_version === 'string' ? cat.engine_version : '',
      generated_at,
      types,
      internal,
    }
  }

  /**
   * 只校验（不落盘）。路径相对仓库根。恒传 `--task-id`：引擎缺省会取文件名主干，落成「diagram」。
   * 引擎只发一条 `validate` 或一条 `error`；两者都没有（起不来之外的异常）归为 `engine` 码。
   */
  async validate(diagramRel: string, resolvedRel: string | undefined, taskId: string): Promise<ValidateResult> {
    const args = ['--validate', diagramRel, '--task-id', taskId]
    if (resolvedRel) args.push('--resolved', resolvedRel)
    const events: EngineEvent[] = []
    const ep = spawnEngine(this.cfg, args, {
      onLine: (l) => {
        const e = parseEvent(l)
        if (e) events.push(e)
      },
    })
    const exit = await ep.done
    if (exit.error) throw new EngineUnavailableError(`引擎起不来：${exit.error}`)
    const ok = events.find((e) => e.type === 'validate')
    if (exit.code === 0 && ok) return { ok: true, event: ok }
    const err = events.find((e) => e.type === 'error')
    if (err) return { ok: false, error: asDiagramError(err.payload) }
    return {
      ok: false,
      error: {
        code: 'engine',
        node_id: '',
        port: '',
        message: `cuav_run --validate 退出码 ${exit.code ?? exit.signal}，无错误事件：${exit.stderrTail.trim()}`,
      },
    }
  }

  /** 拉起 `--run`。参数由调用方按约定拼好（相对路径、`/` 分隔、显式 `--task-id`）。 */
  run(args: string[], h: SpawnHandlers): EngineProcess {
    return spawnEngine(this.cfg, ['--run', ...args], h)
  }
}
