// WsClient 状态机单测：假 WebSocket + 假定时器，不需要浏览器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WsClient, type WsLike } from './ws.js'
import type { WsTextEvent } from '../state/types.js'

class FakeWs implements WsLike {
  static instances: FakeWs[] = []
  binaryType = 'blob'
  readyState = 0
  sent: string[] = []
  closedWith: number | null = null
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(public url: string) { FakeWs.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close(code = 1000) { this.closedWith = code; this.readyState = 3; this.onclose?.({ code }) }
  open() { this.readyState = 1; this.onopen?.({}) }
  text(ev: WsTextEvent) { this.onmessage?.({ data: JSON.stringify(ev) }) }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }) }
}

class FakeTimers {
  private q: Array<{ at: number; fn: () => void; id: number }> = []
  private id = 0
  now = 0
  set = (fn: () => void, ms: number) => { const id = ++this.id; this.q.push({ at: this.now + ms, fn, id }); return id }
  clear = (h: unknown) => { this.q = this.q.filter((t) => t.id !== h) }
  advance(ms: number) {
    const until = this.now + ms
    for (;;) {
      const next = this.q.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.q = this.q.filter((t) => t.id !== next.id)
      this.now = next.at
      next.fn()
    }
    this.now = until
  }
}

const ev = (seq: number, type = 'log', payload: Record<string, unknown> = { level: 'info', message: 'm' }): WsTextEvent => ({ seq, task_id: 't', type, t_s: 0, payload })

function make(fetchEvents?: (id: string, since: number) => Promise<{ events: WsTextEvent[]; last_seq: number }>) {
  FakeWs.instances = []
  const timers = new FakeTimers()
  const got: WsTextEvent[] = []
  const rows: number[] = []
  const logs: string[] = []
  const statuses: string[] = []
  const c = new WsClient({
    url: 'ws://x/ws',
    fetchEvents: fetchEvents ?? (async () => ({ events: [], last_seq: 0 })),
    onEvent: (e) => got.push(e), onRow: (h) => rows.push(h.seq),
    onStatus: (s) => statuses.push(s.status), onClientLog: (_l, m) => logs.push(m),
    WebSocketImpl: FakeWs, setTimeout: timers.set, clearTimeout: timers.clear,
  })
  return { c, timers, got, rows, logs, statuses, ws: () => FakeWs.instances.at(-1)! }
}

test('打开即发订阅报文，带 since；同任务二次订阅不建新连接', () => {
  const m = make()
  m.c.subscribe('t', 5)
  m.ws().open()
  assert.deepEqual(JSON.parse(m.ws().sent[0]!), { subscribe: 't', since: 5 })
  assert.equal(m.c.state.status, 'connected')
  m.c.subscribe('t', 5)
  assert.equal(FakeWs.instances.length, 1)
})

test('连续事件按序交出；缺号先补取再交出扣住的帧，不记缺号', async () => {
  const fetched: number[] = []
  const m = make(async (_id, since) => {
    fetched.push(since)
    return { events: [ev(7), ev(8)], last_seq: 8 }
  })
  m.c.subscribe('t', 5)
  m.ws().open()
  m.ws().text(ev(6))
  m.ws().text(ev(9))            // 缺 7、8
  m.ws().text(ev(10))           // 补取期间到达，须扣住
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(fetched, [6])
  assert.deepEqual(m.got.map((e) => e.seq), [6, 7, 8, 9, 10])
  assert.equal(m.logs.filter((l) => /缺号/.test(l)).length, 0)
  assert.equal(m.c.state.lastSeq, 10)
})

test('补取本身有洞才记一条缺号', async () => {
  const m = make(async () => ({ events: [ev(8)], last_seq: 8 }))
  m.c.subscribe('t', 5)
  m.ws().open()
  m.ws().text(ev(6))
  m.ws().text(ev(9))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(m.got.map((e) => e.seq), [6, 8, 9])
  assert.equal(m.logs.filter((l) => /缺号：seq 7→7/.test(l)).length, 1)
})

test('非主动关闭按 1/2/4/8/8 s 退避重连，重连报文带最新 since；4404 不重试', () => {
  const m = make()
  m.c.subscribe('t', 0)
  m.ws().open()
  m.ws().text(ev(1)); m.ws().text(ev(2))
  const delays: number[] = []
  for (let i = 0; i < 5; i++) {
    m.ws().serverClose(1006)
    assert.equal(m.c.state.status, 'reconnecting')
    delays.push(m.c.state.nextRetryMs)
    m.timers.advance(m.c.state.nextRetryMs)
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000])
  m.ws().open()
  assert.deepEqual(JSON.parse(m.ws().sent[0]!), { subscribe: 't', since: 2 })
  assert.equal(m.c.state.reconnects, 5)
  m.ws().serverClose(4404)
  assert.equal(m.c.state.status, 'closed')
  m.timers.advance(20000)
  assert.equal(FakeWs.instances.length, 6)   // 首连 1 + 重连 5；4404 之后不再建
})

test('连接级报文：seq 0 不推进；dropped 推进到 to 并计数；心跳看门狗到期重连；dropForTest 走重连', () => {
  const m = make()
  m.c.subscribe('t', 0)
  m.ws().open()
  m.ws().text({ seq: 0, task_id: 't', type: 'heartbeat', t_s: 0, payload: { last_seq: 50 } })
  assert.equal(m.c.state.lastSeq, 0)
  m.ws().text(ev(1))
  m.ws().text({ seq: 0, task_id: 't', type: 'dropped', t_s: 0, payload: { from: 2, to: 4, count: 3 } })
  assert.equal(m.c.state.lastSeq, 4); assert.equal(m.c.state.dropped, 3)
  m.ws().text(ev(5))
  assert.deepEqual(m.got.map((e) => e.seq), [1, 5])
  const n = FakeWs.instances.length
  m.timers.advance(36000)
  assert.equal(m.c.state.status, 'reconnecting')
  m.timers.advance(1000)
  assert.equal(FakeWs.instances.length, n + 1)
  m.ws().open()
  assert.equal(m.c.dropForTest(), true)
  assert.equal(m.c.state.status, 'reconnecting')
  m.c.close()
  assert.equal(m.c.state.status, 'closed')
  assert.equal(m.c.dropForTest(), false)
})

test('二进制行帧走 onRow，序号也参与校验', () => {
  const m = make()
  m.c.subscribe('t', 0)
  m.ws().open()
  const json = new TextEncoder().encode(JSON.stringify({ seq: 1, task_id: 't', op_id: 's4', kind: 'spectrum', row_index: 0, row_len: 2, t_s: 0 }))
  const pad = (4 - (json.length % 4)) % 4
  const buf = new ArrayBuffer(4 + json.length + pad + 8)
  new DataView(buf).setUint32(0, json.length + pad, true)
  new Uint8Array(buf, 4, json.length).set(json)
  new Float32Array(buf, 4 + json.length + pad, 2).set([1, 2])
  m.ws().onmessage?.({ data: buf })
  assert.deepEqual(m.rows, [1]); assert.equal(m.c.state.lastSeq, 1)
})
