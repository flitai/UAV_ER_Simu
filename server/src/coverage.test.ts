// 覆盖场端点（D-080）：同步调真引擎（缺二进制即跳过），用仓库里的基准场景与观测区域清单。
// E1 不读建筑集，所以这些用例在任何一份克隆上都跑得起来（只要引擎建过）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Engine, defaultEngineBinary } from './tasks/engine.js'
import { ScenarioIndex } from './tasks/resolve.js'
import { handleCoverageRoutes } from './coverage.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const engineOk = existsSync(defaultEngineBinary(REPO_ROOT))
const skip = engineOk ? false : '引擎未构建（engine/build/cuav_run），跳过'
let srv: Server
let base = ''

before(async () => {
  const index = new ScenarioIndex(REPO_ROOT)
  const engine = new Engine({ bin: defaultEngineBinary(REPO_ROOT), cwd: REPO_ROOT })
  srv = createServer((req, res) => {
    if (!handleCoverageRoutes({ root: REPO_ROOT, index, engine }, req, res, new URL(req.url ?? '/', 'http://x').pathname)) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})

after(async () => { await new Promise<void>((r) => srv.close(() => r())) })

const request = (extra: Record<string, unknown> = {}) => ({
  schema_version: 'cuav-field-request/1',
  scenario_id: 'golden-01',
  emitter_id: 'uav-1',
  height_agl_m: 100,
  res_m: 1000,
  propagation: {},
  detectors: { 'site-1': { nfft: 1024, pfa: 1e-3, band_lo_Hz: -225000, band_hi_Hz: 225000 } },
  ...extra,
})
const post = (body: unknown) => fetch(`${base}/api/v1/coverage`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('只收 POST', async () => {
  const r = await fetch(`${base}/api/v1/coverage`)
  assert.equal(r.status, 405)
})

test('场景标识不合法 400、不存在 404，都不去碰引擎', async () => {
  assert.equal((await post(request({ scenario_id: 'Bad Id' }))).status, 400)
  assert.equal((await post(request({ scenario_id: 'no-such-scenario' }))).status, 404)
})

test('请求被引擎拒：400 并带引擎的报文', { skip }, async () => {
  const r = await post(request({ propagation: { prop_shadow: true } }))   // E1 却开效应：与框图同一道闸
  assert.equal(r.status, 400)
  const j = await r.json()
  assert.equal(j.error, 'field_invalid')
  assert.ok(typeof j.detail?.message === 'string' && j.detail.message.length > 0)
})

test('算得出：float32 网格 = (1 + 站数) × nx × ny，摘要在 X-CUAV-Field，临时文件用完即删', { skip }, async () => {
  const r = await post(request())
  assert.equal(r.status, 200)
  const meta = JSON.parse(decodeURIComponent(r.headers.get('x-cuav-field') ?? ''))
  const buf = new Float32Array(await r.arrayBuffer())
  assert.equal(meta.nx, 20)
  assert.equal(meta.ny, 20)
  assert.deepEqual(meta.layers, ['combined', 'site-1'])
  assert.equal(buf.length, 2 * 20 * 20)
  for (const v of buf) assert.ok(v >= 0 && v <= 1)
  assert.equal(meta.prop_level, 'E1')
  assert.equal(meta.sites[0].m_bins, 921)
  // 服务器路径不出现在摘要里（D-037）
  assert.ok(!JSON.stringify(meta).includes(REPO_ROOT))
  const tmp = join(REPO_ROOT, 'data', 'tmp', 'coverage')
  assert.deepEqual(existsSync(tmp) ? readdirSync(tmp) : [], [])
})
