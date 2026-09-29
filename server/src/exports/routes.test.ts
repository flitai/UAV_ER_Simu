// 数据导出端点（D-090）：错误码与可导出列表用手搭的运行目录测；导出本身用真引擎跑一次（没有构建产物就跳过并说明）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, promises as fsp } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ExportService, handleExportRoutes, isExportPath, type ExportDeps, type ExportJob } from './routes.js'
import { Engine, defaultEngineBinary } from '../tasks/engine.js'
import type { TaskRecord } from '../tasks/store.js'
import type { CatalogDoc } from './sigmf.js'
import { REPO_ROOT } from '../tasks/testkit.js'

/** 异步轮询（testkit 的 waitFor 只收同步函数） */
async function waitAsync<T>(fn: () => Promise<T | undefined>, label: string, timeoutMs: number, stepMs: number): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

function rec(id: string, run_state: string): TaskRecord {
  return { task_id: id, run_state } as unknown as TaskRecord
}

async function serve(svc: ExportService): Promise<{ srv: Server; base: string }> {
  const srv = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    void handleExportRoutes(req, res, path, svc).then((hit) => {
      if (!hit) {
        res.writeHead(404)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** 手搭一个运行目录：s3 挂在 ADC 上且开 iq、s0 挂在源上也开 iq（ADC 之前，不可导出）、s4 没开 iq */
async function fakeRun(dir: string, withIndex = true): Promise<void> {
  await fsp.mkdir(join(dir, 's3'), { recursive: true })
  const diagram = {
    diagram_id: 'fx', nodes: [{ id: 'tx', type: 'SceneEmitterSource' }, { id: 'adc', type: 'AdcQuantizer' }, { id: 'ddc', type: 'DDC' }],
    edges: [], observation_points: [
      { id: 's0', node: 'tx', port: 'out', products: ['spectrum', 'iq'] },
      { id: 's3', node: 'adc', port: 'out', products: ['spectrum', 'envelope', 'iq'], label: 'S3 ADC 输出' },
      { id: 's4', node: 'ddc', port: 'out', products: ['spectrum'] },
    ],
  }
  await fsp.writeFile(join(dir, 'diagram.json'), JSON.stringify(diagram))
  if (withIndex) {
    await fsp.writeFile(join(dir, 's3', 'iq.index.json'),
      JSON.stringify({ samples: 1000, sample_rate_Hz: 1e6, center_Hz: 2.44e9 }))
  }
}

test('导出端点：404、405、可导出列表只列 ADC 之后且开了 iq 的观测点', async () => {
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'cuav-export-'))
  const tasks = new Map<string, TaskRecord>([['t1', rec('t1', 'finished')], ['t2', rec('t2', 'running')]])
  const deps: ExportDeps = {
    root: REPO_ROOT, getTask: (id) => tasks.get(id) ?? null,
    runDir: (id) => join(tmp, 'runs', id), exportDir: (id) => join(tmp, 'exports', id),
    catalog: async () => ({ engine_version: 'x', components: [] }),
  }
  await fakeRun(join(tmp, 'runs', 't1'))
  await fakeRun(join(tmp, 'runs', 't2'))
  const svc = new ExportService(deps)
  const { srv, base } = await serve(svc)
  try {
    assert.ok(isExportPath('/api/v1/tasks/t1/export') && !isExportPath('/api/v1/tasks/t1'))
    assert.equal((await fetch(`${base}/api/v1/tasks/nope/export`)).status, 404)
    assert.equal((await fetch(`${base}/api/v1/tasks/..%2Fetc/export`)).status, 404)
    assert.equal((await fetch(`${base}/api/v1/tasks/t1/export`, { method: 'PUT' })).status, 405)
    const g = await (await fetch(`${base}/api/v1/tasks/t1/export`)).json() as Record<string, unknown>
    assert.equal(g.dir, 'data/exports/t1/')                                // 相对仓库根，不给绝对路径
    assert.deepEqual(g.exportable, [{
      op_id: 's3', point: 'S3', label: 'S3 ADC 输出', sample_rate_Hz: 1e6, center_Hz: 2.44e9, samples: 1000,
      duration_s: 0.001, bytes_raw: 8000, bytes_export: 4000,
    }])
    assert.equal(g.job, null)
    assert.deepEqual(g.files, [])
    assert.ok(!JSON.stringify(g).includes(tmp), '响应里漏出了服务器路径')
    // 没跑完：409；观测点不可导出：400；类型不对：400；缺 content-type：415
    assert.equal((await post(`${base}/api/v1/tasks/t2/export`, {})).status, 409)
    const bad = await post(`${base}/api/v1/tasks/t1/export`, { ops: ['s0'] })
    assert.equal(bad.status, 400)
    assert.deepEqual(((await bad.json()) as { ops: string[] }).ops, ['s0'])
    assert.equal((await post(`${base}/api/v1/tasks/t1/export`, { ops: 's3' })).status, 400)
    assert.equal((await fetch(`${base}/api/v1/tasks/t1/export`, { method: 'POST', body: '{}' })).status, 415)
    // 没有可导出的观测点：409
    await fsp.rm(join(tmp, 'runs', 't1', 's3', 'iq.index.json'))
    assert.equal((await post(`${base}/api/v1/tasks/t1/export`, {})).status, 409)
  } finally {
    srv.close()
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

const BIN = defaultEngineBinary(REPO_ROOT)
const skip = existsSync(BIN) ? false : `没有引擎二进制 ${BIN}，先 cmake --build engine/build`

test('真引擎：缺省链 S3 开 iq 跑 0.05 s → 导出 SigMF → 文件在导出目录、临时目录已清、重启后仍报上一次结果', { skip }, async () => {
  const id = `export-routes-${process.pid}`
  const runRel = `data/runs/${id}`
  const runAbs = join(REPO_ROOT, runRel)
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'cuav-export-real-'))
  try {
    const d = JSON.parse(await fsp.readFile(join(REPO_ROOT, 'tests', 'regression', 'diagrams', 'chain-synthetic.json'), 'utf8'))
    d.diagram_id = id
    for (const op of d.observation_points) if (op.id === 's3') op.products = [...op.products, 'iq']
    const dpath = join(tmp, 'diagram.json')
    await fsp.writeFile(dpath, JSON.stringify(d, null, 2) + '\n')
    execFileSync(BIN, ['--run', dpath, '--out', runRel, '--task-id', id,
      '--scenario', 'data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json', '--library-root', 'models/recognition'],
    { cwd: REPO_ROOT, stdio: 'ignore' })
    await fsp.copyFile(dpath, join(runAbs, 'diagram.json'))

    const engine = new Engine({ bin: BIN, cwd: REPO_ROOT })
    const deps: ExportDeps = {
      root: REPO_ROOT, getTask: (x) => (x === id ? rec(id, 'finished') : null),
      runDir: () => runAbs, exportDir: () => join(tmp, 'exports'),
      catalog: async () => (await engine.catalog()).catalog as unknown as CatalogDoc,
    }
    const svc = new ExportService(deps)
    const { srv, base } = await serve(svc)
    try {
      const g0 = await (await fetch(`${base}/api/v1/tasks/${id}/export`)).json() as { exportable: Array<{ op_id: string; samples: number }> }
      assert.deepEqual(g0.exportable.map((x) => x.op_id), ['s3'])
      const n = g0.exportable[0].samples
      const p = await post(`${base}/api/v1/tasks/${id}/export`, { ops: ['s3'] })
      assert.equal(p.status, 202)
      // 同一任务正在导出时再点：409（作业可能已经跑完，那就不再断言它）
      const again = await post(`${base}/api/v1/tasks/${id}/export`, {})
      assert.ok(again.status === 409 || again.status === 202)
      const done = await waitAsync(async () => {
        const g = await (await fetch(`${base}/api/v1/tasks/${id}/export`)).json() as { job: ExportJob | null; files: Array<{ name: string; bytes: number }> }
        return g.job && g.job.state !== 'running' ? g : undefined
      }, '导出完成', 60000, 50)
      assert.equal(done.job!.state, 'done', done.job!.error)
      assert.equal(done.job!.results![0].point, 'S3')
      assert.equal(done.job!.results![0].lossless, true)
      assert.equal(done.job!.progress.done_bytes, 8 * n)
      const names = done.files.map((f) => f.name)
      assert.deepEqual(names, [`${id}_s3.cuav-links.jsonl`, `${id}_s3.sigmf-data`, `${id}_s3.sigmf-meta`])
      assert.equal(done.files.find((f) => f.name.endsWith('.sigmf-data'))!.bytes, 4 * n)
      const meta = JSON.parse(await fsp.readFile(join(tmp, 'exports', `${id}_s3.sigmf-meta`), 'utf8'))
      assert.equal(meta.global['core:datatype'], 'ci16_le')
      assert.ok(meta.annotations.length > 0, '真值写进了注记')
      assert.ok((await fsp.readdir(join(tmp, 'exports'))).every((f) => !f.startsWith('.tmp-')), '临时目录没清')
      // 服务重启（新实例）：GET 读 export.json 报上一次的结果
      const svc2 = new ExportService(deps)
      const j2 = await svc2.job(id)
      assert.equal(j2?.state, 'done')
      assert.equal(j2?.results?.[0].stem, `${id}_s3`)
    } finally {
      srv.close()
    }
  } finally {
    await fsp.rm(runAbs, { recursive: true, force: true })
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})
