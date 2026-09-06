import { test } from 'node:test'
import assert from 'node:assert/strict'
import { viewStore } from './viewStore.js'

test('viewStore：patch 只在有变化时通知，reset 回初值', () => {
  let n = 0
  const off = viewStore.subscribe(() => { n++ })
  viewStore.patch({ mode: 'browse', W: 100 })
  assert.equal(n, 1)
  viewStore.patch({ mode: 'browse' })
  assert.equal(n, 1)
  assert.equal(viewStore.get().W, 100)
  viewStore.reset()
  assert.equal(n, 2)
  assert.equal(viewStore.get().mode, 'follow')
  off()
})
