// 场景文件的读写端点（06 备忘录 §9C G-4；docs/api-versions.md §3.3）。
//
//   GET  /api/v1/scenarios          场景清单（摘要，不含全文）
//   GET  /api/v1/scenarios/{id}     场景全文 + X-CUAV-Sha256
//   PUT  /api/v1/scenarios/{id}     写入场景
//
// 校验分两层，与 B-5 的框图路数一致（D-042「服务端不复刻 schema，语义交引擎」）：
// 服务端只做最小结构检查与标识合法性，**语义校验调 cuav_run --scenario-track 看退出码**。
//
// 哈希的口径：算的是**落盘字节**的 SHA-256，PUT 的响应把它回给前端写进框图 scenario_ref。
// 两端各自 JSON.stringify 再算哈希是不行的——缩进或键序差一点哈希就变，引擎那边核对必然失败。

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Engine } from './tasks/engine.js'
import { ScenarioIndex } from './tasks/resolve.js'

const SCENARIO_ID = /^[a-z0-9_-]{1,64}$/
const AOI_ID = /^[a-z0-9][a-z0-9-]*$/
const MAX_BODY_BYTES = 256 * 1024

export interface ScenarioDeps {
  root: string
  index: ScenarioIndex
  engine: Engine
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
    if (size > MAX_BODY_BYTES) throw new Error(`场景文件超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 摘要：给场景选择器用，不含全文。 */
function summarize(id: string, aoi: string, doc: Record<string, unknown>): Record<string, unknown> {
  const time = (doc.time ?? {}) as Record<string, unknown>
  const sites = Array.isArray(doc.sites) ? doc.sites : []
  const emitters = Array.isArray(doc.emitters) ? doc.emitters : []
  return {
    scenario_id: id,
    aoi,
    name: typeof doc.name === 'string' ? doc.name : id,
    duration_s: typeof time.duration_s === 'number' ? time.duration_s : null,
    sites: sites.length,
    emitters: emitters.length,
    // 界面据此标「基准 · 只读」并把保存按钮换成「另存为」（用户 2026-09-19）
    readonly: isGoldenScenario(id),
  }
}

export function handleScenarioRoutes(
  deps: ScenarioDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname === '/api/v1/scenarios') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' })
      return true
    }
    void listScenarios(deps, res)
    return true
  }
  const m = /^\/api\/v1\/scenarios\/([^/]+)$/.exec(pathname)
  if (!m) return false
  const id = decodeURIComponent(m[1])
  if (!SCENARIO_ID.test(id)) {
    sendJson(res, 400, { error: 'bad_scenario_id', message: '场景标识必须匹配 [a-z0-9_-]{1,64}' })
    return true
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    void getScenario(deps, res, id)
    return true
  }
  if (req.method === 'PUT') {
    void putScenario(deps, req, res, id)
    return true
  }
  sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD, PUT' })
  return true
}

async function listScenarios(deps: ScenarioDeps, res: ServerResponse): Promise<void> {
  try {
    await deps.index.load()
    const out: Array<Record<string, unknown>> = []
    for (const e of deps.index.list()) {
      const text = await fsp.readFile(join(deps.root, e.pathRel), 'utf8').catch(() => null)
      if (text === null) continue
      try {
        out.push(summarize(e.scenario_id, e.aoi, JSON.parse(text) as Record<string, unknown>))
      } catch {
        /* 坏文件跳过：清单端点不该因为一个坏文件整个挂掉 */
      }
    }
    sendJson(res, 200, { scenarios: out })
  } catch (e) {
    sendJson(res, 500, { error: 'scenario_index', message: String((e as Error).message ?? e) })
  }
}

async function getScenario(deps: ScenarioDeps, res: ServerResponse, id: string): Promise<void> {
  try {
    await deps.index.ensureLoaded()
    const e = deps.index.get(id)
    if (!e) {
      sendJson(res, 404, { error: 'not_found', message: `没有场景 ${id}` })
      return
    }
    const buf = await fsp.readFile(join(deps.root, e.pathRel))
    const sha = createHash('sha256').update(buf).digest('hex')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'x-cuav-sha256': sha,
      'x-cuav-aoi': e.aoi,
    })
    res.end(buf)
  } catch (err) {
    sendJson(res, 500, { error: 'scenario_read', message: String((err as Error).message ?? err) })
  }
}

/**
 * 基准场景的判据：**标识以 `golden-` 开头**（用户 2026-09-19 定的命名约定）。
 *
 * 规则放在名字上而不是另立一份名单，是因为名单会漏——加一个基准场景却忘了登记，
 * 它就又变成可写的了。名字是跟着文件走的，改不了也漏不掉。
 */
export function isGoldenScenario(id: string): boolean {
  return id.startsWith('golden-')
}

async function putScenario(
  deps: ScenarioDeps,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  // **基准场景只读**（用户 2026-09-19 拍板）。它们的字节被黄金基准钉着——航迹基准、
  // 回归夹具的 `scenario_ref.sha256`、界面缺省链的文本都对着它算；在场景页随手改一下
  // 就会把这一串弄不一致，而自动保存（D-054 ⑥）连问都不问。
  //
  // 界面上也拦（下拉里标「基准 · 只读」、保存按钮变「另存为」），但**界面拦不住手写的请求**，
  // 所以这里是真闸——与 D-058 ② 「界面置灰 + 引擎也拒」同一条路数。
  if (isGoldenScenario(id)) {
    sendJson(res, 409, {
      error: 'scenario_readonly',
      message: `${id} 是基准场景，只读：它的哈希被黄金基准与回归夹具钉着。改它请「另存为」一个新标识（新标识不能以 golden- 开头）`,
    })
    return
  }
  let text: string
  try {
    text = await readBody(req)
  } catch (e) {
    sendJson(res, 413, { error: 'too_large', message: String((e as Error).message ?? e) })
    return
  }
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(text) as Record<string, unknown>
  } catch (e) {
    sendJson(res, 400, { error: 'json_parse', message: String((e as Error).message ?? e) })
    return
  }
  // 最小结构检查：只查服务端必须知道的两件事——标识对得上、观测区域存在。其余交引擎。
  if (doc.scenario_id !== id) {
    sendJson(res, 400, {
      error: 'scenario_id_mismatch',
      message: `路径里的场景标识是 ${id}，文件里写的是 ${String(doc.scenario_id)}`,
    })
    return
  }
  const aoiObj = (doc.aoi ?? {}) as Record<string, unknown>
  const aoi = typeof aoiObj.id === 'string' ? aoiObj.id : ''
  if (!AOI_ID.test(aoi)) {
    sendJson(res, 400, { error: 'bad_aoi', message: 'aoi.id 必须是小写标识' })
    return
  }
  const dirAbs = join(deps.root, 'data', 'scene', aoi)
  try {
    await fsp.access(join(dirAbs, 'manifest.json'))
  } catch {
    sendJson(res, 400, { error: 'unknown_aoi', message: `观测区域 ${aoi} 不在 data/scene/ 下` })
    return
  }

  const scenariosAbs = join(dirAbs, 'scenarios')
  await fsp.mkdir(scenariosAbs, { recursive: true })
  const rel = `data/scene/${aoi}/scenarios/${id}.scenario.json`
  const tmpRel = `data/scene/${aoi}/scenarios/${id}.scenario.json.tmp`
  const tmpAbs = join(deps.root, tmpRel)
  const finalAbs = join(deps.root, rel)

  // 先落临时文件再交引擎校验：语义只在引擎一处解释（D-042）。
  const body = text.endsWith('\n') ? text : text + '\n'
  await fsp.writeFile(tmpAbs, body, 'utf8')
  try {
    const v = await deps.engine.validateScenario(tmpRel)
    if (!v.ok) {
      await fsp.rm(tmpAbs, { force: true })
      sendJson(res, 400, { error: 'scenario_invalid', detail: v.error })
      return
    }
  } catch (e) {
    await fsp.rm(tmpAbs, { force: true })
    sendJson(res, 503, { error: 'engine_unavailable', message: String((e as Error).message ?? e) })
    return
  }
  await fsp.rename(tmpAbs, finalAbs)
  await deps.index.load()

  // 回传落盘字节的哈希：前端据此写框图的 scenario_ref.sha256。
  const sha = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
  sendJson(res, 200, { scenario_id: id, aoi, sha256: sha, bytes: Buffer.byteLength(body) })
}
