// 实测数据清单端点（D-056）：只出摘要、不出路径、如实报告有没有列全。
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
    void handleDatasetRoutes({ index }, req, res, url).then((hit) => {
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
