// data_id 解析与路径脱敏（06 备忘录 §9A B-5；决策 D-037、D-040、D-042）。
//
// 框图里对实测数据的引用只写 data_id；服务端在这里把它解析成清单文件的位置，写成解析旁挂
// diagram.resolved.json（cuav-resolved/1，docs/diagram-format.md §9）交给引擎。旁挂里的路径相对仓库根、
// 用 `/` 分隔、纯 ASCII，与引擎 IndexDataResolver 的 `<索引目录>/<data_id>.manifest.json` 规则一致。
//
// 脱敏：浏览器永不见服务器路径（04 §8.6）。引擎事件在进入服务端缓冲前对整行做替换：先把仓库根的绝对
// 前缀剥掉，再把每个清单相对路径换回 data_id。整行替换而不是只改 payload.message，是因为 task.state 的
// reasons[] 与 nodes[].notes[] 复制了同一段文字。

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export const IQ_KINDS = ['measured', 'synthetic', 'mixed'] as const
const INDEX_SCHEMA = 'cuav-batch-index/1'
const HOLDOUT_SCHEMA = 'cuav-holdout-manifest/1'
/** 目录名与 data_id 都必须是 ASCII 标识：它们要进相对路径与旁挂 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

export interface DataEntry {
  data_id: string
  kind: string
  batch: string
  /** 相对仓库根、`/` 分隔的清单路径 */
  manifestRel: string
}

/** 各批数据索引的合并视图。懒加载，`load()` 可重复调用以刷新。 */
export class DataIndex {
  private table = new Map<string, DataEntry>()
  private holdout = new Set<string>()
  private loaded = false

  constructor(private readonly root: string) {}

  get size(): number {
    return this.table.size
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  async load(): Promise<void> {
    const table = new Map<string, DataEntry>()
    const holdout = new Set<string>()
    for (const kind of IQ_KINDS) {
      const kindDir = join(this.root, 'data', 'iq', kind)
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(kindDir, { withFileTypes: true })
      } catch {
        continue
      }
      await readHoldout(join(kindDir, 'holdout.manifest.json'), holdout)
      for (const e of entries) {
        if (!e.isDirectory() || !SAFE_NAME.test(e.name)) continue
        const idx = await readJson(join(kindDir, e.name, 'index.manifest.json'))
        if (idx && idx.schema === INDEX_SCHEMA && Array.isArray(idx.products)) {
          for (const p of idx.products as Array<Record<string, unknown>>) {
            const id = p?.data_id
            if (typeof id !== 'string' || !SAFE_NAME.test(id)) continue
            const rel = `data/iq/${kind}/${e.name}/${id}.manifest.json`
            const prev = table.get(id)
            if (prev && prev.manifestRel !== rel) {
              throw new Error(`data_id 在多份索引里重复且位置不同：${id}（${prev.manifestRel} 与 ${rel}）`)
            }
            table.set(id, { data_id: id, kind, batch: e.name, manifestRel: rel })
          }
        }
        await readHoldout(join(kindDir, e.name, 'holdout.manifest.json'), holdout)
      }
    }
    this.table = table
    this.holdout = holdout
    this.loaded = true
  }

  get(dataId: string): DataEntry | undefined {
    return this.table.get(dataId)
  }

  isHoldout(dataId: string): boolean {
    return this.holdout.has(dataId)
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const j: unknown = JSON.parse(await fsp.readFile(path, 'utf8'))
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function readHoldout(path: string, into: Set<string>): Promise<void> {
  const j = await readJson(path)
  if (!j || j.schema !== HOLDOUT_SCHEMA || !Array.isArray(j.holdout)) return
  for (const h of j.holdout as Array<Record<string, unknown>>) {
    if (typeof h?.data_id === 'string') into.add(h.data_id)
  }
}

export interface MissingDataId {
  data_id: string
  reason: string
}

export interface ResolveResult {
  /** data_id → 相对清单路径，即旁挂的 `data` */
  data: Record<string, string>
  missing: MissingDataId[]
  /** 命中验收集的 data_id（允许回放但要提示，D-038） */
  holdout: string[]
}

/** 解析一组 data_id；每个都核对清单文件在盘上。顺序与输入一致，重复的 id 只算一次。 */
export async function resolveDataIds(index: DataIndex, root: string, ids: Iterable<string>): Promise<ResolveResult> {
  await index.ensureLoaded()
  const out: ResolveResult = { data: {}, missing: [], holdout: [] }
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const e = index.get(id)
    if (!e) {
      out.missing.push({ data_id: id, reason: `data_id 不在任何数据索引里：${id}` })
      continue
    }
    try {
      await fsp.access(join(root, ...e.manifestRel.split('/')))
    } catch {
      out.missing.push({ data_id: id, reason: `索引里有 ${id} 但旁挂清单不在盘上` })
      continue
    }
    out.data[id] = e.manifestRel
    if (index.isHoldout(id)) out.holdout.push(id)
  }
  return out
}

export const RESOLVED_SCHEMA = 'cuav-resolved/1'

export interface ResolvedSidecar {
  schema_version: typeof RESOLVED_SCHEMA
  diagram_sha256: string
  data: Record<string, string>
  /** scenario_id → 场景文件相对路径（G-2 起）。没有场景绑定时不写这一段。 */
  scenarios?: Record<string, string>
}

export function buildSidecar(
  data: Record<string, string>,
  diagramSha256: string,
  scenarios?: Record<string, string>,
): ResolvedSidecar {
  const out: ResolvedSidecar = { schema_version: RESOLVED_SCHEMA, diagram_sha256: diagramSha256, data: { ...data } }
  if (scenarios && Object.keys(scenarios).length) out.scenarios = { ...scenarios }
  return out
}

/** 场景标识必须是 ASCII 小写标识：它要进相对路径与旁挂（docs/schemas/scenario.schema.json） */
const SCENARIO_ID = /^[a-z0-9_-]{1,64}$/

export interface ScenarioEntry {
  scenario_id: string
  aoi: string
  /** 相对仓库根、`/` 分隔的场景文件路径 */
  pathRel: string
}

/**
 * 场景文件索引：扫 data/scene/<aoi>/scenarios/*.scenario.json，按文件里声明的 scenario_id 建表。
 * 与 DataIndex 同构、同理由——框图里只写 scenario_id，路径只在服务端、旁挂与引擎进程里出现（D-037）。
 * 标识在两处出现即拒绝：不猜哪个是对的。
 */
export class ScenarioIndex {
  private table = new Map<string, ScenarioEntry>()
  private loaded = false

  constructor(private readonly root: string) {}

  get size(): number {
    return this.table.size
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  async load(): Promise<void> {
    const table = new Map<string, ScenarioEntry>()
    const sceneDir = join(this.root, 'data', 'scene')
    let aois: import('node:fs').Dirent[]
    try {
      aois = await fsp.readdir(sceneDir, { withFileTypes: true })
    } catch {
      this.table = table
      this.loaded = true
      return
    }
    for (const a of aois) {
      if (!a.isDirectory() || !SAFE_NAME.test(a.name)) continue
      const dir = join(sceneDir, a.name, 'scenarios')
      let files: string[]
      try {
        files = await fsp.readdir(dir)
      } catch {
        continue
      }
      for (const f of files.sort()) {
        if (!f.endsWith('.scenario.json')) continue
        const doc = await readJson(join(dir, f))
        const id = doc && typeof doc.scenario_id === 'string' ? doc.scenario_id : null
        if (!id || !SCENARIO_ID.test(id)) continue
        const pathRel = `data/scene/${a.name}/scenarios/${f}`
        const prev = table.get(id)
        if (prev && prev.pathRel !== pathRel) {
          throw new Error(`场景标识 ${id} 在两处出现：${prev.pathRel} 与 ${pathRel}`)
        }
        table.set(id, { scenario_id: id, aoi: a.name, pathRel })
      }
    }
    this.table = table
    this.loaded = true
  }

  get(id: string): ScenarioEntry | undefined {
    return this.table.get(id)
  }

  list(): ScenarioEntry[] {
    return [...this.table.values()].sort((a, b) => (a.scenario_id < b.scenario_id ? -1 : 1))
  }
}

/** JSON 字符串里的写法（去掉两端引号），用于匹配已被 JSON 转义的路径，如 Windows 的 `C:\\Work`。 */
function jsonInner(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

/**
 * 整行脱敏器。替换顺序：先剥仓库根的绝对前缀（`/`、`\` 两种分隔，含 JSON 转义形式），再把清单相对
 * 路径换成 data_id。替换值是 ASCII 标识，不会破坏 JSON 结构。引擎实际只见相对路径，第一步是保险。
 */
export function makeRedactor(root: string, data: Record<string, string>): (line: string) => string {
  const subs: Array<[string, string]> = []
  const prefixes = new Set<string>()
  const fwd = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const back = fwd.replace(/\//g, '\\')
  for (const p of [fwd + '/', back + '\\']) {
    prefixes.add(p)
    prefixes.add(jsonInner(p))
  }
  for (const p of prefixes) if (p.length > 1) subs.push([p, ''])
  for (const [id, rel] of Object.entries(data)) {
    subs.push([rel, id])
    const esc = jsonInner(rel)
    if (esc !== rel) subs.push([esc, id])
  }
  return (line: string) => {
    let s = line
    for (const [from, to] of subs) if (s.includes(from)) s = s.split(from).join(to)
    return s
  }
}
