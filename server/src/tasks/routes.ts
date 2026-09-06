// 任务与组件目录的 HTTP 端点（docs/api-versions.md §3.3，B-5）。
//
//   GET  /api/v1/components            组件目录（缓存引擎 --catalog 输出，附 generated_at）
//   POST /api/v1/tasks                 提交框图 → 201 任务摘要；幂等命中 200；400 diagram_invalid；503 引擎缺失
//   GET  /api/v1/tasks[?limit=N]       任务列表（created_utc 降序）
//   GET  /api/v1/tasks/{id}            任务摘要（task.json 内容）
//   POST /api/v1/tasks/{id}/cancel     取消：排队中立即；运行中杀进程；已结束 409
//   GET  /api/v1/tasks/{id}/events?since&limit   按序号补取事件（B-6）：缓冲内切片、缓冲外读 events.jsonl，
//                                      product_row 在这里永远是文本（无数据），数据走 WS 二进制帧或 B-7 端点
//
// 这里只做 HTTP：读体、限长、状态码映射。业务在 manager.ts。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from '../static.js'
import { Engine, EngineUnavailableError } from './engine.js'
import { HttpError, type TaskManager } from './manager.js'
import { isTaskId } from './store.js'

export interface TaskRouteDeps {
  mgr: TaskManager
  engine: Engine
}

export const MAX_BODY_BYTES = 1024 * 1024

const RE_TASK = /^\/api\/v1\/tasks\/([^/]+)$/
const RE_CANCEL = /^\/api\/v1\/tasks\/([^/]+)\/cancel$/
const RE_EVENTS = /^\/api\/v1\/tasks\/([^/]+)\/events$/
export const EVENTS_LIMIT_DEFAULT = 1000
export const EVENTS_LIMIT_MAX = 5000

/** 命中任务路由返回 true（含 405）；不是任务路由返回 false，交回主路由。 */
export async function handleTaskRoutes(req: IncomingMessage, res: ServerResponse, url: URL, deps: TaskRouteDeps): Promise<boolean> {
  const path = url.pathname
  const method = req.method ?? 'GET'
  try {
    if (path === '/api/v1/components') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
      const info = await deps.engine.catalog()
      sendJson(res, 200, info.catalog)
      return true
    }
    if (path === '/api/v1/tasks') {
      if (method === 'GET' || method === 'HEAD') {
        const limit = parseLimit(url.searchParams.get('limit'))
        sendJson(res, 200, { tasks: deps.mgr.list(limit) })
        return true
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const key = req.headers['idempotency-key']
        const r = await deps.mgr.submit({ body, idempotencyKey: typeof key === 'string' && key.length ? key : undefined })
        sendJson(res, r.status, r.task)
        return true
      }
      return methodNotAllowed(res, 'GET, HEAD, POST')
    }
    const mc = RE_CANCEL.exec(path)
    if (mc) {
      if (method !== 'POST') return methodNotAllowed(res, 'POST')
      const id = decodeURIComponent(mc[1])
      if (!isTaskId(id)) return notFound(res, id)
      sendJson(res, 200, await deps.mgr.cancel(id))
      return true
    }
    const me = RE_EVENTS.exec(path)
    if (me) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
      const id = decodeURIComponent(me[1])
      const rec = isTaskId(id) ? deps.mgr.get(id) : null
      if (!rec) return notFound(res, id)
      const since = parseSince(url.searchParams.get('since'))
      if (since === null) {
        sendJson(res, 400, { error: 'bad_request', message: 'since 必须是不小于 0 的整数' })
        return true
      }
      const limit = parseEventsLimit(url.searchParams.get('limit'))
      const events = (await deps.mgr.readEvents(id, since, limit)) ?? []
      sendJson(res, 200, { task_id: id, since, events, last_seq: rec.last_seq, run_state: rec.run_state })
      return true
    }
    const mt = RE_TASK.exec(path)
    if (mt) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
      const id = decodeURIComponent(mt[1])
      const rec = isTaskId(id) ? deps.mgr.get(id) : null
      if (!rec) return notFound(res, id)
      sendJson(res, 200, rec)
      return true
    }
    return false
  } catch (e) {
    if (e instanceof HttpError) {
      sendJson(res, e.status, e.body)
      return true
    }
    if (e instanceof EngineUnavailableError) {
      sendJson(res, 503, { error: 'engine_unavailable', message: e.message })
      return true
    }
    throw e
  }
}

function methodNotAllowed(res: ServerResponse, allow: string): true {
  res.writeHead(405, { allow })
  res.end()
  return true
}

function notFound(res: ServerResponse, id: string): true {
  sendJson(res, 404, { error: 'not_found', task_id: id })
  return true
}

/** since 缺省 0；非整数或负数返回 null（→ 400）。 */
function parseSince(v: string | null): number | null {
  if (v === null || v === '') return 0
  if (!/^\d{1,15}$/.test(v)) return null
  return Number(v)
}

function parseEventsLimit(v: string | null): number {
  const n = v === null ? NaN : Number(v)
  if (!Number.isFinite(n) || n < 1) return EVENTS_LIMIT_DEFAULT
  return Math.min(EVENTS_LIMIT_MAX, Math.floor(n))
}

function parseLimit(v: string | null): number {
  const n = v === null ? NaN : Number(v)
  if (!Number.isFinite(n) || n < 1) return 100
  return Math.min(1000, Math.floor(n))
}

/** 读 JSON 请求体：非 JSON 类型 415、超 1 MB 413、解析失败 400（与框图错误同形，code = json_parse）。 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '')
    if (!/^application\/json\b/i.test(ct)) {
      reject(new HttpError(415, { error: 'unsupported_media_type', message: '请求体必须是 application/json' }))
      req.resume()
      return
    }
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, { error: 'payload_too_large', max_bytes: MAX_BODY_BYTES }))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        done = true
        reject(new HttpError(413, { error: 'payload_too_large', max_bytes: MAX_BODY_BYTES }))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(new HttpError(400, {
          error: 'diagram_invalid',
          detail: { code: 'json_parse', node_id: '', port: '', message: `请求体不是合法 JSON：${String(e instanceof Error ? e.message : e)}` },
        }))
      }
    })
    req.on('error', (e) => {
      if (done) return
      done = true
      reject(new HttpError(400, { error: 'bad_request', message: String(e) }))
    })
  })
}
