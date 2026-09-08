// 框图文件的读写端点（06 备忘录 §9G C-6；决策 D-051；docs/api-versions.md §3.1d）。
//
//   GET    /api/v1/diagrams          框图清单（摘要，不含全文）
//   GET    /api/v1/diagrams/{id}     框图全文 + X-CUAV-Sha256
//   PUT    /api/v1/diagrams/{id}     写入框图
//   DELETE /api/v1/diagrams/{id}     删除框图
//
// 此前框图不落盘（`docs/diagram-canvas-guide.md` §5.1：刷新即丢，只有提交过的任务在
// data/runs/<任务号>/diagram.json 里留副本）。典型链路视图是「改参数、跑、再改」的循环，
// 参数集必须能存能再开，所以 C-6 把这一步补上。
//
// 三条与场景端点（G-4）相同的约定：
//   ① **规范序列化形式是 `JSON.stringify(doc, null, 2)` 加一个末尾换行**，与场景文件同法（D-049 ⑧）。
//      不改内容的保存因此是逐字节的空操作。
//   ② 校验分两层：服务端只做最小结构检查、内部参数检查与标识解析，**语义交引擎 --validate**（D-042）。
//   ③ 先落临时文件、过了校验再原子改名，坏框图不会覆盖盘上的好框图。
//
// 与任务提交共用 `prepareDiagram()`：同一份框图在两处必须得到同一个判断，复制一遍迟早分叉。

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Engine } from './tasks/engine.js'
import { DataIndex, ScenarioIndex } from './tasks/resolve.js'
import { HttpError, checkShape, prepareDiagram } from './tasks/manager.js'

const DIAGRAM_ID = /^[a-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 1024 * 1024
/** 框图目录。小文件、可入库，与场景文件同待遇。 */
export const DIAGRAMS_REL = 'data/diagrams'
const SUFFIX = '.diagram.json'

export interface DiagramDeps {
  root: string
  engine: Engine
  dataIndex: DataIndex
  scenarioIndex: ScenarioIndex
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const b = c as Buffer
    size += b.length
    if (size > MAX_BODY_BYTES) throw new Error(`框图文件超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 摘要：给「打开框图」列表用，不含全文。 */
function summarize(doc: Record<string, unknown>, mtime: string, bytes: number): Record<string, unknown> {
  const tref = (doc.template_ref ?? null) as Record<string, unknown> | null
  const sref = (doc.scenario_ref ?? null) as Record<string, unknown> | null
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  const ops = Array.isArray(doc.observation_points) ? doc.observation_points : []
  return {
    diagram_id: doc.diagram_id,
    name: typeof doc.name === 'string' ? doc.name : doc.diagram_id,
    // 有 template_ref 的能回到典型链路视图，没有的只能在自由画布打开（10 报告 §5.5）
    template_id: tref && typeof tref.template_id === 'string' ? tref.template_id : null,
    mode: tref && typeof tref.mode === 'string' ? tref.mode : null,
    scenario_id: sref && typeof sref.scenario_id === 'string' ? sref.scenario_id : null,
    nodes: nodes.length,
    observation_points: ops.length,
    bytes,
    modified_utc: mtime,
  }
}

export function handleDiagramRoutes(
  deps: DiagramDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname === '/api/v1/diagrams') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' })
      return true
    }
    void listDiagrams(deps, res)
    return true
  }
  const m = /^\/api\/v1\/diagrams\/([^/]+)$/.exec(pathname)
  if (!m) return false
  const id = decodeURIComponent(m[1]!)
  if (!DIAGRAM_ID.test(id)) {
    sendJson(res, 400, { error: 'bad_diagram_id', message: '框图标识必须匹配 [a-z0-9_-]{1,64}' })
    return true
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    void getDiagram(deps, res, id)
    return true
  }
  if (req.method === 'PUT') {
    void putDiagram(deps, req, res, id)
    return true
  }
  if (req.method === 'DELETE') {
    void deleteDiagram(deps, res, id)
    return true
  }
  sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD, PUT, DELETE' })
  return true
}

function fileAbs(root: string, id: string): string {
  return join(root, DIAGRAMS_REL, id + SUFFIX)
}

async function listDiagrams(deps: DiagramDeps, res: ServerResponse): Promise<void> {
  try {
    const dir = join(deps.root, DIAGRAMS_REL)
    let names: string[] = []
    try {
      names = await fsp.readdir(dir)
    } catch {
      // 目录还不存在：返回空清单，不是错误
      sendJson(res, 200, { diagrams: [] })
      return
    }
    const out: Array<Record<string, unknown>> = []
    for (const n of names.sort()) {
      if (!n.endsWith(SUFFIX)) continue
      const id = n.slice(0, -SUFFIX.length)
      if (!DIAGRAM_ID.test(id)) continue
      const abs = join(dir, n)
      const [text, st] = await Promise.all([
        fsp.readFile(abs, 'utf8').catch(() => null),
        fsp.stat(abs).catch(() => null),
      ])
      if (text === null || st === null) continue
      try {
        // 坏文件跳过：清单端点不该因为一个坏文件整个挂掉（与场景清单同法）
        out.push(summarize(JSON.parse(text) as Record<string, unknown>, st.mtime.toISOString(), st.size))
      } catch {
        /* 跳过 */
      }
    }
    sendJson(res, 200, { diagrams: out })
  } catch (e) {
    sendJson(res, 500, { error: 'diagram_list', message: String((e as Error).message ?? e) })
  }
}

async function getDiagram(deps: DiagramDeps, res: ServerResponse, id: string): Promise<void> {
  try {
    const buf = await fsp.readFile(fileAbs(deps.root, id))
    const sha = createHash('sha256').update(buf).digest('hex')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'x-cuav-sha256': sha,
    })
    res.end(buf)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      sendJson(res, 404, { error: 'not_found', message: `没有框图 ${id}` })
      return
    }
    sendJson(res, 500, { error: 'diagram_read', message: String((err as Error).message ?? err) })
  }
}

async function putDiagram(
  deps: DiagramDeps,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  let text: string
  try {
    text = await readBody(req)
  } catch (e) {
    sendJson(res, 413, { error: 'too_large', message: String((e as Error).message ?? e) })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (e) {
    sendJson(res, 400, {
      error: 'diagram_invalid',
      detail: { code: 'json_parse', node_id: '', port: '', message: String((e as Error).message ?? e) },
    })
    return
  }

  // 最小结构检查 + 内部参数 + data_id / scenario_id 解析，与任务提交共用一条路径
  let prep: Awaited<ReturnType<typeof prepareDiagram>>
  let shaped: ReturnType<typeof checkShape>
  let canonical: string
  let sha: string
  try {
    shaped = checkShape(body)
    if (shaped.diagram_id !== id) {
      throw new HttpError(400, {
        error: 'diagram_id_mismatch',
        message: `路径里的框图标识是 ${id}，文件里写的是 ${shaped.diagram_id}`,
      })
    }
    // 规范序列化：落盘与哈希都用它，「不改内容的保存」因此是逐字节的空操作
    canonical = JSON.stringify(shaped.raw, null, 2) + '\n'
    sha = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex')
    prep = await prepareDiagram(deps, shaped, sha)
  } catch (e) {
    if (e instanceof HttpError) {
      sendJson(res, e.status, e.body)
      return
    }
    sendJson(res, 500, { error: 'diagram_prepare', message: String((e as Error).message ?? e) })
    return
  }

  const dirAbs = join(deps.root, DIAGRAMS_REL)
  await fsp.mkdir(dirAbs, { recursive: true })
  const tmpRel = `${DIAGRAMS_REL}/${id}${SUFFIX}.tmp`
  const tmpAbs = join(deps.root, tmpRel)
  const sideRel = `${DIAGRAMS_REL}/${id}.resolved.json.tmp`
  const sideAbs = join(deps.root, sideRel)

  // 先落临时文件再交引擎校验：语义只在引擎一处解释（D-042）。
  // 临时文件用仓库相对路径传给引擎，引擎的窄字符 main() 见不到可能含中文的绝对根目录（D-042 ②）。
  await fsp.writeFile(tmpAbs, canonical, 'utf8')
  if (prep.sidecar) await fsp.writeFile(sideAbs, JSON.stringify(prep.sidecar, null, 2) + '\n', 'utf8')
  const cleanup = async (): Promise<void> => {
    await fsp.rm(tmpAbs, { force: true })
    await fsp.rm(sideAbs, { force: true })
  }
  try {
    const v = await deps.engine.validate(tmpRel, prep.sidecar ? sideRel : undefined, id)
    if (!v.ok) {
      await cleanup()
      sendJson(res, 400, { error: 'diagram_invalid', detail: v.error })
      return
    }
  } catch (e) {
    await cleanup()
    sendJson(res, 503, { error: 'engine_unavailable', message: String((e as Error).message ?? e) })
    return
  }
  await fsp.rm(sideAbs, { force: true })     // 旁挂只是校验的脚手架，不入库
  await fsp.rename(tmpAbs, fileAbs(deps.root, id))

  sendJson(res, 200, {
    diagram_id: id,
    sha256: sha,
    bytes: Buffer.byteLength(canonical),
    warnings: prep.warnings,
  })
}

async function deleteDiagram(deps: DiagramDeps, res: ServerResponse, id: string): Promise<void> {
  try {
    await fsp.unlink(fileAbs(deps.root, id))
    sendJson(res, 200, { diagram_id: id, deleted: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      sendJson(res, 404, { error: 'not_found', message: `没有框图 ${id}` })
      return
    }
    sendJson(res, 500, { error: 'diagram_delete', message: String((err as Error).message ?? err) })
  }
}
