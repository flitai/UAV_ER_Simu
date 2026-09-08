// 切片 ② 示例框图与引擎夹具必须同文：两处分叉的话，界面里跑通的框图与回归测试跑的就不是一个东西。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLICE2_DIAGRAM } from './slice2.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

test('slice2 示例与 engine/tests/diagrams/slice2_scenario_link.json 逐字段相同', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'engine/tests/diagrams/slice2_scenario_link.json'), 'utf8'))
  assert.deepEqual(JSON.parse(JSON.stringify(SLICE2_DIAGRAM)), fixture)
})

test('slice2 示例声明的场景哈希与盘上的场景文件相符（改场景必须同步改框图）', async () => {
  const { createHash } = await import('node:crypto')
  const bytes = readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json'))
  const sha = createHash('sha256').update(bytes).digest('hex')
  assert.equal((SLICE2_DIAGRAM as { scenario_ref: { sha256: string } }).scenario_ref.sha256, sha)
})
