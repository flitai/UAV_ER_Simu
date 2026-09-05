// 真引擎集成：切片 ① 框图经任务管理器跑到底（B-5）。没有构建产物就跳过并说明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { Engine, defaultEngineBinary } from './engine.js'
import { HttpError, createTaskManager } from './manager.js'
import { taskDirAbs, type TaskRecord } from './store.js'
import { REPO_ROOT, makeRoot, rmrf, slice1, waitFor } from './testkit.js'

const BIN = defaultEngineBinary(REPO_ROOT)
const skip = existsSync(BIN) ? false : `没有引擎二进制 ${BIN}，先 cmake --build engine/build`

test('真引擎：目录与黄金基准同组件集；切片 ① 提交→完成，产品行数与 events.jsonl 序号如 B-4 所记；内部参数与未知类型都 400；长任务可取消', { skip }, async () => {
  const root = await makeRoot('cuav-real-')
  try {
    const engine = new Engine({ bin: BIN, cwd: root })
    const mgr = createTaskManager({ root, engine, killGraceMs: 1000 })
    await mgr.init()

    const cat = await engine.catalog()
    const golden = JSON.parse(await fsp.readFile(join(REPO_ROOT, 'tests', 'golden', 'component-catalog.json'), 'utf8')) as { components: Array<{ type: string }> }
    assert.deepEqual([...cat.types].sort(), golden.components.map((c) => c.type).sort())
    assert.deepEqual([...cat.internal.get('FileReplaySource')!], ['manifest_path'])
    assert.deepEqual([...cat.internal.get('ObservationTap')!], ['out_dir'])

    const t0 = Date.now()
    const r = await mgr.submit({ body: await slice1() })
    const validateMs = Date.now() - t0
    assert.equal(r.status, 201)
    const isDone = (x: TaskRecord | null) => !!x && x.run_state !== 'queued' && x.run_state !== 'running' && x.exit_code !== undefined
    const rec = await waitFor(() => (isDone(mgr.get(r.task.task_id)) ? mgr.get(r.task.task_id)! : undefined), '切片 ① 跑完', 120000, 50)
    assert.equal(rec.run_state, 'finished', JSON.stringify(rec.error ?? rec.reasons))
    assert.equal(rec.result, 'valid')
    assert.equal(rec.exit_code, 0)
    assert.equal(rec.engine_version, cat.engine_version)
    assert.deepEqual(rec.observation_points[0].rows_seen, { spectrum: 1953, envelope: 489 })
    const dir = taskDirAbs(mgr.storeConfig, rec.task_id)
    const lines = (await fsp.readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, rec.last_seq)
    lines.forEach((l, i) => assert.equal((JSON.parse(l) as { seq: number }).seq, i + 1))
    assert.equal((await fsp.stat(join(dir, 's4', 'spectrum.f32'))).size, 1953 * 1024 * 4)
    const evs = mgr.events(rec.task_id, 0, 100000)!
    assert.equal(evs.length, rec.last_seq)
    for (const e of evs) assert.ok(!JSON.stringify(e).includes(root), '事件里漏出了仓库根')
    console.log(`真引擎：--validate 约 ${validateMs} ms，运行 wall ${rec.wall_s} s，实时因子 ${rec.realtime_factor}`)

    const withInternal = await slice1()
    ;(withInternal.nodes as Array<Record<string, unknown>>)[0] = { id: 'tone', type: 'FileReplaySource', params: { data_id: 'x', manifest_path: '/srv/x' } }
    await assert.rejects(mgr.submit({ body: withInternal }), (e: unknown) =>
      e instanceof HttpError && e.status === 400 && (e.body.detail as { code: string }).code === 'internal_param')
    const unknownType = await slice1()
    ;(unknownType.nodes as Array<Record<string, unknown>>)[0].type = 'NoSuchComponent'
    await assert.rejects(mgr.submit({ body: unknownType }), (e: unknown) =>
      e instanceof HttpError && e.status === 400 && (e.body.detail as { code: string; node_id: string }).code === 'unknown_type'
      && (e.body.detail as { node_id: string }).node_id === 'tone')

    const long = await slice1()
    ;(long.run as Record<string, unknown>).duration_s = 60
    const lr = await mgr.submit({ body: long })
    await waitFor(() => ((mgr.get(lr.task.task_id)!.observation_points[0]?.rows_seen.spectrum ?? 0) >= 5 ? true : undefined), '长任务出行', 30000)
    await mgr.cancel(lr.task.task_id)
    const lrec = await waitFor(() => (isDone(mgr.get(lr.task.task_id)) ? mgr.get(lr.task.task_id)! : undefined), '长任务取消', 15000)
    assert.equal(lrec.run_state, 'cancelled')
    assert.equal(lrec.result, 'not_applicable')
    assert.ok((lrec.observation_points[0].rows_seen.spectrum ?? 0) >= 5)
    mgr.shutdownSync()
  } finally {
    await rmrf(root)
  }
})
