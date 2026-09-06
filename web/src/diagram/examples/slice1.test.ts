import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SLICE1_DIAGRAM, SLICE1_TEXT } from './slice1.js'

test('切片 ① 示例与引擎示例文件逐字段相等', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const file = join(here, '..', '..', '..', '..', 'engine', 'tests', 'diagrams', 'slice1_tone_noise_psd.json')
  const engine = JSON.parse(readFileSync(file, 'utf8')) as unknown
  assert.deepEqual(JSON.parse(JSON.stringify(SLICE1_DIAGRAM)), engine)
  assert.deepEqual(JSON.parse(SLICE1_TEXT), engine)
})
