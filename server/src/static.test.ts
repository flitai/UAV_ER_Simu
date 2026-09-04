// 静态文件服务的集成测试：真起一个服务，发真实 HTTP 请求。
// 只用临时目录里的夹具文件，不依赖 data/ 下的大文件。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { resolveWithin, sendFile, mimeOf } from './static.js'

let dir = ''
let srv: Server
let base = ''
const BODY = Buffer.from('0123456789abcdefghij')   // 20 字节，便于手算区间

before(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'cuav-static-'))
  await fsp.writeFile(join(dir, 'sample.bin'), BODY)
  await fsp.mkdir(join(dir, 'sub'))
  await fsp.writeFile(join(dir, 'sub', 'a.pmtiles'), BODY)
  await fsp.writeFile(join(dir, 'outside-marker'), 'secret')
  srv = createServer((req, res) => {
    void (async () => {
      const abs = resolveWithin(join(dir, 'sub'), new URL(req.url!, 'http://x').pathname)
      if (!abs) { res.writeHead(403); return res.end('forbidden') }
      if (!(await sendFile(req, res, abs))) { res.writeHead(404); res.end('nf') }
    })()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})
after(async () => {
  await new Promise<void>((r) => srv.close(() => r()))
  await fsp.rm(dir, { recursive: true, force: true })
})

test('不带 Range 返回 200 与完整内容', async () => {
  const r = await fetch(`${base}/a.pmtiles`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('accept-ranges'), 'bytes')
  assert.equal(r.headers.get('content-length'), '20')
  assert.equal(await r.text(), BODY.toString())
})

test('闭区间返回 206 与 Content-Range', async () => {
  const r = await fetch(`${base}/a.pmtiles`, { headers: { range: 'bytes=0-3' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), 'bytes 0-3/20')
  assert.equal(r.headers.get('content-length'), '4')
  assert.equal(await r.text(), '0123')
})

test('开区间与后缀区间', async () => {
  const a = await fetch(`${base}/a.pmtiles`, { headers: { range: 'bytes=16-' } })
  assert.equal(a.status, 206)
  assert.equal(await a.text(), 'ghij')
  const b = await fetch(`${base}/a.pmtiles`, { headers: { range: 'bytes=-4' } })
  assert.equal(b.status, 206)
  assert.equal(b.headers.get('content-range'), 'bytes 16-19/20')
  assert.equal(await b.text(), 'ghij')
})

test('越界返回 416', async () => {
  const r = await fetch(`${base}/a.pmtiles`, { headers: { range: 'bytes=100-200' } })
  assert.equal(r.status, 416)
  assert.equal(r.headers.get('content-range'), 'bytes */20')
})

test('HEAD 只回头不回体', async () => {
  const r = await fetch(`${base}/a.pmtiles`, { method: 'HEAD' })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-length'), '20')
  assert.equal((await r.text()).length, 0)
})

test('HEAD 带 Range 也回 206 与正确长度', async () => {
  const r = await fetch(`${base}/a.pmtiles`, { method: 'HEAD', headers: { range: 'bytes=0-3' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), 'bytes 0-3/20')
})

test('不存在的文件返回 404', async () => {
  const r = await fetch(`${base}/nope.png`)
  assert.equal(r.status, 404)
})

test('路径穿越被拒', async () => {
  for (const p of ['/../outside-marker', '/%2e%2e/outside-marker', '/sub/../../outside-marker']) {
    const r = await fetch(`${base}${p}`)
    assert.ok(r.status === 403 || r.status === 404, `${p} 返回了 ${r.status}`)
    const body = await r.text()
    assert.ok(!body.includes('secret'), `${p} 漏出了根目录之外的内容`)
  }
})

test('resolveWithin 的安全契约：要么 null，要么落在根内', () => {
  // 断言的是性质而不是具体返回值：绝对路径里的 .. 被折掉留在根内，相对逃逸返回 null，
  // 两种都安全。写死具体值会把实现细节当成契约。
  const root = '/a/b'
  const hostile = ['/../etc/passwd', '/x/../../y', '/sub/../../outside', '../escape',
                   '/%00', '/%2e%2e/%2e%2e/etc', '/....//....//etc', '/a/./../../../x']
  for (const p of hostile) {
    const got = resolveWithin(root, p)
    assert.ok(got === null || got === root || got.startsWith(root + '/'),
      `${p} 逃出了根目录：${got}`)
  }
  assert.equal(resolveWithin(root, '/ok.txt'), '/a/b/ok.txt')
  assert.equal(resolveWithin(root, '/sub/x.png'), '/a/b/sub/x.png')
})

test('MIME 覆盖本项目实际用到的类型', () => {
  assert.equal(mimeOf('x.pmtiles'), 'application/octet-stream')
  assert.equal(mimeOf('x.geojson'), 'application/geo+json')
  assert.equal(mimeOf('x.png'), 'image/png')
  assert.equal(mimeOf('x.unknown'), 'application/octet-stream')
})

// ---------------------------------------------------------------------------
// 路由规则的测试：起真正的应用服务，验证回退边界
// ---------------------------------------------------------------------------
import { server as appServer } from './index.js'

let appBase = ''
before(async () => {
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r))
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`
})
after(async () => { await new Promise<void>((r) => appServer.close(() => r())) })

test('健康检查', async () => {
  const r = await fetch(`${appBase}/api/v1/health`)
  assert.equal(r.status, 200)
  assert.equal((await r.json()).status, 'ok')
})

test('原始 IQ 目录不暴露，且必须是 404 而不是回退首页（铁律 7）', async () => {
  const r = await fetch(`${appBase}/data/iq/measured/x.iq`)
  assert.equal(r.status, 404)
  assert.match(r.headers.get('content-type') ?? '', /application\/json/)
})

test('data 下的未知路径 404，不回退单页应用', async () => {
  const r = await fetch(`${appBase}/data/nope/x.png`)
  assert.equal(r.status, 404)
  assert.match(r.headers.get('content-type') ?? '', /application\/json/)
})

test('api 下的未知路径 404 JSON', async () => {
  const r = await fetch(`${appBase}/api/v1/nope`)
  assert.equal(r.status, 404)
  assert.match(r.headers.get('content-type') ?? '', /application\/json/)
})

test('缺失的静态资源 404，不回退首页', async () => {
  const r = await fetch(`${appBase}/assets/missing-abc.js`)
  assert.equal(r.status, 404)
})

test('无扩展名的应用路由回退首页', async () => {
  const r = await fetch(`${appBase}/scene/beijing`)
  assert.ok(r.status === 200 || r.status === 404) // dist 存在时 200，未构建时 404
  if (r.status === 200) assert.match(r.headers.get('content-type') ?? '', /text\/html/)
})

test('POST 等方法返回 405', async () => {
  const r = await fetch(`${appBase}/api/v1/health`, { method: 'POST' })
  assert.equal(r.status, 405)
  assert.equal(r.headers.get('allow'), 'GET, HEAD')
})
