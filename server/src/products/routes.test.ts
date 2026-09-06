// 视窗抽取端点的 HTTP 层（B-7）：状态码、参数校验、响应头、HEAD、413、索引与 JSONL 端点。
//
// 用假引擎跑出真的产品文件（每行的值 = 行号 × 1000 + 列号），索引由测试自己写——假引擎与 cuav_run
// 同构但不写索引（它的用途是状态机测试）。这样既不依赖 C++ 构建，又能覆盖「索引落后于文件」这一实况。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { handleResultRoutes } from './routes.js'
import { createTaskManager, type TaskManager } from '../tasks/manager.js'
import { taskDirAbs, type TaskRecord } from '../tasks/store.js'
import { fakeEngine, makeRoot, rmrf, slice1, waitFor } from '../tasks/testkit.js'

let root = ''
let mgr: TaskManager
let srv: Server
let base = ''
let taskId = ''
let dir = ''
let maxBytes: number | undefined

const NFFT = 1024
const SPEC_ROWS = 3
const ENV_ROWS = 2
const FS = 1e6
const HOP = 1024
const BW = FS / NFFT
const DT = HOP / FS
const CENTER = 2.44e9
const BUCKET = 4096

const specIndex = (rows: number) => ({
  schema_version: 'cuav-product/1', kind: 'spectrum', dtype: 'float32', byte_order: 'little', op_id: 's4',
  row_len: NFFT, rows, sample_rate_Hz: FS, center_Hz: CENTER, bin_width_Hz: BW, frame_hop_samples: HOP,
  nfft: NFFT, segments_per_frame: 1, window: 'hann', start_sample: 0, t0_s: 0, scale: 'dBFS', floor_dB: -300,
  state: 'degraded', state_reasons: ['测试夹具'], notes: [], trace: { model_id: 'AddMixer' },
  producer: { component: 'ObservationTap' },
})
const envIndex = (rows: number, last: number) => ({
  schema_version: 'cuav-product/1', kind: 'envelope', dtype: 'float32', byte_order: 'little', op_id: 's4',
  row_len: 3, rows, sample_rate_Hz: FS, center_Hz: CENTER, bucket_samples: BUCKET, last_bucket_samples: last,
  columns: ['min_abs', 'max_abs', 'rms_abs'], start_sample: 0, t0_s: 0, scale: 'linear_FS',
  state: 'valid', state_reasons: [], notes: [], trace: {}, producer: {},
})

before(async () => {
  root = await makeRoot('cuav-results-')
  mgr = createTaskManager({ root, engine: fakeEngine(root) })
  await mgr.init()
  const r = await mgr.submit({ body: await slice1('finish') })
  taskId = r.task.task_id
  await waitFor(() => {
    const t = mgr.get(taskId)
    return t && t.run_state === 'finished' ? t : undefined
  }, '假引擎跑完', 10000, 20)
  dir = taskDirAbs(mgr.storeConfig, taskId)
  srv = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (!(await handleResultRoutes(req, res, url, { mgr, maxBytes }))) {
        res.writeHead(404)
        res.end('nf')
      }
    })().catch((e) => {
      res.writeHead(500)
      res.end(String(e))
    })
  })
  await new Promise<void>((r2) => srv.listen(0, '127.0.0.1', r2))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})
after(async () => {
  await new Promise<void>((r) => srv.close(() => r()))
  mgr.shutdownSync()
  await rmrf(root)
})

const url = (p: string) => `${base}/api/v1/results/${p}`
const f32 = async (r: Response) => new Float32Array(await r.arrayBuffer())

test('假引擎产出的产品文件在盘上；索引尚未写出时一律 409 not_ready 并带 retry-after', async () => {
  const st = await fsp.stat(join(dir, 's4', 'spectrum.f32'))
  assert.equal(st.size, SPEC_ROWS * NFFT * 4)
  assert.equal((await fsp.stat(join(dir, 's4', 'envelope.f32'))).size, ENV_ROWS * 3 * 4)

  const r = await fetch(url(`${taskId}/s4/spectrum`))
  assert.equal(r.status, 409)
  assert.equal(r.headers.get('retry-after'), '1')
  const j = (await r.json()) as Record<string, unknown>
  assert.equal(j.reason, 'index_missing')
  assert.equal(j.bytes, SPEC_ROWS * NFFT * 4)

  // 包络在索引缺失时能算出行数（行长恒为 3）
  const e = (await (await fetch(url(`${taskId}/s4/envelope`))).json()) as Record<string, unknown>
  assert.equal(e.rows_available, ENV_ROWS)

  // 写索引，且故意让 rows 落后于文件：读端必须以文件长度为准
  await fsp.writeFile(join(dir, 's4', 'spectrum.index.json'), JSON.stringify(specIndex(2)))
  await fsp.writeFile(join(dir, 's4', 'envelope.index.json'), JSON.stringify(envIndex(ENV_ROWS, 1500)))
})

test('404：未知任务、非法 op_id、未知观测点、scatter 暂不支持', async () => {
  assert.equal((await fetch(url(`t20260101-000000-0000/s4/spectrum`))).status, 404)
  assert.equal((await fetch(url(`不是任务/s4/spectrum`))).status, 404)
  assert.equal((await fetch(url(`${taskId}/${encodeURIComponent('../s4')}/spectrum`))).status, 404)
  assert.equal((await fetch(url(`${taskId}/nosuchop/spectrum`))).status, 404)
  const sc = await fetch(url(`${taskId}/s4/scatter?n=100`))
  assert.equal(sc.status, 404)
  assert.equal(((await sc.json()) as Record<string, unknown>).reason, 'product_unsupported')
})

test('400：坏参数带 param 字段；t1 < t0 与 f1 < f0 分别指向 t1 与 f1', async () => {
  const bad = async (qs: string, param: string) => {
    const r = await fetch(url(`${taskId}/s4/spectrum?${qs}`))
    assert.equal(r.status, 400, qs)
    const j = (await r.json()) as Record<string, unknown>
    assert.equal(j.error, 'bad_request')
    assert.equal(j.param, param, qs)
  }
  await bad('t0=abc', 't0')
  await bad('t1=1&t0=2', 't1')
  await bad('f0=1e999', 'f0')
  await bad('f0=100&f1=-100', 'f1')
  await bad('px=0', 'px')
  await bad('px=-3', 'px')
  await bad('py=1.5', 'py')
  await bad('stat=avg', 'stat')
  // 空串视为缺省，不报错
  assert.equal((await fetch(url(`${taskId}/s4/spectrum?t0=&px=&stat=`))).status, 200)
})

test('全窗 max：三行一千零二十四列直通，响应体与文件逐字节相同，八个响应头正确', async () => {
  const r = await fetch(url(`${taskId}/s4/spectrum`))
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/octet-stream')
  assert.equal(r.headers.get('x-cuav-rows'), String(SPEC_ROWS))
  assert.equal(r.headers.get('x-cuav-cols'), String(NFFT))
  assert.equal(r.headers.get('x-cuav-t0'), '0')
  assert.equal(r.headers.get('x-cuav-t1'), String(SPEC_ROWS * DT))
  assert.equal(r.headers.get('x-cuav-f0'), String((0 - NFFT / 2 - 0.5) * BW))
  assert.equal(r.headers.get('x-cuav-f1'), String((NFFT - NFFT / 2 - 0.5) * BW))
  assert.equal(r.headers.get('x-cuav-stat'), 'max')
  assert.equal(r.headers.get('x-cuav-state'), 'degraded')
  const body = Buffer.from(await r.arrayBuffer())
  assert.ok(body.equals(await fsp.readFile(join(dir, 's4', 'spectrum.f32'))), '全窗直通应与文件逐字节相同')
})

test('px 超过原始列数不插值；py = 1 的 max 与 mean 与手算一致；空窗 200 零行', async () => {
  const wide = await fetch(url(`${taskId}/s4/spectrum?px=5000&py=5000`))
  assert.equal(wide.headers.get('x-cuav-cols'), String(NFFT))
  assert.equal(wide.headers.get('x-cuav-rows'), String(SPEC_ROWS))

  // 假引擎第 i 行第 k 列 = i*1000 + k：三行合一取 max 即末行
  const mx = await f32(await fetch(url(`${taskId}/s4/spectrum?py=1&px=4&stat=max`)))
  assert.equal(mx.length, 4)
  const perGroup = NFFT / 4
  for (let h = 0; h < 4; h++) assert.equal(mx[h], (SPEC_ROWS - 1) * 1000 + (h + 1) * perGroup - 1)
  const mn = await f32(await fetch(url(`${taskId}/s4/spectrum?py=1&px=4&stat=min`)))
  for (let h = 0; h < 4; h++) assert.equal(mn[h], h * perGroup)

  // mean 在线性功率域：全组同值时应回到该值
  const one = await f32(await fetch(url(`${taskId}/s4/spectrum?py=1&px=${NFFT}&stat=mean&t0=0&t1=${DT}`)))
  assert.equal(one.length, NFFT)
  for (let k = 0; k < NFFT; k++) assert.ok(Math.abs(one[k] - k) < 1e-3, `列 ${k}：${one[k]}`)

  const empty = await fetch(url(`${taskId}/s4/spectrum?t0=100&t1=200`))
  assert.equal(empty.status, 200)
  assert.equal(empty.headers.get('x-cuav-rows'), '0')
  assert.equal(empty.headers.get('content-length'), '0')
  assert.equal((await empty.arrayBuffer()).byteLength, 0)
})

test('f0 / f1 相对 center_Hz 选列；时间窗按行起始时刻选行', async () => {
  // 列 k 覆盖 [(k-512-0.5)·BW, (k-512+0.5)·BW)：u(0) = 512.5 → 起自列 512，u(10·BW) = 522.5 → 止于列 523
  const r = await fetch(url(`${taskId}/s4/spectrum?f0=0&f1=${10 * BW}&py=1&stat=max`))
  assert.equal(r.headers.get('x-cuav-cols'), '11')
  assert.equal(r.headers.get('x-cuav-f0'), String((512 - 512 - 0.5) * BW))
  const d = await f32(r)
  assert.equal(d[0], (SPEC_ROWS - 1) * 1000 + 512)

  const t = await fetch(url(`${taskId}/s4/spectrum?t0=${DT}&t1=${2 * DT}&px=1&stat=max`))
  assert.equal(t.headers.get('x-cuav-rows'), '1')
  assert.equal(t.headers.get('x-cuav-t0'), String(DT))
  assert.equal((await f32(t))[0], 1 * 1000 + NFFT - 1)
})

test('包络：三列、无 stat 与频率头、px = 1 合桶', async () => {
  const r = await fetch(url(`${taskId}/s4/envelope`))
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-cuav-cols'), '3')
  assert.equal(r.headers.get('x-cuav-rows'), String(ENV_ROWS))
  assert.equal(r.headers.get('x-cuav-stat'), null)
  assert.equal(r.headers.get('x-cuav-f0'), null)
  assert.equal(r.headers.get('x-cuav-state'), 'valid')

  const one = await f32(await fetch(url(`${taskId}/s4/envelope?px=1`)))
  assert.equal(one.length, 3)
  const all = await f32(await fetch(url(`${taskId}/s4/envelope`)))
  assert.equal(one[0], Math.min(all[0], all[3]))
  assert.equal(one[1], Math.max(all[1], all[4]))
  // 索引 rows 与文件行数一致（2 == 2）→ 已收尾，末桶按 last_bucket_samples 计权
  const w = (BUCKET * all[2] * all[2] + 1500 * all[5] * all[5]) / (BUCKET + 1500)
  assert.ok(Math.abs(one[2] - Math.sqrt(w)) < 1e-3, `${one[2]} vs ${Math.sqrt(w)}`)
})

test('HEAD：有头有 content-length，没有响应体，且不读产品文件', async () => {
  const r = await fetch(url(`${taskId}/s4/spectrum?px=8&py=2`), { method: 'HEAD' })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-cuav-rows'), '2')
  assert.equal(r.headers.get('x-cuav-cols'), '8')
  assert.equal(r.headers.get('content-length'), String(2 * 8 * 4))
  assert.equal((await r.arrayBuffer()).byteLength, 0)
})

test('413：超上限带 suggest，且建议值再取一次能过', async () => {
  maxBytes = 4096
  try {
    const r = await fetch(url(`${taskId}/s4/spectrum?px=1024&py=3`))
    assert.equal(r.status, 413)
    const j = (await r.json()) as { max_bytes: number; bytes: number; suggest: { px: number; py: number } }
    assert.equal(j.max_bytes, 4096)
    assert.equal(j.bytes, 3 * 1024 * 4)
    assert.ok(j.suggest.px >= 1 && j.suggest.py >= 1)
    const ok = await fetch(url(`${taskId}/s4/spectrum?px=${j.suggest.px}&py=${j.suggest.py}`))
    assert.equal(ok.status, 200)
    assert.ok(Number(ok.headers.get('x-cuav-rows')) * Number(ok.headers.get('x-cuav-cols')) * 4 <= 4096)
  } finally {
    maxBytes = undefined
  }
})

test('索引端点：索引原文加 rows_available、index_final、run_state', async () => {
  const j = (await (await fetch(url(`${taskId}/s4/spectrum/index`))).json()) as Record<string, unknown>
  assert.equal(j.schema_version, 'cuav-product/1')
  assert.equal(j.nfft, NFFT)
  assert.equal(j.rows, 2) // 索引里记的（落后）
  assert.equal(j.rows_available, SPEC_ROWS) // 文件里真有的
  assert.equal(j.index_final, false)
  assert.equal(j.run_state, 'finished')
  assert.equal(j.scale, 'dBFS')
  const e = (await (await fetch(url(`${taskId}/s4/envelope/index`))).json()) as Record<string, unknown>
  assert.equal(e.index_final, true)
  assert.equal(e.last_bucket_samples, 1500)
})

test('JSONL 端点：文件不存在按运行态 404；有文件时时间窗与按键抽稀生效', async () => {
  for (const k of ['track', 'links', 'detections']) {
    const r = await fetch(url(`${taskId}/${k}`))
    assert.equal(r.status, 404, k)
    assert.equal(((await r.json()) as Record<string, unknown>).kind, k)
  }
  const lines: string[] = []
  for (let i = 0; i < 6; i++) {
    lines.push(JSON.stringify({ t_s: i * 0.5, id: 'uav-1', lon: 116.4, lat: 39.99 }))
    lines.push(JSON.stringify({ t_s: i * 0.5, id: 'uav-2', lon: 116.5, lat: 39.98 }))
  }
  await fsp.writeFile(join(dir, 'track.jsonl'), lines.join('\n') + '\n')

  const all = await fetch(url(`${taskId}/track`))
  assert.equal(all.status, 200)
  assert.equal(all.headers.get('x-cuav-rows'), '12')
  assert.equal(all.headers.get('x-cuav-skipped'), '0')
  assert.equal(((await all.json()) as unknown[]).length, 12)

  const win = (await (await fetch(url(`${taskId}/track?t0=0.5&t1=1.5`))).json()) as Array<{ t_s: number }>
  assert.deepEqual(win.map((r) => r.t_s), [0.5, 0.5, 1, 1, 1.5, 1.5])

  const thin = (await (await fetch(url(`${taskId}/track?stride=2`))).json()) as Array<{ id: string; t_s: number }>
  assert.equal(thin.length, 6)
  assert.deepEqual(thin.filter((r) => r.id === 'uav-1').map((r) => r.t_s), [0, 1, 2])

  const r400 = await fetch(url(`${taskId}/track?stride=0`))
  assert.equal(r400.status, 400)

  maxBytes = 64
  try {
    const big = await fetch(url(`${taskId}/track`))
    assert.equal(big.status, 413)
    assert.ok(((await big.json()) as { suggest: { stride: number } }).suggest.stride > 1)
  } finally {
    maxBytes = undefined
  }
})

test('links 端点支持 link_id 过滤；POST 一律 405', async () => {
  await fsp.writeFile(
    join(dir, 'links.jsonl'),
    [
      JSON.stringify({ t_s: 0, link_id: 'a', path_loss_dB: 100 }),
      JSON.stringify({ t_s: 0, link_id: 'b', path_loss_dB: 110 }),
      JSON.stringify({ t_s: 1, link_id: 'a', path_loss_dB: 101 }),
    ].join('\n') + '\n',
  )
  const a = (await (await fetch(url(`${taskId}/links?link_id=a`))).json()) as unknown[]
  assert.equal(a.length, 2)
  const all = (await (await fetch(url(`${taskId}/links`))).json()) as unknown[]
  assert.equal(all.length, 3)

  for (const p of [`${taskId}/s4/spectrum`, `${taskId}/s4/spectrum/index`, `${taskId}/track`]) {
    const r = await fetch(url(p), { method: 'POST' })
    assert.equal(r.status, 405, p)
    assert.equal(r.headers.get('allow'), 'GET, HEAD')
  }
})

test('运行中的任务：产品还没出现时 409 product_missing 而不是 404', async () => {
  const rec = mgr.get(taskId) as TaskRecord
  const saved = rec.run_state
  rec.run_state = 'running'
  try {
    const r = await fetch(url(`${taskId}/nosuchop2/spectrum`))
    assert.equal(r.status, 409)
    const j = (await r.json()) as Record<string, unknown>
    assert.equal(j.reason, 'product_missing')
    assert.equal(j.run_state, 'running')
    assert.equal((await fetch(url(`${taskId}/track2`))).status, 404) // 不是已知的 JSONL 名 → 交回主路由
  } finally {
    rec.run_state = saved
  }
})

test('参数校验先于服务端状态：产品未就绪时坏参数仍回 400，客户端不会拿着坏查询一直重试', async () => {
  const rec = mgr.get(taskId) as TaskRecord
  const saved = rec.run_state
  rec.run_state = 'running'
  try {
    // nosuchop3 的产品文件不存在，运行中本应 409；但参数先错，必须是 400
    const r = await fetch(url(`${taskId}/nosuchop3/spectrum?px=0`))
    assert.equal(r.status, 400)
    assert.equal(((await r.json()) as Record<string, unknown>).param, 'px')
    // 参数正确时才轮到就绪判定
    assert.equal((await fetch(url(`${taskId}/nosuchop3/spectrum?px=8`))).status, 409)
  } finally {
    rec.run_state = saved
  }
})
