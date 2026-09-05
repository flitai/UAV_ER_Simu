// 任务端点的 HTTP 层：状态码、限长、方法白名单、与 index.ts 的接线（B-5）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleTaskRoutes } from './routes.js'
import { createTaskManager, type TaskManager } from './manager.js'
import { fakeEngine, makeDataFixture, makeRoot, rmrf, slice1, waitFor } from './testkit.js'
import type { Engine } from './engine.js'
import type { TaskRecord } from './store.js'

let root = ''
let mgr: TaskManager
let engine: Engine
let srv: Server
let base = ''

before(async () => {
  root = await makeRoot()
  await makeDataFixture(root)
  engine = fakeEngine(root)
  mgr = createTaskManager({ root, engine })
  await mgr.init()
  srv = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (!(await handleTaskRoutes(req, res, url, { mgr, engine }))) {
        res.writeHead(404)
        res.end('nf')
      }
    })().catch((e) => {
      res.writeHead(500)
      res.end(String(e))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})
after(async () => {
  await new Promise<void>((r) => srv.close(() => r()))
  mgr.shutdownSync()
  await rmrf(root)
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('GET /api/v1/components：目录原文加 generated_at；POST 405', async () => {
  const r = await fetch(`${base}/api/v1/components`)
  assert.equal(r.status, 200)
  const j = (await r.json()) as Record<string, unknown>
  assert.equal(j.schema_version, 'cuav-catalog/1')
  assert.match(String(j.generated_at), /^\d{4}-/)
  assert.ok(Array.isArray(j.components))
  const p = await fetch(`${base}/api/v1/components`, { method: 'POST' })
  assert.equal(p.status, 405)
  assert.equal(p.headers.get('allow'), 'GET, HEAD')
})

test('POST /api/v1/tasks：非 JSON 415、超 1 MB 413、坏 JSON 400 json_parse', async () => {
  const a = await fetch(`${base}/api/v1/tasks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
  assert.equal(a.status, 415)
  const b = await post('/api/v1/tasks', JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }))
  assert.equal(b.status, 413)
  const c = await post('/api/v1/tasks', '{not json')
  assert.equal(c.status, 400)
  const cj = (await c.json()) as { error: string; detail: { code: string } }
  assert.equal(cj.error, 'diagram_invalid')
  assert.equal(cj.detail.code, 'json_parse')
})

test('提交、列表、单任务、幂等、取消、404 / 405 / 409', async () => {
  const body = await slice1()
  const r1 = await post('/api/v1/tasks', body, { 'Idempotency-Key': 'http-1' })
  assert.equal(r1.status, 201)
  const t1 = (await r1.json()) as TaskRecord
  assert.match(t1.task_id, /^t\d{8}-/)
  assert.equal(t1.idempotency_key, 'http-1')
  const r2 = await post('/api/v1/tasks', body, { 'Idempotency-Key': 'http-1' })
  assert.equal(r2.status, 200)
  assert.equal(((await r2.json()) as TaskRecord).task_id, t1.task_id)

  const list = await fetch(`${base}/api/v1/tasks`)
  assert.equal(list.status, 200)
  const lj = (await list.json()) as { tasks: TaskRecord[] }
  assert.ok(lj.tasks.some((t) => t.task_id === t1.task_id))
  const one = await fetch(`${base}/api/v1/tasks/${t1.task_id}`)
  assert.equal(one.status, 200)
  assert.equal(((await one.json()) as TaskRecord).task_id, t1.task_id)
  assert.equal((await fetch(`${base}/api/v1/tasks/t00000000-000000-0000`)).status, 404)
  assert.equal((await fetch(`${base}/api/v1/tasks/bad%20id`)).status, 404)
  const put = await fetch(`${base}/api/v1/tasks`, { method: 'PUT' })
  assert.equal(put.status, 405)
  assert.equal(put.headers.get('allow'), 'GET, HEAD, POST')
  assert.equal((await fetch(`${base}/api/v1/tasks/${t1.task_id}/cancel`)).status, 405)
  assert.equal((await fetch(`${base}/api/v1/tasks/t00000000-000000-0000/cancel`, { method: 'POST' })).status, 404)

  await waitFor(() => (mgr.get(t1.task_id)!.run_state === 'finished' ? true : undefined), '任务结束')
  const c = await fetch(`${base}/api/v1/tasks/${t1.task_id}/cancel`, { method: 'POST' })
  assert.equal(c.status, 409)
  assert.equal(((await c.json()) as { error: string }).error, 'task_finished')

  const bad = await slice1()
  bad.name = '__bad__'
  const rb = await post('/api/v1/tasks', bad)
  assert.equal(rb.status, 400)
  const bj = (await rb.json()) as { error: string; detail: Record<string, string> }
  assert.equal(bj.error, 'diagram_invalid')
  assert.deepEqual(Object.keys(bj.detail).sort(), ['code', 'message', 'node_id', 'port'])

  const lim = (await (await fetch(`${base}/api/v1/tasks?limit=1`)).json()) as { tasks: TaskRecord[] }
  assert.equal(lim.tasks.length, 1)
})

// ---------------------------------------------------------------------------
// 真正的应用服务：接线正确、import 无副作用（不 spawn、不扫盘）、其它路径 POST 仍 405
import { server as appServer } from '../index.js'

let appBase = ''
before(async () => {
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r))
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`
})
after(async () => {
  await new Promise<void>((r) => appServer.close(() => r()))
})

test('index.ts：任务路由已挂，未 init 时列表为空；健康检查带 engine 字段；其它路径 POST 405', async () => {
  const l = await fetch(`${appBase}/api/v1/tasks`)
  assert.equal(l.status, 200)
  assert.deepEqual(await l.json(), { tasks: [] })
  assert.equal((await fetch(`${appBase}/api/v1/tasks/t00000000-000000-0000`)).status, 404)
  assert.equal((await fetch(`${appBase}/api/v1/tasks`, { method: 'PUT' })).status, 405)
  const h = (await (await fetch(`${appBase}/api/v1/health`)).json()) as { engine: { available: boolean } }
  assert.equal(typeof h.engine.available, 'boolean')
  const p = await fetch(`${appBase}/api/v1/health`, { method: 'POST' })
  assert.equal(p.status, 405)
  assert.equal(p.headers.get('allow'), 'GET, HEAD')
  assert.equal((await fetch(`${appBase}/api/v1/scenes`, { method: 'POST' })).status, 405)
})
