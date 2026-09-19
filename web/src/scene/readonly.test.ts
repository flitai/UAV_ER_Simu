import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSaveAsId, isGoldenScenarioId } from './readonly.js'

test('基准场景按名字认（与服务端 isGoldenScenario 同一条）', () => {
  for (const id of ['golden-01', 'golden-02', 'golden-03', 'golden-whatever']) assert.equal(isGoldenScenarioId(id), true)
  for (const id of ['demo-01', 'my-01', '', null, undefined]) assert.equal(isGoldenScenarioId(id as string), false)
})

test('另存为的新标识：挡住空、非法字符、落回基准命名、重名', () => {
  assert.deepEqual(checkSaveAsId('my-01', []), { ok: true, id: 'my-01' })
  assert.deepEqual(checkSaveAsId('  my-01  ', []), { ok: true, id: 'my-01' }, '两头空白要去掉')
  assert.equal(checkSaveAsId('', []).ok, false)
  assert.equal(checkSaveAsId('My 01', []).ok, false)
  assert.equal(checkSaveAsId('金牌场景', []).ok, false)
  const g = checkSaveAsId('golden-04', [])
  assert.equal(g.ok, false)
  assert.match((g as { why: string }).why, /基准场景的命名/, '另存不能又存成一份基准')
  const dup = checkSaveAsId('my-01', ['my-01'])
  assert.equal(dup.ok, false)
  assert.match((dup as { why: string }).why, /已经有了/)
})
