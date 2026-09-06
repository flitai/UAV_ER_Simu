// 二进制帧编解码、产品行读取器、events.jsonl 顺序读、重启后合成终态（B-6）。不起服务、不开 WebSocket。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { RowReader, decodeRowFrame, encodeRowFrame, type RowHeader } from './events.js'
import { FILE_EVENTS, TASK_SCHEMA, readEventLines, taskDirAbs, writeTask, type TaskRecord } from '../tasks/store.js'
import { makeRedactor } from '../tasks/resolve.js'
import { createTaskManager } from '../tasks/manager.js'
import { fakeEngine, makeRoot, rmrf } from '../tasks/testkit.js'

const roots: string[] = []
after(async () => {
  for (const r of roots) await rmrf(r)
})

test('二进制帧：u32 长度前缀、帧头补齐到 4 字节、载荷是原字节；非对齐的视图也能解', () => {
  const row = Buffer.alloc(5 * 4)
  for (let k = 0; k < 5; k++) row.writeFloatLE(k * 1.5, k * 4)
  const h: RowHeader = { seq: 7, task_id: 't1', op_id: 's4', kind: 'spectrum', row_index: 3, row_len: 5, t_s: 0.25 }
  const f = encodeRowFrame(h, row)
  const hl = f.readUInt32LE(0)
  assert.equal(hl % 4, 0)
  assert.equal(f.length, 4 + hl + 20)
  assert.deepEqual(JSON.parse(f.subarray(4, 4 + hl).toString('utf8')), h)
  assert.ok(f.subarray(4 + hl).equals(row))
  const d = decodeRowFrame(new Uint8Array(f.buffer, f.byteOffset, f.length))
  assert.deepEqual(d.header, h)
  assert.deepEqual([...d.data], [0, 1.5, 3, 4.5, 6])
  const padded = new Uint8Array(f.length + 1)
  padded.set(f, 1)
  assert.deepEqual([...decodeRowFrame(padded.subarray(1)).data], [...d.data])
  for (const id of ['a', 'ab', 'abc', 'abcd', 'abcde', '北京']) {
    const g = encodeRowFrame({ ...h, task_id: id }, row)
    assert.equal((4 + g.readUInt32LE(0)) % 4, 0)
    assert.equal(decodeRowFrame(g).header.task_id, id)
  }
  assert.throws(() => decodeRowFrame(new Uint8Array(2)))
})

test('RowReader：按偏移读一行；短读、缺文件、非法 op_id / kind / row_len 都返回 null 且每键只警告一次', async () => {
  const root = await makeRoot('cuav-rows-')
  roots.push(root)
  await fsp.mkdir(join(root, 's4'))
  const file = Buffer.alloc(2 * 4 * 4)
  for (let k = 0; k < 8; k++) file.writeFloatLE(100 + k, k * 4)
  await fsp.writeFile(join(root, 's4', 'spectrum.f32'), file)
  const warnings: string[] = []
  const rr = new RowReader(root, (m) => warnings.push(m))
  const r1 = await rr.read('s4', 'spectrum', 1, 4)
  assert.ok(r1 && r1.equals(file.subarray(16, 32)))
  assert.equal(await rr.read('s4', 'spectrum', 2, 4), null)
  assert.equal(await rr.read('s4', 'spectrum', 3, 4), null)
  assert.equal(await rr.read('../s4', 'spectrum', 0, 4), null)
  assert.equal(await rr.read('s4', 'iq', 0, 4), null)
  assert.equal(await rr.read('s4', 'envelope', 0, 3), null)
  assert.equal(await rr.read('s4', 'spectrum', 0, 0), null)
  assert.equal(await rr.read('s4', 'spectrum', -1, 4), null)
  assert.equal(warnings.length, 4, warnings.join('\n')) // s4/spectrum、../s4/spectrum、s4/iq、s4/envelope 各一次
  const r0 = await rr.read('s4', 'spectrum', 0, 4)
  assert.ok(r0 && r0.equals(file.subarray(0, 16)))
  await rr.close()
})

test('readEventLines：CRLF、脱敏、since / limit、末尾半行忽略、文件不存在为空', async () => {
  const root = await makeRoot('cuav-lines-')
  roots.push(root)
  const redact = makeRedactor(root, { fx_1: 'data/iq/measured/fx/fx_1.manifest.json' })
  const ev = (seq: number, type: string, payload: unknown) => JSON.stringify({ seq, task_id: 'ta', type, t_s: 0, payload })
  const text =
    ev(1, 'task.state', { run_state: 'running' }) + '\n' +
    ev(2, 'log', { message: `打开 ${root}/data/iq/measured/fx/fx_1.manifest.json 与 ${root}/x` }) + '\r\n' +
    '\n' +
    ev(3, 'product_row', { op_id: 's4', kind: 'spectrum', row_index: 0, row_len: 8 }) + '\n' +
    '{"seq":4,"task_id":"ta","type":"log","t_s":0,"pay'
  const path = join(root, FILE_EVENTS)
  await fsp.writeFile(path, text)
  const all = await readEventLines(path, 0, 100, redact)
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3])
  const msg = String(all[1].payload.message)
  assert.ok(!msg.includes(root), msg)
  assert.equal(msg, '打开 fx_1 与 x')
  assert.deepEqual((await readEventLines(path, 1, 1, redact)).map((e) => e.seq), [2])
  assert.deepEqual((await readEventLines(path, 3, 10, redact)).map((e) => e.seq), [])
  assert.deepEqual(await readEventLines(join(root, 'nope.jsonl'), 0, 10, redact), [])
})

test('readEvents：重启后缓冲为空，文件里没有终态 → 对账标 failed 并合成 seq = last_seq 的服务端终态；未知任务 null', async () => {
  const root = await makeRoot('cuav-restart-')
  roots.push(root)
  const cfg = { root, runsRel: 'data/runs' }
  const rec: TaskRecord = {
    schema_version: TASK_SCHEMA, task_id: 'ta', diagram_id: 'd', name: 'n', diagram_sha256: '0'.repeat(64),
    seed: 1, seed_source: null, run_state: 'running', result: 'not_applicable', reasons: [], created_utc: '2026-09-05T00:00:00Z',
    cancel_requested: false, observation_points: [], data_refs: [], warnings: [], last_seq: 0,
    files: { diagram: 'diagram.json', events: FILE_EVENTS },
  }
  await fsp.mkdir(taskDirAbs(cfg, 'ta'), { recursive: true })
  await writeTask(cfg, rec)
  const ev = (seq: number, type: string, payload: unknown) => JSON.stringify({ seq, task_id: 'ta', type, t_s: 0, payload })
  await fsp.writeFile(join(taskDirAbs(cfg, 'ta'), FILE_EVENTS), [
    ev(1, 'task.state', { run_state: 'running' }),
    ev(2, 'product_row', { op_id: 's4', kind: 'spectrum', row_index: 0, row_len: 8 }),
    ev(3, 'log', { level: 'info', message: 'x' }),
  ].join('\n') + '\n')
  const mgr = createTaskManager({ root, engine: fakeEngine(root) })
  await mgr.init()
  const r = mgr.get('ta')!
  assert.equal(r.run_state, 'failed')
  assert.equal(r.last_seq, 4)
  const all = (await mgr.readEvents('ta', 0, 10))!
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4])
  assert.equal(all[3].type, 'task.state')
  assert.equal(all[3].payload.source, 'server')
  assert.equal(all[3].payload.run_state, 'failed')
  assert.deepEqual((await mgr.readEvents('ta', 2, 10))!.map((e) => e.seq), [3, 4])
  assert.deepEqual(await mgr.readEvents('ta', 4, 10), [])
  assert.deepEqual((await mgr.readEvents('ta', 0, 2))!.map((e) => e.seq), [1, 2])
  assert.equal(await mgr.readEvents('nope', 0, 10), null)
  mgr.shutdownSync()
})
