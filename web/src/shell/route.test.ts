import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatHash, parseHash } from './route.js'

test('hash 解析', () => {
  for (const h of ['', '#', '#/', '#/scene', '#/nope']) assert.deepEqual(parseHash(h), { view: 'scene', resultsTab: 'signal', canvas: false }, h)
  assert.deepEqual(parseHash('#/diagram'), { view: 'diagram', resultsTab: 'signal', canvas: false })
  // 自由画布是框图页的子形态（C-7，D-051），不是第四个视图
  assert.deepEqual(parseHash('#/diagram/canvas'), { view: 'diagram', resultsTab: 'signal', canvas: true })
  assert.deepEqual(parseHash('#/diagram/bogus'), { view: 'diagram', resultsTab: 'signal', canvas: false })
  assert.deepEqual(parseHash('#/results'), { view: 'results', resultsTab: 'signal', canvas: false })
  assert.deepEqual(parseHash('#/results/detections'), { view: 'results', resultsTab: 'detections', canvas: false })
  assert.deepEqual(parseHash('#/results/tasks'), { view: 'results', resultsTab: 'tasks', canvas: false })
  assert.deepEqual(parseHash('#/results/bogus'), { view: 'results', resultsTab: 'signal', canvas: false })
  assert.deepEqual(parseHash('#/data'), { view: 'data', resultsTab: 'signal', canvas: false })
})

test('格式化与往返', () => {
  assert.equal(formatHash({ view: 'scene', resultsTab: 'signal', canvas: false }), '#/scene')
  assert.equal(formatHash({ view: 'results', resultsTab: 'signal', canvas: false }), '#/results')
  assert.equal(formatHash({ view: 'results', resultsTab: 'tasks', canvas: false }), '#/results/tasks')
  assert.equal(formatHash({ view: 'diagram', resultsTab: 'signal', canvas: true }), '#/diagram/canvas')
  for (const h of ['#/scene', '#/diagram', '#/diagram/canvas', '#/results', '#/results/detections', '#/data']) assert.equal(formatHash(parseHash(h)), h)
})
