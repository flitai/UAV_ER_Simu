// data_id 解析、旁挂与整行脱敏（B-5，D-037 / D-040）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DataIndex, buildSidecar, makeRedactor, resolveDataIds } from './resolve.js'
import { FX_IDS, makeDataFixture, makeRoot, rmrf } from './testkit.js'

let root = ''
let index: DataIndex
before(async () => {
  root = await makeRoot()
  await makeDataFixture(root)
  index = new DataIndex(root)
  await index.load()
})
after(async () => rmrf(root))

test('索引扫描：相对清单路径按 <索引目录>/<data_id>.manifest.json，与引擎 IndexDataResolver 同规则', () => {
  assert.equal(index.size, 3)
  assert.equal(index.get(FX_IDS.ok)?.manifestRel, `data/iq/measured/fx/${FX_IDS.ok}.manifest.json`)
  assert.equal(index.get('nope'), undefined)
  assert.equal(index.isHoldout(FX_IDS.holdout), true)
  assert.equal(index.isHoldout(FX_IDS.ok), false)
})

test('解析：未知 id 与「索引有、盘上无」都算缺失并给原因；验收集 id 单独列出；重复 id 只算一次', async () => {
  const r = await resolveDataIds(index, root, [FX_IDS.ok, FX_IDS.ok, FX_IDS.holdout, FX_IDS.noFile, 'nope'])
  assert.deepEqual(Object.keys(r.data), [FX_IDS.ok, FX_IDS.holdout])
  assert.deepEqual(r.holdout, [FX_IDS.holdout])
  assert.equal(r.missing.length, 2)
  assert.match(r.missing[0].reason, /不在盘上/)
  assert.match(r.missing[1].reason, /不在任何数据索引/)
})

test('旁挂：cuav-resolved/1 三键', () => {
  const s = buildSidecar({ a: 'data/iq/measured/fx/a.manifest.json' }, 'ff'.repeat(32))
  assert.deepEqual(Object.keys(s), ['schema_version', 'diagram_sha256', 'data'])
  assert.equal(s.schema_version, 'cuav-resolved/1')
})

test('脱敏：剥仓库根前缀（含空格、含 JSON 转义的 Windows 形式），清单路径换回 data_id，reasons[] 里的也换', () => {
  const rel = `data/iq/measured/fx/${FX_IDS.ok}.manifest.json`
  const r1 = makeRedactor('/srv/x y/repo', { [FX_IDS.ok]: rel })
  assert.equal(r1(`打开清单 /srv/x y/repo/${rel}`), `打开清单 ${FX_IDS.ok}`)
  assert.equal(r1('已装载 /srv/x y/repo/data/runs/t1/diagram.json'), '已装载 data/runs/t1/diagram.json')
  const line = JSON.stringify({ type: 'task.state', payload: { reasons: [`清单 ${rel} 来自论文`], nodes: [{ notes: [`/srv/x y/repo/${rel}`] }] } })
  const out = JSON.parse(r1(line)) as { payload: { reasons: string[]; nodes: Array<{ notes: string[] }> } }
  assert.equal(out.payload.reasons[0], `清单 ${FX_IDS.ok} 来自论文`)
  assert.equal(out.payload.nodes[0].notes[0], FX_IDS.ok)

  const r2 = makeRedactor('C:\\Work\\演示\\repo', {})
  const winLine = JSON.stringify({ message: 'C:\\Work\\演示\\repo\\data\\runs\\t1\\events.jsonl 打不开' })
  const got = JSON.parse(r2(winLine)) as { message: string }
  assert.equal(got.message, 'data\\runs\\t1\\events.jsonl 打不开')
  assert.equal(r2('C:/Work/演示/repo/data/x'), 'data/x')
  assert.equal(r1('没有路径的普通文字'), '没有路径的普通文字')
})
