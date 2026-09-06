// WebSocket 服务端（B-6）：订阅应答、回放与实时的序号连续、二进制行帧载荷、断线按 since 重连、缓冲溢出走文件、
// 服务端终态、dropped 的连续性、行读不到退回文本、协议错误与关闭码、心跳与漏 pong、非 /ws 路径、hub.close()。
// 客户端用 Node 内置 WebSocket（浏览器同款 API）；漏 pong 那项用 ws 包的客户端（autoPong: false）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket as WsClient } from 'ws'
import { handleTaskRoutes } from '../tasks/routes.js'
import { createTaskManager, type TaskManager } from '../tasks/manager.js'
import type { EngineEvent } from '../tasks/engine.js'
import type { TaskRecord } from '../tasks/store.js'
import { fakeEngine, makeRoot, rmrf, slice1, waitFor } from '../tasks/testkit.js'
import { CLOSE_ALREADY_SUBSCRIBED, CLOSE_BAD_SUBSCRIBE, CLOSE_GOING_AWAY, CLOSE_NOT_FOUND, WsHub } from './hub.js'
import { decodeRowFrame, type RowHeader } from './events.js'

interface Rig {
  root: string
  mgr: TaskManager
  hub: WsHub
  srv: Server
  base: string
  wsUrl: string
}

async function makeRig(opts: { depth?: number; heartbeatMs?: number; overloaded?: () => boolean } = {}): Promise<Rig> {
  const root = await makeRoot('cuav-ws-')
  const engine = fakeEngine(root)
  const mgr = createTaskManager({ root, engine, eventBufferDepth: opts.depth, killGraceMs: 500 })
  await mgr.init()
  const hub = new WsHub({ mgr, heartbeatMs: opts.heartbeatMs, overloaded: opts.overloaded, log: () => undefined })
  const srv = createServer((req, res) => {
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
  hub.attach(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  return { root, mgr, hub, srv, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` }
}

async function closeRig(r: Rig): Promise<void> {
  await r.hub.close()
  await new Promise<void>((x) => r.srv.close(() => x()))
  r.mgr.shutdownSync()
  await rmrf(r.root)
}

type Msg = { kind: 'text'; ev: EngineEvent } | { kind: 'bin'; header: RowHeader; data: Float32Array }
const isTerminal = (e: EngineEvent) => e.type === 'task.state' && ['finished', 'failed', 'cancelled'].includes(String(e.payload.run_state))
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

class Client {
  readonly ws: WebSocket
  readonly msgs: Msg[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('message', (e: MessageEvent) => {
      if (typeof e.data === 'string') this.msgs.push({ kind: 'text', ev: JSON.parse(e.data) as EngineEvent })
      else {
        const d = decodeRowFrame(e.data as ArrayBuffer)
        this.msgs.push({ kind: 'bin', header: d.header, data: d.data })
      }
    })
    this.closed = new Promise((r) => this.ws.addEventListener('close', (e: CloseEvent) => r({ code: e.code, reason: e.reason })))
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('ws error')))
    })
  }
  subscribe(task: string, since = 0): void {
    this.ws.send(JSON.stringify({ subscribe: task, since }))
  }
  until(pred: (m: Msg[]) => boolean, label: string, timeoutMs = 10000): Promise<boolean> {
    return waitFor(() => (pred(this.msgs) ? true : undefined), label, timeoutMs, 10)
  }
  untilTerminal(): Promise<boolean> {
    return this.until((m) => m.some((x) => x.kind === 'text' && isTerminal(x.ev)), '终态')
  }
  /** 任务序号流：文本与二进制合并，去掉 seq = 0 的连接级报文 */
  seqs(): number[] {
    return this.msgs.map((m) => (m.kind === 'text' ? m.ev.seq : m.header.seq)).filter((s) => s > 0)
  }
  texts(type?: string): EngineEvent[] {
    return this.msgs.filter((m): m is Extract<Msg, { kind: 'text' }> => m.kind === 'text').map((m) => m.ev).filter((e) => !type || e.type === type)
  }
  bins(): Array<Extract<Msg, { kind: 'bin' }>> {
    return this.msgs.filter((m): m is Extract<Msg, { kind: 'bin' }> => m.kind === 'bin')
  }
  async close(): Promise<void> {
    this.ws.close()
    await this.closed
  }
}

const isDone = (r: TaskRecord | null) => !!r && r.run_state !== 'queued' && r.run_state !== 'running' && r.exit_code !== undefined
const done = (m: TaskManager, id: string) => waitFor(() => (isDone(m.get(id)) ? m.get(id)! : undefined), `任务 ${id} 结束`)

let flag = false
let rig: Rig
const rigs: Rig[] = []
after(async () => {
  for (const r of rigs) await closeRig(r)
})

test('slow 从 since=0：subscribed 先到，序号 1..16 连续，行帧为二进制且载荷对得上，终态 finished 收尾', async () => {
  rig = await makeRig({ overloaded: () => flag })
  rigs.push(rig)
  const r = await rig.mgr.submit({ body: await slice1('slow') })
  const id = r.task.task_id
  const c = new Client(rig.wsUrl)
  await c.open()
  c.subscribe(id, 0)
  await c.untilTerminal()
  const first = c.msgs[0]
  assert.equal(first.kind, 'text')
  assert.equal(first.kind === 'text' && first.ev.type, 'subscribed')
  assert.equal(first.kind === 'text' && first.ev.seq, 0)
  assert.equal(first.kind === 'text' && first.ev.payload.since, 0)
  assert.deepEqual(c.seqs(), range(1, 16))
  const bins = c.bins()
  assert.equal(bins.length, 12)
  bins.forEach((b, i) => {
    assert.equal(b.header.task_id, id)
    assert.equal(b.header.op_id, 's4')
    assert.equal(b.header.kind, 'spectrum')
    assert.equal(b.header.row_index, i)
    assert.equal(b.header.row_len, 1024)
    assert.equal(b.header.seq, 4 + i)
    assert.ok(Math.abs(b.header.t_s - i * 0.05) < 1e-9)
    assert.equal(b.data.length, 1024)
    assert.equal(b.data[0], i * 1000)
    assert.equal(b.data[1023], i * 1000 + 1023)
  })
  const last = c.msgs[c.msgs.length - 1]
  assert.ok(last.kind === 'text' && last.ev.type === 'task.state' && last.ev.payload.run_state === 'finished')
  assert.equal(c.texts('product_row').length, 0)
  assert.equal(c.texts('dropped').length, 0)
  await c.close()
  await waitFor(() => (rig.hub.size === 0 ? true : undefined), '会话释放')
})

test('断线重连：以 since = 已收到的最大序号重连，首条任务事件正好是 since + 1，无缺号无重复', async () => {
  const r = await rig.mgr.submit({ body: await slice1('slow') })
  const id = r.task.task_id
  const a = new Client(rig.wsUrl)
  await a.open()
  a.subscribe(id, 0)
  await a.until((m) => m.filter((x) => x.kind === 'bin').length >= 3, '至少三帧')
  const k = Math.max(...a.seqs())
  await a.close()
  const b = new Client(rig.wsUrl)
  await b.open()
  b.subscribe(id, k)
  await b.untilTerminal()
  assert.equal((b.msgs[0] as Extract<Msg, { kind: 'text' }>).ev.payload.since, k)
  assert.deepEqual(b.seqs(), range(k + 1, 16))
  const union = new Set([...a.seqs(), ...b.seqs()])
  assert.deepEqual([...union].sort((x, y) => x - y), range(1, 16))
  await b.close()
})

test('缓冲溢出（深度 16）：回放走 events.jsonl 再接缓冲，1..44 连续、40 帧二进制；HTTP 补取同源且 product_row 为文本', async () => {
  const small = await makeRig({ depth: 16 })
  rigs.push(small)
  const r = await small.mgr.submit({ body: await slice1('many') })
  const rec = await done(small.mgr, r.task.task_id)
  assert.equal(rec.last_seq, 44)
  assert.ok(small.mgr.bufferRange(rec.task_id)!.first > 1)
  const c = new Client(small.wsUrl)
  await c.open()
  c.subscribe(rec.task_id, 0)
  await c.untilTerminal()
  assert.deepEqual(c.seqs(), range(1, 44))
  assert.equal(c.bins().length, 40)
  assert.equal(c.bins()[39].data[5], 39 * 1000 + 5)
  await c.close()
  const j = (await (await fetch(`${small.base}/api/v1/tasks/${rec.task_id}/events?since=0&limit=5000`)).json()) as { events: EngineEvent[]; last_seq: number }
  assert.deepEqual(j.events.map((e) => e.seq), range(1, 44))
  assert.equal(j.events[3].type, 'product_row')
  assert.deepEqual(Object.keys(j.events[3].payload).sort(), ['kind', 'op_id', 'row_index', 'row_len'])
  const tail = (await (await fetch(`${small.base}/api/v1/tasks/${rec.task_id}/events?since=30`)).json()) as { events: EngineEvent[] }
  assert.deepEqual(tail.events.map((e) => e.seq), range(31, 44))
})

test('引擎被 SIGKILL：末条是服务端补发的 task.state（source = server），seq = last_seq，序号连续', async () => {
  const r = await rig.mgr.submit({ body: await slice1('crash') })
  const rec = await done(rig.mgr, r.task.task_id)
  const c = new Client(rig.wsUrl)
  await c.open()
  c.subscribe(rec.task_id, 0)
  await c.untilTerminal()
  assert.deepEqual(c.seqs(), range(1, rec.last_seq))
  const last = c.msgs[c.msgs.length - 1]
  assert.ok(last.kind === 'text')
  assert.equal(last.ev.payload.source, 'server')
  assert.equal(last.ev.payload.run_state, 'failed')
  assert.equal(last.ev.seq, rec.last_seq)
  assert.equal(c.bins().length, 2)
  await c.close()
})

test('背压：只丢二进制行帧，dropped{from,to,count} 连续且紧接在下一条文本帧之前；文本事件一条不少', async () => {
  const r = await rig.mgr.submit({ body: await slice1('many') })
  const rec = await done(rig.mgr, r.task.task_id)
  flag = true
  try {
    const c = new Client(rig.wsUrl)
    await c.open()
    c.subscribe(rec.task_id, 0)
    await c.untilTerminal()
    assert.equal(c.bins().length, 0)
    const dropped = c.texts('dropped')
    assert.equal(dropped.length, 1)
    assert.deepEqual(dropped[0].payload, { from: 4, to: 43, count: 40 })
    assert.equal(dropped[0].seq, 0)
    const types = c.texts().map((e) => `${e.type}:${e.seq}`)
    assert.deepEqual(types, ['subscribed:0', 'task.state:1', 'log:2', 'progress:3', 'dropped:0', 'task.state:44'])
    await c.close()
  } finally {
    flag = false
  }
  const j = (await (await fetch(`${rig.base}/api/v1/tasks/${rec.task_id}/events?since=43`)).json()) as { events: EngineEvent[] }
  assert.deepEqual(j.events.map((e) => e.seq), [44])
})

test('行读不到（norows）：退回发原文本 product_row，序号不断', async () => {
  const r = await rig.mgr.submit({ body: await slice1('norows') })
  const rec = await done(rig.mgr, r.task.task_id)
  const c = new Client(rig.wsUrl)
  await c.open()
  c.subscribe(rec.task_id, 0)
  await c.untilTerminal()
  assert.deepEqual(c.seqs(), range(1, 9))
  assert.equal(c.bins().length, 0)
  const rows = c.texts('product_row')
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map((e) => e.seq), [4, 5, 6, 7, 8])
  assert.equal(rows[4].payload.kind, 'envelope')
  await c.close()
})

test('协议错误：坏 JSON 4400、未知任务 4404、重复订阅 4409、二进制报文 4400，都先发 error（seq 0）再关', async () => {
  const bad = new Client(rig.wsUrl)
  await bad.open()
  bad.ws.send('nope')
  const cb = await bad.closed
  assert.equal(cb.code, CLOSE_BAD_SUBSCRIBE)
  assert.equal(bad.texts('error')[0].payload.code, 'bad_subscribe')
  assert.equal(bad.texts('error')[0].seq, 0)

  const shape = new Client(rig.wsUrl)
  await shape.open()
  shape.ws.send(JSON.stringify({ subscribe: 'x', since: -1 }))
  assert.equal((await shape.closed).code, CLOSE_BAD_SUBSCRIBE)

  const nf = new Client(rig.wsUrl)
  await nf.open()
  nf.subscribe('t00000000-000000-0000', 0)
  const cn = await nf.closed
  assert.equal(cn.code, CLOSE_NOT_FOUND)
  assert.equal(nf.texts('error')[0].payload.code, 'not_found')
  assert.equal(nf.texts('error')[0].task_id, 't00000000-000000-0000')

  const r = await rig.mgr.submit({ body: await slice1() })
  const rec = await done(rig.mgr, r.task.task_id)
  const twice = new Client(rig.wsUrl)
  await twice.open()
  twice.subscribe(rec.task_id, rec.last_seq)
  await twice.until((m) => m.some((x) => x.kind === 'text' && x.ev.type === 'subscribed'), '订阅应答')
  twice.subscribe(rec.task_id, 0)
  assert.equal((await twice.closed).code, CLOSE_ALREADY_SUBSCRIBED)
  assert.equal(twice.texts('error')[0].payload.code, 'already_subscribed')

  const bin = new Client(rig.wsUrl)
  await bin.open()
  bin.ws.send(new Uint8Array([1, 2, 3]))
  assert.equal((await bin.closed).code, CLOSE_BAD_SUBSCRIBE)
})

test('心跳：按间隔收到 heartbeat{last_seq}（seq 0）；不回 pong 的连接两轮后被断开', async () => {
  const hb = await makeRig({ heartbeatMs: 60 })
  rigs.push(hb)
  const r = await hb.mgr.submit({ body: await slice1() })
  const rec = await done(hb.mgr, r.task.task_id)
  const c = new Client(hb.wsUrl)
  await c.open()
  c.subscribe(rec.task_id, rec.last_seq)
  await c.until((m) => m.filter((x) => x.kind === 'text' && x.ev.type === 'heartbeat').length >= 2, '两次心跳', 5000)
  const h = c.texts('heartbeat')[0]
  assert.equal(h.seq, 0)
  assert.equal(h.task_id, rec.task_id)
  assert.equal(h.payload.last_seq, rec.last_seq)
  assert.equal(c.seqs().length, 0, 'since = last_seq 时不回放任何任务事件')
  await c.close()

  const mute = new WsClient(hb.wsUrl, { autoPong: false })
  await new Promise<void>((x) => mute.once('open', () => x()))
  const t0 = Date.now()
  const code = await new Promise<number>((x) => mute.once('close', (cd) => x(cd)))
  assert.equal(code, 1006)
  assert.ok(Date.now() - t0 < 2000)
})

test('非 /ws 路径的 upgrade 被拒（1006）；普通 HTTP GET /ws 走路由 404；hub.close() 让客户端收 1001', async () => {
  const other = new Client(rig.wsUrl.replace('/ws', '/other'))
  await assert.rejects(other.open())
  assert.equal((await other.closed).code, 1006)
  assert.equal((await fetch(`${rig.base}/ws`)).status, 404)

  const c = new Client(rig.wsUrl)
  await c.open()
  const r = await rig.mgr.submit({ body: await slice1() })
  c.subscribe(r.task.task_id, 0)
  await c.untilTerminal()
  assert.equal(rig.hub.size, 1)
  await rig.hub.close()
  assert.equal((await c.closed).code, CLOSE_GOING_AWAY)
  assert.equal(rig.hub.size, 0)
})
