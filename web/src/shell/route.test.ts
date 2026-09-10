import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatHash, parseHash } from './route.js'

test('hash 解析', () => {
  for (const h of ['', '#', '#/', '#/scene', '#/nope']) assert.deepEqual(parseHash(h), { view: 'scene', resultsTab: 'signal' }, h)
  assert.deepEqual(parseHash('#/diagram'), { view: 'diagram', resultsTab: 'signal' })
  // 框图页只有一种形态（自由画布已由 D-060 删掉）：`#/diagram` 之后多出来的段一律忽略，
  // 于是收藏夹里的旧地址 `#/diagram/canvas` 仍然打得开框图页，不会掉到默认的场景页去
  assert.deepEqual(parseHash('#/diagram/canvas'), { view: 'diagram', resultsTab: 'signal' })
  assert.deepEqual(parseHash('#/diagram/bogus'), { view: 'diagram', resultsTab: 'signal' })
  assert.deepEqual(parseHash('#/results'), { view: 'results', resultsTab: 'signal' })
  assert.deepEqual(parseHash('#/results/detections'), { view: 'results', resultsTab: 'detections' })
  assert.deepEqual(parseHash('#/results/tasks'), { view: 'results', resultsTab: 'tasks' })
  assert.deepEqual(parseHash('#/results/bogus'), { view: 'results', resultsTab: 'signal' })
  assert.deepEqual(parseHash('#/data'), { view: 'data', resultsTab: 'signal' })
})

test('格式化与往返', () => {
  assert.equal(formatHash({ view: 'scene', resultsTab: 'signal' }), '#/scene')
  assert.equal(formatHash({ view: 'results', resultsTab: 'signal' }), '#/results')
  assert.equal(formatHash({ view: 'results', resultsTab: 'tasks' }), '#/results/tasks')
  assert.equal(formatHash({ view: 'diagram', resultsTab: 'signal' }), '#/diagram')
  for (const h of ['#/scene', '#/diagram', '#/results', '#/results/detections', '#/data']) assert.equal(formatHash(parseHash(h)), h)
  // 旧地址不往返（它已经不是一个合法去处），但解得开且落在框图页
  assert.equal(formatHash(parseHash('#/diagram/canvas')), '#/diagram')
})
