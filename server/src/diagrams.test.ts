// 框图读写端点（C-6，D-051）。判据：规范序列化逐字节、坏框图不落盘、语义交引擎。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { handleDiagramRoutes, DIAGRAMS_REL } from './diagrams.js'
import { Engine, defaultEngineBinary } from './tasks/engine.js'
import { DataIndex, ScenarioIndex } from './tasks/resolve.js'
import { REPO_ROOT, makeRoot, rmrf, slice1 } from './tasks/testkit.js'

const BIN = defaultEngineBinary(REPO_ROOT)
const skip = existsSync(BIN) ? false : `没有引擎二进制 ${BIN}，先 cmake --build engine/build`

interface Ctx {
  base: string
  root: string
  close: () => Promise<void>
}

async function serve(root: string): Promise<Ctx> {
  const engine = new Engine({ bin: BIN, cwd: root })
  const deps = {
    root,
    engine,
    dataIndex: new DataIndex(root),
    scenarioIndex: new ScenarioIndex(root),
  }
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (handleDiagramRoutes(deps, req, res, url.pathname)) return
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    root,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  }
}

test('框图落盘：PUT → GET 逐字节相同；不改内容再保存是空操作；清单带 template_ref 摘要', { skip }, async () => {
  const root = await makeRoot('cuav-diag-')
  const ctx = await serve(root)
  try {
    const doc = (await slice1()) as Record<string, unknown>
    doc.diagram_id = 'chain-demo'
    doc.template_ref = { template_id: 'chain-v1', mode: 'synthetic', version: 1 }

    // 空目录时清单是空数组，不是错误
    const empty = await fetch(`${ctx.base}/api/v1/diagrams`)
    assert.equal(empty.status, 200)
    assert.deepEqual(((await empty.json()) as { diagrams: unknown[] }).diagrams, [])

    const put = await fetch(`${ctx.base}/api/v1/diagrams/chain-demo`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    })
    const putText = await put.text()
    assert.equal(put.status, 200, putText)
    const putBody = JSON.parse(putText) as { sha256: string; bytes: number }

    // 盘上就是规范形式：JSON.stringify(doc, null, 2) 加末尾换行
    const onDisk = await fsp.readFile(join(root, DIAGRAMS_REL, 'chain-demo.diagram.json'), 'utf8')
    assert.equal(onDisk, JSON.stringify(doc, null, 2) + '\n')

    const get = await fetch(`${ctx.base}/api/v1/diagrams/chain-demo`)
    assert.equal(get.status, 200)
    assert.equal(get.headers.get('x-cuav-sha256'), putBody.sha256)
    const back = await get.text()
    assert.equal(back, onDisk, 'GET 回来的应与盘上逐字节相同')

    // 不改内容再保存：字节与哈希都不变
    const again = await fetch(`${ctx.base}/api/v1/diagrams/chain-demo`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: back,
    })
    assert.equal(again.status, 200)
    assert.equal(((await again.json()) as { sha256: string }).sha256, putBody.sha256)
    assert.equal(await fsp.readFile(join(root, DIAGRAMS_REL, 'chain-demo.diagram.json'), 'utf8'), onDisk)

    const list = (await (await fetch(`${ctx.base}/api/v1/diagrams`)).json()) as {
      diagrams: Array<Record<string, unknown>>
    }
    assert.equal(list.diagrams.length, 1)
    assert.equal(list.diagrams[0]!.diagram_id, 'chain-demo')
    assert.equal(list.diagrams[0]!.template_id, 'chain-v1')
    assert.equal(list.diagrams[0]!.mode, 'synthetic')
    assert.equal(list.diagrams[0]!.nodes, 4)
    assert.equal(list.diagrams[0]!.observation_points, 1)

    const del = await fetch(`${ctx.base}/api/v1/diagrams/chain-demo`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    assert.equal(existsSync(join(root, DIAGRAMS_REL, 'chain-demo.diagram.json')), false)
    assert.equal((await fetch(`${ctx.base}/api/v1/diagrams/chain-demo`, { method: 'DELETE' })).status, 404)
  } finally {
    await ctx.close()
    await rmrf(root)
  }
})

test('框图落盘：坏框图不覆盖好框图，临时件不留；错误码原样透传', { skip }, async () => {
  const root = await makeRoot('cuav-diag-bad-')
  const ctx = await serve(root)
  try {
    const good = (await slice1()) as Record<string, unknown>
    good.diagram_id = 'keep'
    const ok = await fetch(`${ctx.base}/api/v1/diagrams/keep`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good),
    })
    assert.equal(ok.status, 200)
    const before = await fsp.readFile(join(root, DIAGRAMS_REL, 'keep.diagram.json'), 'utf8')

    // 语义错误：引擎拒，服务端原样透传四元组
    const bad = (await slice1()) as Record<string, unknown>
    bad.diagram_id = 'keep'
    ;(bad.nodes as Array<Record<string, unknown>>)[0]!.type = 'NoSuchComponent'
    const r1 = await fetch(`${ctx.base}/api/v1/diagrams/keep`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
    })
    assert.equal(r1.status, 400)
    const e1 = (await r1.json()) as { error: string; detail: { code: string; node_id: string } }
    assert.equal(e1.error, 'diagram_invalid')
    assert.equal(e1.detail.code, 'unknown_type')
    assert.equal(e1.detail.node_id, 'tone')

    // template_ref 取值错误：引擎给 template
    const badTpl = (await slice1()) as Record<string, unknown>
    badTpl.diagram_id = 'keep'
    badTpl.template_ref = { template_id: 'chain-v1', mode: 'hybrid', version: 1 }
    const r2 = await fetch(`${ctx.base}/api/v1/diagrams/keep`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(badTpl),
    })
    assert.equal(r2.status, 400)
    assert.equal(((await r2.json()) as { detail: { code: string } }).detail.code, 'template')

    // 内部参数：服务端自己就拒（D-037），不劳引擎
    const internal = (await slice1()) as Record<string, unknown>
    internal.diagram_id = 'keep'
    ;(internal.nodes as Array<Record<string, unknown>>)[0] = {
      id: 'tone', type: 'FileReplaySource', params: { data_id: 'x', manifest_path: '/srv/x' },
    }
    const r3 = await fetch(`${ctx.base}/api/v1/diagrams/keep`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(internal),
    })
    assert.equal(r3.status, 400)
    assert.equal(((await r3.json()) as { detail: { code: string } }).detail.code, 'internal_param')

    // 标识不符：路径与文件里的 diagram_id 必须一致
    const mismatch = (await slice1()) as Record<string, unknown>
    mismatch.diagram_id = 'other'
    const r4 = await fetch(`${ctx.base}/api/v1/diagrams/keep`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mismatch),
    })
    assert.equal(r4.status, 400)
    assert.equal(((await r4.json()) as { error: string }).error, 'diagram_id_mismatch')

    // 非法 JSON
    const r5 = await fetch(`${ctx.base}/api/v1/diagrams/keep`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{ not json',
    })
    assert.equal(r5.status, 400)
    assert.equal(((await r5.json()) as { detail: { code: string } }).detail.code, 'json_parse')

    // 好框图一字未动，临时件一个不留
    assert.equal(await fsp.readFile(join(root, DIAGRAMS_REL, 'keep.diagram.json'), 'utf8'), before)
    const names = await fsp.readdir(join(root, DIAGRAMS_REL))
    assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), [])
    assert.deepEqual(names.filter((n) => n.endsWith('.resolved.json')), [])
  } finally {
    await ctx.close()
    await rmrf(root)
  }
})

test('框图落盘：标识与方法的边界', { skip }, async () => {
  const root = await makeRoot('cuav-diag-edge-')
  const ctx = await serve(root)
  try {
    assert.equal((await fetch(`${ctx.base}/api/v1/diagrams/Has%20Space`)).status, 400)
    assert.equal((await fetch(`${ctx.base}/api/v1/diagrams/nope`)).status, 404)
    assert.equal((await fetch(`${ctx.base}/api/v1/diagrams`, { method: 'POST' })).status, 405)
    const r = await fetch(`${ctx.base}/api/v1/diagrams/x`, { method: 'PATCH' })
    assert.equal(r.status, 405)
    assert.equal(r.headers.get('allow'), 'GET, HEAD, PUT, DELETE')
  } finally {
    await ctx.close()
    await rmrf(root)
  }
})
