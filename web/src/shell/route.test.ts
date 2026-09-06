import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatHash, parseHash } from './route.js'

test('hash 解析', () => {
  for (const h of ['', '#', '#/', '#/scene', '#/nope']) assert.deepEqual(parseHash(h), { view: 'scene', resultsTab: 'signal' }, h)
  assert.deepEqual(parseHash('#/diagram'), { view: 'diagram', resultsTab: 'signal' })
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
  for (const h of ['#/scene', '#/diagram', '#/results', '#/results/detections', '#/data']) assert.equal(formatHash(parseHash(h)), h)
})
