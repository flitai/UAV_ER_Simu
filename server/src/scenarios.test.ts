// 场景读写端点（G-4）：清单、读取、写入、拒绝路径、哈希口径。
//
// 校验分两层：服务端只做最小结构检查，语义交引擎（D-042）。引擎缺席时用一个假引擎替身，
// 保证这些用例不依赖 C++ 构建；「真引擎挡下坏场景」另有一条用例，缺二进制时跳过。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { handleScenarioRoutes } from './scenarios.js'
import { ScenarioIndex } from './tasks/resolve.js'
import { Engine, defaultEngineBinary } from './tasks/engine.js'
import { makeRoot, rmrf, REPO_ROOT } from './tasks/testkit.js'

let root = ''
let srv: Server
let base = ''
let index: ScenarioIndex
let engineOk = true
let aoiSha = ''

/** 一个能过引擎的最小场景：坐标取观测区域中心附近。 */
function demoScenario(id = 'unit-01'): Record<string, unknown> {
  return {
    schema_version: 'cuav-scenario/1',
    scenario_id: id,
    name: '单测场景',
    synthetic: true,
    aoi: { id: 'test-aoi', manifest_sha256: aoiSha },
    coordinate: { crs: 'EPSG:4326', alt_ref: 'AGL', terrainHeight_m: 0, coord_version: 'wgs84-2026-09' },
    time: { basis: 'LogicalSim', duration_s: 10 },
    seed: 1,
    sites: [
      {
        id: 'site-1', name: '站',
        position: { lon: 116.405, lat: 39.99, alt_m: 30 },
        antenna: { gain_dBi: 3, pattern: 'omni' },
        receiver: { fs_Hz: 500000, center_Hz: 2440500000, bw_Hz: 400000, nf_dB: 6 },
      },
    ],
    emitters: [
      {
        id: 'uav-1', name: '机', platform_type: 'multirotor',
        position: { lon: 116.41, lat: 39.995, alt_m: 100 },
        emission: {
          center_Hz: 2440500000, bw_Hz: 400000, tx_power_dBm: 27, antenna_gain_dBi: 2,
          waveform: { type: 'tone', offset_Hz: 0 },
        },
      },
    ],
    routes: [
      {
        emitter_id: 'uav-1',
        waypoints: [
          { position: { lon: 116.41, lat: 39.995, alt_m: 100 }, speed_mps: 10 },
          { position: { lon: 116.42, lat: 40.005, alt_m: 120 }, speed_mps: 10 },
        ],
      },
    ],
  }
}

before(async () => {
  root = await makeRoot('scenarios')
  // 造一个观测区域：只要有 manifest.json，场景就能落在它下面。
  const aoiDir = join(root, 'data', 'scene', 'test-aoi')
  await fsp.mkdir(aoiDir, { recursive: true })
  const manifest = JSON.stringify({ aoi: { id: 'test-aoi' } }, null, 2) + '\n'
  await fsp.writeFile(join(aoiDir, 'manifest.json'), manifest, 'utf8')
  // 场景要声明观测区域清单的真哈希：引擎会核对，占位符一律拒（铁律 15）。
  aoiSha = createHash('sha256').update(Buffer.from(manifest, 'utf8')).digest('hex')

  index = new ScenarioIndex(root)
  const engine = new Engine({ bin: defaultEngineBinary(REPO_ROOT), cwd: root })
  engineOk = existsSync(defaultEngineBinary(REPO_ROOT))
  srv = createServer((req, res) => {
    if (!handleScenarioRoutes({ root, index, engine }, req, res, new URL(req.url ?? '/', 'http://x').pathname)) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((r) => srv.close(() => r()))
  await rmrf(root)
})

test('清单：没有场景时是空数组，不是 404', async () => {
  const r = await fetch(`${base}/api/v1/scenarios`)
  assert.equal(r.status, 200)
  assert.deepEqual((await r.json()).scenarios, [])
})

test('非法场景标识一律 400，不去碰盘', async () => {
  for (const bad of ['UPPER', 'has space', 'a'.repeat(65)]) {
    const r = await fetch(`${base}/api/v1/scenarios/${encodeURIComponent(bad)}`)
    assert.equal(r.status, 400, bad)
  }
})

test('读一个不存在的场景是 404', async () => {
  const r = await fetch(`${base}/api/v1/scenarios/nope`)
  assert.equal(r.status, 404)
})

test('写入时路径标识与文件里的标识必须一致', async () => {
  const body = JSON.stringify(demoScenario('unit-01'))
  const r = await fetch(`${base}/api/v1/scenarios/other-id`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body,
  })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'scenario_id_mismatch')
})

test('写入时观测区域必须存在', async () => {
  const doc = demoScenario('unit-02') as Record<string, unknown>
  ;(doc.aoi as Record<string, unknown>).id = 'no-such-aoi'
  const r = await fetch(`${base}/api/v1/scenarios/unit-02`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc),
  })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'unknown_aoi')
})

test('不是合法 JSON 即 400', async () => {
  const r = await fetch(`${base}/api/v1/scenarios/unit-03`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{',
  })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'json_parse')
})

test('写入→读回→哈希：回传的是落盘字节的哈希，读回的字节逐字节相同', async (t) => {
  if (!engineOk) return t.skip('缺 engine/build/cuav_run，跳过需要真引擎的用例')
  const body = JSON.stringify(demoScenario('unit-04'), null, 2)
  const put = await fetch(`${base}/api/v1/scenarios/unit-04`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body,
  })
  const putText = await put.text()
  assert.equal(put.status, 200, putText)
  const info = JSON.parse(putText)
  assert.equal(info.scenario_id, 'unit-04')
  assert.equal(info.aoi, 'test-aoi')

  const onDisk = await fsp.readFile(join(root, 'data', 'scene', 'test-aoi', 'scenarios', 'unit-04.scenario.json'))
  assert.equal(info.sha256, createHash('sha256').update(onDisk).digest('hex'))

  const get = await fetch(`${base}/api/v1/scenarios/unit-04`)
  assert.equal(get.status, 200)
  assert.equal(get.headers.get('x-cuav-sha256'), info.sha256)
  assert.equal(get.headers.get('x-cuav-aoi'), 'test-aoi')
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), onDisk)

  const list = await (await fetch(`${base}/api/v1/scenarios`)).json()
  assert.equal(list.scenarios.length, 1)
  assert.equal(list.scenarios[0].scenario_id, 'unit-04')
  assert.equal(list.scenarios[0].duration_s, 10)
})

test('引擎挡下语义错误：坏场景不落盘，临时文件也不留下', async (t) => {
  if (!engineOk) return t.skip('缺 engine/build/cuav_run，跳过需要真引擎的用例')
  const doc = demoScenario('unit-05') as Record<string, unknown>
  // 航线引用了不存在的辐射源：schema 过得去，跨引用校验过不去（只有引擎知道）。
  ;(doc.routes as Array<Record<string, unknown>>)[0].emitter_id = 'uav-9'
  const r = await fetch(`${base}/api/v1/scenarios/unit-05`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc),
  })
  assert.equal(r.status, 400)
  const j = await r.json()
  assert.equal(j.error, 'scenario_invalid')
  assert.equal(j.detail.code, 'scenario')
  const dir = join(root, 'data', 'scene', 'test-aoi', 'scenarios')
  const files = await fsp.readdir(dir)
  assert.ok(!files.includes('unit-05.scenario.json'))
  assert.ok(!files.some((f) => f.endsWith('.tmp')), `临时文件没清干净：${files.join(', ')}`)
})

test('基准场景只读：PUT 被拒，报文说清怎么办（用户 2026-09-19 拍板）', async () => {
  // 先把一份基准场景直接落到盘上（绕开端点），再试着经端点改它
  const dir = join(root, 'data', 'scene', 'test-aoi', 'scenarios')
  await fsp.mkdir(dir, { recursive: true })
  const doc = demoScenario('golden-test')
  const bytes = JSON.stringify(doc, null, 2) + '\n'
  await fsp.writeFile(join(dir, 'golden-test.scenario.json'), bytes, 'utf8')

  const changed = { ...doc, name: '被改过的名字' }
  const r = await fetch(`${base}/api/v1/scenarios/golden-test`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changed),
  })
  assert.equal(r.status, 409)
  const b = (await r.json()) as { error: string; message: string }
  assert.equal(b.error, 'scenario_readonly')
  assert.match(b.message, /另存为/, '拒绝要说得出下一步怎么办')
  // 界面拦不住手写的请求，所以这条闸在服务端：盘上的字节必须一个没动
  assert.equal(await fsp.readFile(join(dir, 'golden-test.scenario.json'), 'utf8'), bytes)

  // 另存为一个不以 golden- 开头的标识：照常写得进去
  const saveAs = { ...doc, scenario_id: 'my-01' }
  const r2 = await fetch(`${base}/api/v1/scenarios/my-01`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(saveAs),
  })
  assert.equal(r2.status, 200)
})

test('清单里标出哪些是基准场景', async () => {
  const b = (await (await fetch(`${base}/api/v1/scenarios`)).json()) as { scenarios: Array<{ scenario_id: string; readonly: boolean }> }
  const byId = new Map(b.scenarios.map((x) => [x.scenario_id, x.readonly]))
  assert.equal(byId.get('golden-test'), true, 'golden- 开头的标为只读')
  assert.equal(byId.get('my-01'), false, '自己另存的可写')
})
