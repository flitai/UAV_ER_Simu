// WindowFetcher 状态机：假定时器 + 假客户端，不碰网络。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WindowResult } from '../api/client.js'
import { WindowFetcher, sameKey, type FetchKey } from './fetcher.js'

class FakeTimers {
  private q: Array<{ at: number; fn: () => void; id: number }> = []
  private id = 0
  now = 0
  set = (fn: () => void, ms: number) => { const id = ++this.id; this.q.push({ at: this.now + ms, fn, id }); return id }
  clear = (h: unknown) => { this.q = this.q.filter((t) => t.id !== h) }
  pending() { return this.q.length }
  async advance(ms: number) {
    const until = this.now + ms
    for (;;) {
      const next = this.q.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.q = this.q.filter((t) => t.id !== next.id)
      this.now = next.at
      next.fn()
      await flush()
    }
    this.now = until
  }
}
const flush = () => new Promise<void>((r) => setImmediate(r))

const KEY: FetchKey = { task: 't', op: 's4', t0: 0.4, t1: 1.6, f0: -2e5, f1: 2e5, px: 800, py: 400, stat: 'max', envPx: 400 }
const ok = (rows: number, cols: number): WindowResult => ({ status: 200, data: new Float32Array(rows * cols), meta: { rows, cols, t0: 0.4, t1: 1.6, f0: -2e5, f1: 2e5, stat: 'max', state: 'valid' } })

function make(spec: Array<WindowResult | Error>, env: Array<WindowResult | Error> = [ok(400, 3)]) {
  const timers = new FakeTimers()
  const calls: Array<{ kind: string; signal: AbortSignal; q: unknown }> = []
  const results: Array<{ key: FetchKey; specRows: number; env: boolean }> = []
  const statuses: string[] = []
  const logs: string[] = []
  let si = 0
  let ei = 0
  const f = new WindowFetcher({
    spectrum: (_t, _o, q, signal) => { calls.push({ kind: 'spectrum', signal, q }); const r = spec[Math.min(si++, spec.length - 1)]!; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r) },
    envelope: (_t, _o, q, signal) => { calls.push({ kind: 'envelope', signal, q }); const r = env[Math.min(ei++, env.length - 1)]!; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r) },
    setTimeout: timers.set, clearTimeout: timers.clear,
    onResult: (key, s, e) => results.push({ key, specRows: s.meta.rows, env: e !== null }),
    onStatus: (s) => statuses.push(s),
    onLog: (_l, m) => logs.push(m),
  })
  return { f, timers, calls, results, statuses, logs }
}

test('去抖 150 ms：连续 request 合并成一次，谱与包络并发，结果回调一次', async () => {
  const m = make([ok(400, 800)])
  m.f.request(KEY)
  m.f.request({ ...KEY, t1: 1.7 })
  m.f.request({ ...KEY, t1: 1.8 })
  await m.timers.advance(100)
  assert.equal(m.calls.length, 0)
  await m.timers.advance(60)
  assert.equal(m.calls.length, 2)
  assert.deepEqual(m.calls.map((c) => c.kind), ['spectrum', 'envelope'])
  assert.equal(m.results.length, 1)
  assert.equal(m.results[0]!.key.t1, 1.8)
  assert.ok(m.results[0]!.env)
  assert.equal(m.f.status, 'idle')
  assert.ok(m.statuses.includes('pending') && m.statuses.includes('inflight'))
})

test('同键忽略；换键中止在飞请求，陈旧结果丢弃', async () => {
  const first: { fn: ((r: WindowResult) => void) | null } = { fn: null }
  const m = make([])
  const f = new WindowFetcher({
    spectrum: (_t, _o, _q, signal) => new Promise<WindowResult>((res) => { first.fn = res; signal.addEventListener('abort', () => res(ok(1, 1))) }),
    envelope: () => Promise.resolve(ok(1, 3)),
    setTimeout: m.timers.set, clearTimeout: m.timers.clear,
    onResult: (key, s) => m.results.push({ key, specRows: s.meta.rows, env: true }),
    onStatus: (s) => m.statuses.push(s),
  })
  f.request(KEY)
  await m.timers.advance(150)
  assert.equal(f.status, 'inflight')
  f.request(KEY)                                      // 同键：不打断
  assert.equal(f.status, 'inflight')
  f.request({ ...KEY, px: 900 })                      // 换键：中止第一次
  assert.ok(first.fn)
  first.fn!(ok(400, 800))                             // 迟到的旧结果
  await flush()
  assert.equal(m.results.length, 0)
  await m.timers.advance(150)
  first.fn!(ok(400, 800))                             // 第二次请求的结果
  await flush()
  assert.equal(m.results.length, 1)
  assert.equal(m.results[0]!.key.px, 900)
  assert.ok(sameKey(f.current, { ...KEY, px: 900 }))
})

test('409 按 Retry-After 等待后整体重取；超过 10 次报错', async () => {
  const m = make([{ status: 409, retryAfterMs: 1000 }, ok(4, 6)])
  m.f.request(KEY)
  await m.timers.advance(150)
  assert.equal(m.f.status, 'waiting')
  assert.equal(m.results.length, 0)
  await m.timers.advance(1000)
  assert.equal(m.results.length, 1)
  assert.equal(m.results[0]!.specRows, 4)
  const n = make(Array.from({ length: 12 }, () => ({ status: 409, retryAfterMs: 10 }) as WindowResult))
  n.f.request(KEY)
  await n.timers.advance(150)
  for (let i = 0; i < 12; i++) await n.timers.advance(10)
  assert.equal(n.f.status, 'error')
  assert.equal(n.results.length, 0)
})

test('413 用 suggest 重试一次；400 停并记日志；404 报无产品；包络 404 不算失败', async () => {
  const m = make([{ status: 413, suggest: { px: 400, py: 200 } }, ok(200, 400)])
  m.f.request(KEY)
  await m.timers.advance(150)
  await m.timers.advance(0)
  assert.equal(m.results.length, 1)
  assert.deepEqual([m.results[0]!.key.px, m.results[0]!.key.py], [400, 200])
  const b = make([{ status: 400, message: 't1：t1 不得小于 t0' }])
  b.f.request(KEY)
  await b.timers.advance(150)
  assert.equal(b.f.status, 'error')
  assert.match(b.logs[0]!, /被拒绝/)
  const c = make([{ status: 404 }])
  c.f.request(KEY)
  await c.timers.advance(150)
  assert.equal(c.f.status, 'error')
  const d = make([ok(3, 4)], [{ status: 404 }])
  d.f.request(KEY)
  await d.timers.advance(150)
  assert.equal(d.results.length, 1)
  assert.equal(d.results[0]!.env, false)
  assert.equal(d.f.status, 'idle')
})

test('网络异常 2 s 后重试至多 3 次；cancel 后不再回调', async () => {
  const m = make([new Error('boom'), ok(1, 1)])
  m.f.request(KEY)
  await m.timers.advance(150)
  assert.equal(m.f.status, 'waiting')
  await m.timers.advance(2000)
  assert.equal(m.results.length, 1)
  const n = make([new Error('a'), new Error('b'), new Error('c'), new Error('d')])
  n.f.request(KEY)
  await n.timers.advance(150)
  await n.timers.advance(2000); await n.timers.advance(2000); await n.timers.advance(2000)
  assert.equal(n.f.status, 'error')
  const c = make([ok(1, 1)])
  c.f.request(KEY)
  c.f.cancel()
  await c.timers.advance(200)
  assert.equal(c.results.length, 0)
  assert.equal(c.f.status, 'idle')
})
