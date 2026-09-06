import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fnv1a32, idempotencyKey, sha256hex } from './hash.js'

test('键格式与确定性', async () => {
  const k = await idempotencyKey('{"a":1}', () => 123)
  assert.match(k, /^[0-9a-f]{64}-123$/)
  assert.equal(await sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(fnv1a32('abc'), fnv1a32('abc')); assert.notEqual(fnv1a32('abc'), fnv1a32('abd'))
})
