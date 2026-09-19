// 实测数据清单端点：列表（D-056）与单条详情（U-4，D-075）。
// 只出摘要、不出路径、如实报告有没有列全。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { handleDatasetRoutes } from './datasets.js'
import { DataIndex } from './tasks/resolve.js'
import { makeRoot, rmrf, makeDataFixture, FX_IDS } from './tasks/testkit.js'

let root = ''
let srv: Server
let base = ''

before(async () => {
  root = await makeRoot('cuav-datasets-')
  await makeDataFixture(root)
  const index = new DataIndex(root)
  srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void handleDatasetRoutes({ index, root }, req, res, url).then((hit) => {
      if (!hit) { res.writeHead(404); res.end() }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((r) => srv.close(() => r()))
  await rmrf(root)
})

test('列清单：出摘要与验收集标记，data_id 是索引里的全部三条', async () => {
  const r = await fetch(`${base}/api/v1/datasets`)
  assert.equal(r.status, 200)
  const b = await r.json()
  assert.equal(b.schema_version, 'cuav-datasets/1')
  assert.equal(b.total, 3)
  const byId = new Map(b.items.map((x: { data_id: string }) => [x.data_id, x]))
  const ok = byId.get(FX_IDS.ok) as Record<string, unknown>
  assert.equal(ok.class_name, '甲型机')
  assert.equal(ok.visibility, 'LOS')
  assert.equal(ok.distance_text, '10 m')       // 精确距离
  assert.equal(ok.quality, 'degraded')
  assert.equal(ok.holdout, false)
  const hold = byId.get(FX_IDS.holdout) as Record<string, unknown>
  assert.equal(hold.holdout, true, '验收集要标出来（D-038）')
  assert.equal(hold.distance_text, '20–40 m', '只有区间时给区间，不编一个精确值')
  // 索引里有、盘上没有清单的那条照样列出来：能不能跑由提交时的解析说了算
  assert.ok(byId.has(FX_IDS.noFile))
})

test('列清单：不出任何服务器路径（浏览器永不见路径，D-037）', async () => {
  const text = await (await fetch(`${base}/api/v1/datasets`)).text()
  assert.ok(!text.includes('manifestRel'), '不得带清单路径字段')
  assert.ok(!text.includes(root), `不得带仓库根：${root}`)
  assert.ok(!text.includes('data/iq/'), '不得带任何相对路径')
})

test('列清单：筛选按机型与标识都能命中，matched 如实报数', async () => {
  const byClass = await (await fetch(`${base}/api/v1/datasets?q=${encodeURIComponent('乙型')}`)).json()
  assert.equal(byClass.matched, 1)
  assert.equal(byClass.items[0].data_id, FX_IDS.holdout)

  const byId = await (await fetch(`${base}/api/v1/datasets?q=fx_run`)).json()
  assert.equal(byId.matched, 1)
  assert.equal(byId.items[0].data_id, FX_IDS.ok)

  const none = await (await fetch(`${base}/api/v1/datasets?q=没有这种机型`)).json()
  assert.equal(none.matched, 0)
  assert.deepEqual(none.items, [])
  assert.equal(none.total, 3, '总数不受筛选影响')
})

test('列清单：data_id 精确查一条——框图里填着的那条未必在抽样里', async () => {
  const b = await (await fetch(`${base}/api/v1/datasets?data_id=${FX_IDS.holdout}`)).json()
  assert.equal(b.matched, 1)
  assert.equal(b.items[0].data_id, FX_IDS.holdout)

  const miss = await (await fetch(`${base}/api/v1/datasets?data_id=不存在的标识`)).json()
  assert.equal(miss.matched, 0)
  assert.deepEqual(miss.items, [])
})

test('列清单：只认 GET', async () => {
  const r = await fetch(`${base}/api/v1/datasets`, { method: 'POST' })
  assert.equal(r.status, 405)
})

/* ─── 单条详情（U-4，D-075）───────────────────────────────────────────────── */

test('详情 manifest 档：清单在盘上时出采样率、片长、八项质检与溯源', async () => {
  const r = await fetch(`${base}/api/v1/datasets/${FX_IDS.ok}`)
  assert.equal(r.status, 200)
  const b = (await r.json()) as Record<string, any>
  assert.equal(b.schema_version, 'cuav-dataset/1')
  assert.equal(b.data_id, FX_IDS.ok)
  assert.equal(b.detail_level, 'manifest')
  assert.equal(b.holdout, false)
  // index 档的内容在两档里都有
  assert.equal(b.index.dataset, 'FX-SET')
  assert.equal(b.index.channel_id, 'CH0')
  assert.equal(b.index.quality, 'degraded')
  assert.equal(b.index.truth.class_name, '甲型机')
  assert.equal(b.index.truth.distance_m, 10)
  // 标定常数：数值、来源、状态三样，note 与 table 不出（D-047、铁律 17）
  assert.equal(b.calibration.full_scale_dBm, -1.6)
  assert.equal(b.calibration.source, 'model')
  assert.equal(b.calibration.note, undefined)
  assert.equal(b.calibration.table, undefined)
  // 片长是算出来的：3000 / 1e6
  assert.equal(b.manifest.sampling.sample_rate_Hz, 1e6)
  assert.equal(b.manifest.sampling.duration_s, 0.003)
  assert.equal(b.manifest.quality.status, 'degraded')
  assert.deepEqual(b.manifest.quality.reasons, ['测试夹具'])
  assert.equal(b.manifest.model_trace.model_level, 'E4')
  assert.deepEqual(b.manifest.origin, { kind: 'measured', dataset: 'FX-SET' }, 'origin 只放这两键')
  assert.deepEqual(b.manifest.segments, { count: 1, sample_count: 3000 }, '段只出个数与样点数，不出文件名')
  assert.equal(b.manifest.survey.peak_dBFS, -19.4)
})

test('详情 index 档：清单不在盘上时只到索引这一层，缺的键整个不出现', async () => {
  const r = await fetch(`${base}/api/v1/datasets/${FX_IDS.noFile}`)
  assert.equal(r.status, 200)
  const b = (await r.json()) as Record<string, any>
  assert.equal(b.detail_level, 'index', '批索引入 git，清单不入——这一档是干净克隆上的常态')
  assert.equal(b.manifest, undefined)
  // 批索引里没有采样率，所以片长在这一档算不出来：键缺席，不拿别的数顶替（铁律 15）
  assert.equal(b.index.sample_count, undefined)
  assert.equal(b.calibration.full_scale_dBm, -1.6, '标定常数是批级的，index 档也给得出')
})

test('详情：验收集标记随条走', async () => {
  const b = (await (await fetch(`${base}/api/v1/datasets/${FX_IDS.holdout}`)).json()) as Record<string, any>
  assert.equal(b.holdout, true)
  assert.equal(b.index.truth.class_name, '乙型机')
})

test('详情：不出任何路径、外部来源与溯源以外的东西（铁律 17、D-037、D-039）', async () => {
  // 夹具里**故意**塞了这些（testkit.makeDataFixture），所以这条断言不是空过的
  const raw = await (await fetch(`${base}/api/v1/datasets/${FX_IDS.ok}`)).text()
  for (const bad of ['manifestRel', root, 'data/iq/', '.mat', 'scripts/', 'tools/',
    'original_name', 'permission', 'source_file', 'source_sha256', 'conversion', 'doi']) {
    assert.ok(!raw.includes(bad), `详情响应里不该出现 ${bad}：${raw.slice(0, 200)}`)
  }
})

test('详情：标识不合法 400、不存在 404、非 GET 405', async () => {
  const bad = await fetch(`${base}/api/v1/datasets/${encodeURIComponent(' 带空格')}`)
  assert.equal(bad.status, 400)
  assert.equal(((await bad.json()) as { error: string }).error, 'bad_data_id')
  const miss = await fetch(`${base}/api/v1/datasets/fx_not_here`)
  assert.equal(miss.status, 404)
  assert.equal(((await miss.json()) as { error: string }).error, 'not_found')
  const post = await fetch(`${base}/api/v1/datasets/${FX_IDS.ok}`, { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
})

test('列清单：分面在全量上算、过滤三件、limit 与「点名机型就不再抽样」', async () => {
  const b = (await (await fetch(`${base}/api/v1/datasets`)).json()) as Record<string, any>
  assert.deepEqual(b.facets.batch, { fx: 3 })
  assert.deepEqual(b.facets.holdout, { true: 1, false: 2 })
  assert.deepEqual(b.facets.class_name, { 甲型机: 1, 乙型机: 1 })
  assert.deepEqual(b.facets.visibility, { LOS: 1 })

  const byBatch = (await (await fetch(`${base}/api/v1/datasets?batch=fx`)).json()) as Record<string, any>
  assert.equal(byBatch.matched, 3)
  const noBatch = (await (await fetch(`${base}/api/v1/datasets?batch=没有这批`)).json()) as Record<string, any>
  assert.equal(noBatch.matched, 0)
  assert.equal(noBatch.total, 3, '总数与分面不随筛选变')

  const byClass = (await (await fetch(`${base}/api/v1/datasets?class=${encodeURIComponent('甲型机')}`)).json()) as Record<string, any>
  assert.equal(byClass.matched, 1)
  assert.equal(byClass.items[0].data_id, FX_IDS.ok)

  const hold = (await (await fetch(`${base}/api/v1/datasets?holdout=true`)).json()) as Record<string, any>
  assert.equal(hold.matched, 1)
  assert.equal(hold.items[0].data_id, FX_IDS.holdout)
  const notHold = (await (await fetch(`${base}/api/v1/datasets?holdout=false`)).json()) as Record<string, any>
  assert.equal(notHold.matched, 2)

  const one = (await (await fetch(`${base}/api/v1/datasets?limit=1`)).json()) as Record<string, any>
  assert.equal(one.items.length, 1)
  assert.equal(one.truncated, true, '列不全就说列不全（D-056 ②）')
})
