// 任务管理器：提交→运行→完成状态机、取消、退出码、脱敏、幂等、串行队列、重启对账、服务退出收尾（B-5）。
// 全部用假引擎（fake_engine.mjs）与临时目录，不依赖 C++ 构建。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { HttpError, createTaskManager, type TaskManager } from './manager.js'
import { FILE_EVENTS, FILE_RESOLVED, TASK_SCHEMA, readTask, sha256Hex, taskDirAbs, writeTask, type TaskRecord } from './store.js'
import { FX_IDS, fakeEngine, makeDataFixture, makeRoot, replayDiagram, rmrf, slice1, waitFor } from './testkit.js'

let root = ''
let mgr: TaskManager
const extraRoots: string[] = []

before(async () => {
  root = await makeRoot()
  await makeDataFixture(root)
  mgr = createTaskManager({ root, engine: fakeEngine(root), killGraceMs: 500 })
  await mgr.init()
})
after(async () => {
  mgr.shutdownSync()
  await rmrf(root)
  for (const r of extraRoots) await rmrf(r)
})

// 终态由引擎的最后一条 task.state 决定，比进程关闭早几毫秒；exit_code 在进程关闭后才有。测试等两者都齐。
const isDone = (r: TaskRecord | null) => !!r && r.run_state !== 'queued' && r.run_state !== 'running' && r.exit_code !== undefined
async function done(m: TaskManager, id: string, timeoutMs = 10000): Promise<TaskRecord> {
  return waitFor(() => (isDone(m.get(id)) ? m.get(id)! : undefined), `任务 ${id} 结束`, timeoutMs)
}
async function submitError(body: unknown, key?: string): Promise<HttpError> {
  try {
    await mgr.submit({ body, idempotencyKey: key })
  } catch (e) {
    if (e instanceof HttpError) return e
    throw e
  }
  assert.fail('应当被拒绝')
}
async function runDirs(r = root): Promise<string[]> {
  return (await fsp.readdir(join(r, 'data', 'runs'))).sort()
}

test('提交→运行→完成：状态机、行计数、task.json 落盘、日志路径脱敏', async () => {
  const r = await mgr.submit({ body: await slice1() })
  assert.equal(r.status, 201)
  assert.ok(r.task.run_state === 'queued' || r.task.run_state === 'running')
  assert.equal(r.task.result, 'not_applicable')
  assert.match(r.task.task_id, /^t\d{8}-\d{6}-[0-9a-f]{4}$/)
  const rec = await done(mgr, r.task.task_id)
  assert.equal(rec.run_state, 'finished')
  assert.equal(rec.result, 'valid')
  assert.equal(rec.exit_code, 0)
  assert.equal(rec.seed, 20260904)
  assert.equal(rec.seed_source, 'diagram')
  assert.equal(rec.engine_version, 'fake-0.0.1')
  assert.deepEqual(rec.observation_points[0].rows_seen, { spectrum: 3, envelope: 2 })
  assert.equal(rec.last_seq, 9)
  assert.equal(rec.rounds, 3)
  assert.ok(rec.started_utc && rec.ended_utc)
  await mgr.flush()
  const onDisk = await readTask(mgr.storeConfig, rec.task_id)
  assert.deepEqual(onDisk, rec)
  const files = (await fsp.readdir(taskDirAbs(mgr.storeConfig, rec.task_id))).sort()
  assert.deepEqual(files, ['diagram.json', 'events.jsonl', 's4', 'task.json']) // s4/ 是假引擎写的产品目录（B-6 起与真引擎同形）
  const evs = mgr.events(rec.task_id)!
  assert.equal(evs.length, 9)
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  const log = evs.find((e) => e.type === 'log')!
  const msg = String(log.payload.message)
  assert.ok(!msg.includes(root), `日志漏出仓库根：${msg}`)
  assert.ok(msg.includes(`data/runs/${rec.task_id}/diagram.json`), msg)
  assert.deepEqual(mgr.bufferRange(rec.task_id), { first: 1, last: 9 })
})

test('回放框图：旁挂里是相对路径，事件与 reasons 里的清单路径换回 data_id，验收集片段带提示', async () => {
  const r = await mgr.submit({ body: replayDiagram(FX_IDS.holdout) })
  assert.equal(r.task.files.resolved, FILE_RESOLVED)
  assert.deepEqual(r.task.data_refs, [{ node_id: 'replay', data_id: FX_IDS.holdout, holdout: true }])
  assert.equal(r.task.warnings.length, 1)
  assert.match(r.task.warnings[0], /验收集片段 fx_hold_1/)
  const side = JSON.parse(await fsp.readFile(join(taskDirAbs(mgr.storeConfig, r.task.task_id), FILE_RESOLVED), 'utf8'))
  assert.deepEqual(side, {
    schema_version: 'cuav-resolved/1',
    diagram_sha256: r.task.diagram_sha256,
    data: { [FX_IDS.holdout]: `data/iq/measured/fx/${FX_IDS.holdout}.manifest.json` },
  })
  const rec = await done(mgr, r.task.task_id)
  assert.equal(rec.run_state, 'finished')
  const log = mgr.events(rec.task_id)!.find((e) => e.type === 'log')!
  assert.match(String(log.payload.message), /打开清单 fx_hold_1/)
  assert.ok(!String(log.payload.message).includes('manifest.json'))
  assert.ok(rec.reasons[0].includes('fx_hold_1') && !rec.reasons[0].includes('data/iq'), rec.reasons[0])
})

test('data_id 解析不到 → 400 data_id 且定位到节点，不留任务目录', async () => {
  const before_ = await runDirs()
  const e1 = await submitError(replayDiagram('nope'))
  assert.equal(e1.status, 400)
  assert.equal(e1.body.error, 'diagram_invalid')
  const d1 = e1.body.detail as Record<string, string>
  assert.equal(d1.code, 'data_id')
  assert.equal(d1.node_id, 'replay')
  const e2 = await submitError(replayDiagram(FX_IDS.noFile))
  assert.equal((e2.body.detail as Record<string, string>).code, 'data_id')
  assert.match((e2.body.detail as Record<string, string>).message, /不在盘上/)
  assert.deepEqual(await runDirs(), before_)
})

test('内部参数出现即 400 internal_param（节点与观测点，D-037）', async () => {
  const d = await slice1()
  ;(d.nodes as Array<Record<string, unknown>>)[0] = {
    id: 'replay', type: 'FileReplaySource', params: { data_id: FX_IDS.ok, manifest_path: '/srv/x.manifest.json' },
  }
  const e1 = await submitError(d)
  assert.equal(e1.status, 400)
  assert.deepEqual([(e1.body.detail as Record<string, string>).code, (e1.body.detail as Record<string, string>).node_id], ['internal_param', 'replay'])
  const d2 = await slice1()
  ;(d2.observation_points as Array<Record<string, unknown>>)[0].params = { out_dir: 'x' }
  const e2 = await submitError(d2)
  assert.deepEqual([(e2.body.detail as Record<string, string>).code, (e2.body.detail as Record<string, string>).node_id], ['internal_param', 's4'])
})

test('结构错误 → 400 schema；其余语义错误由引擎 --validate 给出并原样透传，目录已删', async () => {
  for (const bad of ['x', { schema_version: 'nope' }, { schema_version: 'cuav-diagram/1', diagram_id: 'a', name: 'n', run: {} }]) {
    const e = await submitError(bad)
    assert.equal(e.status, 400)
    assert.equal((e.body.detail as Record<string, string>).code, 'schema')
  }
  const before_ = await runDirs()
  const d = await slice1()
  d.name = '__bad__'
  const e = await submitError(d)
  assert.equal(e.status, 400)
  assert.deepEqual(e.body.detail, { code: 'param', node_id: 'tone', port: '', message: '参数 amplitude 越界（假引擎）' })
  assert.deepEqual(await runDirs(), before_)
})

test('幂等：同键同框图 200 返回同一任务；同键不同框图 409', async () => {
  const body = await slice1()
  const a = await mgr.submit({ body, idempotencyKey: 'k-1' })
  const b = await mgr.submit({ body, idempotencyKey: 'k-1' })
  assert.equal(a.status, 201)
  assert.equal(b.status, 200)
  assert.equal(b.task.task_id, a.task.task_id)
  assert.equal(a.task.idempotency_key, 'k-1')
  const other = await slice1()
  other.diagram_id = 'other'
  const e = await submitError(other, 'k-1')
  assert.equal(e.status, 409)
  assert.equal(e.body.error, 'idempotency_conflict')
  assert.equal(e.body.task_id, a.task.task_id)
  await done(mgr, a.task.task_id)
})

test('串行队列：并发上限 1 时第二个任务保持 queued，直到第一个结束', async () => {
  const a = await mgr.submit({ body: await slice1('slow') })
  const b = await mgr.submit({ body: await slice1() })
  assert.equal(mgr.get(a.task.task_id)!.run_state, 'running')
  assert.equal(mgr.get(b.task.task_id)!.run_state, 'queued')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(mgr.get(b.task.task_id)!.run_state, 'queued', '第一个还在跑时第二个不得开始')
  const rb = await done(mgr, b.task.task_id)
  const ra = mgr.get(a.task.task_id)!
  assert.equal(ra.run_state, 'finished')
  assert.equal(rb.run_state, 'finished')
  assert.ok(rb.started_utc! >= ra.ended_utc!, `${rb.started_utc} < ${ra.ended_utc}`)
  assert.equal(ra.observation_points[0].rows_seen.spectrum, 12)
})

test('取消：排队中立即 cancelled；运行中杀进程后 cancelled / not_applicable；已结束 409；服务端补发终态事件', async () => {
  const h = await mgr.submit({ body: await slice1('hang') })
  const q = await mgr.submit({ body: await slice1() })
  assert.equal(mgr.get(q.task.task_id)!.run_state, 'queued')
  const cq = await mgr.cancel(q.task.task_id)
  assert.equal(cq.run_state, 'cancelled')
  assert.equal(cq.result, 'not_applicable')
  assert.deepEqual(cq.reasons, ['排队中取消'])
  const qev = mgr.events(q.task.task_id)!
  assert.equal(qev.length, 1)
  assert.equal(qev[0].type, 'task.state')
  assert.equal(qev[0].payload.source, 'server')
  assert.equal(qev[0].payload.run_state, 'cancelled')

  await waitFor(() => (mgr.get(h.task.task_id)!.last_seq >= 2 ? true : undefined), 'hang 任务产出事件')
  const ch = await mgr.cancel(h.task.task_id)
  assert.equal(ch.run_state, 'running')
  assert.equal(ch.cancel_requested, true)
  const rec = await done(mgr, h.task.task_id)
  assert.equal(rec.run_state, 'cancelled')
  assert.equal(rec.result, 'not_applicable')
  assert.deepEqual(rec.reasons, ['用户取消'])
  assert.equal(rec.signal, 'SIGTERM')
  assert.ok((rec.observation_points[0]?.rows_seen.spectrum ?? 0) >= 0)
  const evs = mgr.events(rec.task_id)!
  const last = evs[evs.length - 1]
  assert.equal(last.type, 'task.state')
  assert.equal(last.payload.source, 'server')
  assert.equal(last.seq, rec.last_seq)
  assert.equal(last.seq, evs[evs.length - 2].seq + 1)
  await assert.rejects(mgr.cancel(rec.task_id), (e: unknown) => e instanceof HttpError && e.status === 409)
  await assert.rejects(mgr.cancel('t00000000-000000-0000'), (e: unknown) => e instanceof HttpError && e.status === 404)
})

test('运行失败（退出码 3）：引擎终态为准，error 带 run_failed 与出错节点', async () => {
  const r = await mgr.submit({ body: await slice1('fail3') })
  const rec = await done(mgr, r.task.task_id)
  assert.equal(rec.run_state, 'failed')
  assert.equal(rec.result, 'invalid')
  assert.equal(rec.exit_code, 3)
  assert.equal(rec.error?.code, 'run_failed')
  assert.equal(rec.error?.node_id, 'mix')
  assert.deepEqual(rec.observation_points[0].rows_seen, { spectrum: 1 })
  assert.deepEqual(rec.reasons, ['mix 处理失败：假引擎 fail3'])
})

test('运行时装载失败（校验过后环境变了，退出码 2）：failed / invalid 带引擎 error', async () => {
  const r = await mgr.submit({ body: await slice1('error2run') })
  const rec = await done(mgr, r.task.task_id)
  assert.equal(rec.run_state, 'failed')
  assert.equal(rec.exit_code, 2)
  assert.equal(rec.error?.code, 'param')
})

test('引擎没给终态就退出（退出码 4 / 被 SIGKILL）：failed 带 stderr 尾与退出信息，服务端补发终态事件', async () => {
  const a = await mgr.submit({ body: await slice1('io4') })
  const ra = await done(mgr, a.task.task_id)
  assert.equal(ra.run_state, 'failed')
  assert.equal(ra.result, 'invalid')
  assert.equal(ra.exit_code, 4)
  assert.match(ra.stderr_tail ?? '', /io4/)
  assert.ok(!(ra.stderr_tail ?? '').includes(root))
  assert.match(ra.reasons[0], /异常退出/)
  assert.equal(ra.error?.code, 'engine')
  const ev = mgr.events(ra.task_id)!
  assert.equal(ev.length, 1)
  assert.equal(ev[0].payload.source, 'server')
  assert.equal(ev[0].payload.run_state, 'failed')

  const b = await mgr.submit({ body: await slice1('crash') })
  const rb = await done(mgr, b.task.task_id)
  assert.equal(rb.run_state, 'failed')
  assert.equal(rb.signal, 'SIGKILL')
  assert.equal(rb.cancel_requested, false)
  assert.deepEqual(rb.observation_points[0].rows_seen, { spectrum: 2 })
})

function baseRec(id: string, over: Partial<TaskRecord>): TaskRecord {
  return {
    schema_version: TASK_SCHEMA, task_id: id, diagram_id: 'd', name: 'n', diagram_sha256: '0'.repeat(64),
    seed: 1, seed_source: null, run_state: 'queued', result: 'not_applicable', reasons: [], created_utc: '2026-09-05T00:00:00Z',
    cancel_requested: false, observation_points: [], data_refs: [], warnings: [], last_seq: 0,
    files: { diagram: 'diagram.json', events: 'events.jsonl' }, ...over,
  }
}

test('重启对账：events.jsonl 有终态就采纳（经脱敏）；没有就 failed；请求过取消的 → cancelled；已结束的不动；幂等表重建', async () => {
  const r2 = await makeRoot()
  extraRoots.push(r2)
  await makeDataFixture(r2)
  const cfg = { root: r2, runsRel: 'data/runs' }
  const mk = async (id: string, rec: TaskRecord, files: Record<string, string> = {}) => {
    await fsp.mkdir(taskDirAbs(cfg, id), { recursive: true })
    for (const [name, text] of Object.entries(files)) await fsp.writeFile(join(taskDirAbs(cfg, id), name), text)
    await writeTask(cfg, rec)
  }
  const rel = `data/iq/measured/fx/${FX_IDS.ok}.manifest.json`
  const ev = (seq: number, type: string, payload: unknown) => JSON.stringify({ seq, task_id: 'ta', type, t_s: 0, payload })
  await mk('ta', baseRec('ta', { run_state: 'running', files: { diagram: 'diagram.json', resolved: FILE_RESOLVED, events: FILE_EVENTS } }), {
    [FILE_RESOLVED]: JSON.stringify({ schema_version: 'cuav-resolved/1', data: { [FX_IDS.ok]: rel } }),
    [FILE_EVENTS]: [
      ev(1, 'task.state', { run_state: 'running', observation_points: [{ op_id: 's4', node: 'replay', port: 'out', products: ['spectrum'] }] }),
      ev(2, 'product_row', { op_id: 's4', kind: 'spectrum', row_index: 0, row_len: 1024 }),
      ev(3, 'task.state', { run_state: 'finished', result: 'degraded', reasons: [`清单 ${r2}/${rel} 采集参数来自论文`], rounds: 7, ended_utc: '2026-09-05T00:00:09Z' }),
    ].join('\n') + '\n',
  })
  await mk('tb', baseRec('tb', { run_state: 'running' }))
  await mk('tc', baseRec('tc', { run_state: 'queued', cancel_requested: true }))
  const body = await slice1()
  const sha = sha256Hex(JSON.stringify(body, null, 2) + '\n')
  await mk('td', baseRec('td', { run_state: 'finished', result: 'valid', diagram_sha256: sha, idempotency_key: 'k-restart', last_seq: 9 }))

  const m2 = createTaskManager({ root: r2, engine: fakeEngine(r2) })
  await m2.init()
  const ta = m2.get('ta')!
  assert.equal(ta.run_state, 'finished')
  assert.equal(ta.result, 'degraded')
  assert.equal(ta.rounds, 7)
  assert.equal(ta.last_seq, 3)
  assert.equal(ta.ended_utc, '2026-09-05T00:00:09Z')
  assert.deepEqual(ta.reasons, [`清单 ${FX_IDS.ok} 采集参数来自论文`])
  assert.match(ta.warnings[0], /对账/)
  const tb = m2.get('tb')!
  assert.equal(tb.run_state, 'failed')
  assert.equal(tb.result, 'invalid')
  assert.deepEqual(tb.reasons, ['服务重启时任务未结束'])
  const tc = m2.get('tc')!
  assert.equal(tc.run_state, 'cancelled')
  assert.equal(tc.result, 'not_applicable')
  const td = m2.get('td')!
  assert.equal(td.run_state, 'finished')
  assert.deepEqual(td.warnings, [])
  assert.deepEqual(await readTask(cfg, 'tb'), tb)
  const again = await m2.submit({ body, idempotencyKey: 'k-restart' })
  assert.equal(again.status, 200)
  assert.equal(again.task.task_id, 'td')
  assert.equal(m2.list().length, 4)
  assert.equal(m2.list(2).length, 2)
})

test('服务退出收尾：运行中的标 failed 并杀进程，排队中的标 failed，task.json 同步落盘', async () => {
  const r3 = await makeRoot()
  extraRoots.push(r3)
  const m3 = createTaskManager({ root: r3, engine: fakeEngine(r3) })
  await m3.init()
  const h = await m3.submit({ body: await slice1('hang') })
  const q = await m3.submit({ body: await slice1() })
  await waitFor(() => (m3.get(h.task.task_id)!.last_seq >= 1 ? true : undefined), 'hang 起来')
  m3.shutdownSync()
  const rh = await readTask(m3.storeConfig, h.task.task_id)
  const rq = await readTask(m3.storeConfig, q.task.task_id)
  assert.equal(rh?.run_state, 'failed')
  assert.deepEqual(rh?.reasons, ['服务停止时任务被中止'])
  assert.equal(rq?.run_state, 'failed')
  assert.deepEqual(rq?.reasons, ['服务停止时任务尚在排队'])
  await assert.rejects(m3.submit({ body: await slice1() }), (e: unknown) => e instanceof HttpError && e.status === 503)
})
