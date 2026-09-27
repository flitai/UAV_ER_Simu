// 覆盖场（探测范围）端点（D-080；docs/api-versions.md §3.1f）。
//
//   POST /api/v1/coverage   请求体 = cuav-field-request/1 + scenario_id
//                           响应体 = float32 小端网格：先合并、再按场景站序逐站，每层 nx × ny、行主序、第 0 行在北
//                           响应头 X-CUAV-Field = 事实摘要（JSON，encodeURIComponent 过，免得非 ASCII 进头）
//
// 同步调引擎，与 PUT 场景调 --scenario-track 同一个路数：服务端不复刻物理、不复刻校验，
// 只把场景标识解析成仓库内路径（浏览器永远见不到服务器路径，D-037），语义与错误都来自引擎。
// 临时文件放 data/tmp/coverage/（不入 git、不在 data/runs 里——那里的目录会被当成任务），用完即删。

import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { EngineUnavailableError, type Engine } from './tasks/engine.js'
import type { ScenarioIndex } from './tasks/resolve.js'

const SCENARIO_ID = /^[a-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 64 * 1024
const TMP_REL = 'data/tmp/coverage'

export interface CoverageDeps {
  root: string
  index: ScenarioIndex
  engine: Engine
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const b = c as Buffer
    size += b.length
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function handleCoverageRoutes(deps: CoverageDeps, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (pathname !== '/api/v1/coverage') return false
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' })
    return true
  }
  void postCoverage(deps, req, res)
  return true
}

async function postCoverage(deps: CoverageDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>
  } catch (e) {
    sendJson(res, 400, { error: 'bad_json', message: String((e as Error).message ?? e) })
    return
  }
  const id = body.scenario_id
  if (typeof id !== 'string' || !SCENARIO_ID.test(id)) {
    sendJson(res, 400, { error: 'bad_scenario_id', message: 'scenario_id 必须匹配 [a-z0-9_-]{1,64}' })
    return
  }
  await deps.index.ensureLoaded()
  const entry = deps.index.get(id)
  if (!entry) {
    sendJson(res, 404, { error: 'not_found', message: `没有场景 ${id}` })
    return
  }
  const { scenario_id: _drop, ...request } = body
  void _drop
  const tag = randomUUID()
  const reqRel = `${TMP_REL}/${tag}.json`
  const outRel = `${TMP_REL}/${tag}.f32`
  await fsp.mkdir(join(deps.root, TMP_REL), { recursive: true })
  try {
    await fsp.writeFile(join(deps.root, reqRel), JSON.stringify(request), 'utf8')
    const r = await deps.engine.field(reqRel, entry.pathRel, outRel)
    if (!r.ok) {
      sendJson(res, 400, { error: 'field_invalid', detail: r.error })
      return
    }
    const grid = await fsp.readFile(join(deps.root, outRel))
    // 网格已在内存里：先删临时文件再回，客户端拿到响应时盘上已经干净（finally 只兜错误路径）
    await cleanup(deps.root, reqRel, outRel)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': grid.length,
      'x-cuav-field': encodeURIComponent(JSON.stringify(r.meta)),
      'cache-control': 'no-store',
    })
    res.end(grid)
  } catch (e) {
    if (e instanceof EngineUnavailableError) sendJson(res, 503, { error: 'engine_unavailable', message: e.message })
    else sendJson(res, 500, { error: 'coverage', message: String((e as Error).message ?? e) })
  } finally {
    await cleanup(deps.root, reqRel, outRel)
  }
}

async function cleanup(root: string, ...rels: string[]): Promise<void> {
  for (const r of rels) await fsp.rm(join(root, r), { force: true })
}
