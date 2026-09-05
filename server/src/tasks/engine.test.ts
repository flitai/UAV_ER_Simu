// 引擎封装：字节级切行、事件解析、目录缓存、只校验、起不来的错误分类（B-5）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Engine, EngineUnavailableError, parseEvent, spawnEngine, splitLines } from './engine.js'
import { fakeEngine, makeRoot, rmrf, slice1 } from './testkit.js'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

let root = ''
before(async () => {
  root = await makeRoot()
})
after(async () => rmrf(root))

test('splitLines：\\r\\n 行尾、跨 chunk 残片、多字节字符被切开都能复原', () => {
  let r = splitLines(Buffer.from('a\r\nb'), Buffer.alloc(0))
  assert.deepEqual(r.lines, ['a'])
  assert.equal(r.carry.toString(), 'b')
  r = splitLines(Buffer.from('\n'), r.carry)
  assert.deepEqual(r.lines, ['b'])
  assert.equal(r.carry.length, 0)

  const whole = Buffer.from('{"m":"北京亚运村"}\n', 'utf8')
  const cut = whole.indexOf(Buffer.from('京', 'utf8')) + 1        // 切在「京」的第一个字节后
  r = splitLines(whole.subarray(0, cut), Buffer.alloc(0))
  assert.deepEqual(r.lines, [])
  r = splitLines(whole.subarray(cut), r.carry)
  assert.deepEqual(r.lines, ['{"m":"北京亚运村"}'])

  r = splitLines(Buffer.from('x\n\ny\r\n'), Buffer.alloc(0))
  assert.deepEqual(r.lines, ['x', '', 'y'])
})

test('parseEvent：只接受五键信封', () => {
  assert.equal(parseEvent('not json'), null)
  assert.equal(parseEvent('{"seq":"1","type":"x","task_id":"t"}'), null)
  const e = parseEvent('{"seq":3,"task_id":"t","type":"log","t_s":1.5,"payload":{"level":"info"}}')
  assert.deepEqual(e, { seq: 3, task_id: 't', type: 'log', t_s: 1.5, payload: { level: 'info' } })
})

test('catalog：取一次并缓存，导出 internal 参数表与 generated_at', async () => {
  const eng = fakeEngine(root)
  const a = await eng.catalog()
  const b = await eng.catalog()
  assert.equal(a, b)
  assert.equal(a.engine_version, 'fake-0.0.1')
  assert.ok(a.types.has('FileReplaySource'))
  assert.deepEqual([...a.internal.get('FileReplaySource')!], ['manifest_path'])
  assert.deepEqual([...a.internal.get('ObservationTap')!], ['out_dir'])
  assert.equal(a.internal.has('ToneSource'), false)
  assert.match(String(a.catalog.generated_at), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(await eng.cachedCatalog(), a)
})

test('validate：合法框图一条 validate 事件且 task_id 显式；非法框图一条 error 四字段', async () => {
  const eng = fakeEngine(root)
  await fsp.writeFile(join(root, 'ok.json'), JSON.stringify(await slice1()))
  const ok = await eng.validate('ok.json', undefined, 'v-ok')
  assert.ok(ok.ok)
  if (ok.ok) {
    assert.equal(ok.event.type, 'validate')
    assert.equal(ok.event.task_id, 'v-ok')
  }
  const bad = await slice1()
  bad.name = '__bad__'
  await fsp.writeFile(join(root, 'bad.json'), JSON.stringify(bad))
  const r = await eng.validate('bad.json', undefined, 'v-bad')
  assert.equal(r.ok, false)
  if (!r.ok) assert.deepEqual(Object.keys(r.error).sort(), ['code', 'message', 'node_id', 'port'])
  if (!r.ok) assert.equal(r.error.code, 'param')
  if (!r.ok) assert.equal(r.error.node_id, 'tone')
})

test('二进制不存在：available 为 false，catalog 抛 EngineUnavailableError，validate 同', async () => {
  const eng = new Engine({ bin: join(root, 'no-such-cuav_run'), cwd: root })
  assert.equal(await eng.available(), false)
  await assert.rejects(eng.catalog(), EngineUnavailableError)
  await assert.rejects(eng.validate('x.json', undefined, 't'), EngineUnavailableError)
})

test('spawnEngine：crlf 模式下每行都能解析，被切开的多字节日志完整送达，stderr 只留尾部', async () => {
  const eng = fakeEngine(root)
  const d = await slice1('crlf')
  await fsp.writeFile(join(root, 'crlf.json'), JSON.stringify(d))
  const lines: string[] = []
  const ep = spawnEngine(eng.cfg, ['--run', 'crlf.json', '--out', 'out_crlf', '--task-id', 'c1'], { onLine: (l) => lines.push(l) })
  const exit = await ep.done
  assert.equal(exit.code, 0)
  const evs = lines.map(parseEvent)
  assert.ok(evs.every((e) => e !== null), '有行解析失败')
  assert.ok(lines.every((l) => !l.endsWith('\r')))
  const msgs = evs.map((e) => String(e!.payload.message ?? ''))
  assert.ok(msgs.includes('多字节：北京亚运村 20 × 20 km'), msgs.join(' | '))
  const seqs = evs.map((e) => e!.seq)
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1))
})
