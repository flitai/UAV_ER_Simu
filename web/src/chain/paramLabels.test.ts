import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Catalog, ParamSpec } from '../api/catalog.js'
import { PARAM_LABELS, paramLabel, paramTitle } from './paramLabels.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog

test('目录里每个可见参数都有中文短标签；标签不超过 8 个字', () => {
  const missing: string[] = []
  for (const c of cat.components) {
    for (const p of c.params as ParamSpec[]) {
      if (p.internal) continue
      if (!(p.name in PARAM_LABELS)) missing.push(`${c.type}.${p.name}`)
    }
  }
  assert.deepEqual(missing, [], '新组件上目录时在 paramLabels.ts 补一行')
  for (const [k, v] of Object.entries(PARAM_LABELS)) assert.ok(v.length <= 8, `${k} 的标签太长：${v}`)
})

test('没有短名的参数退回英文标识；悬停提示三行：标识、说明、范围', () => {
  assert.equal(paramLabel({ name: 'nf_dB' }), '噪声系数')
  assert.equal(paramLabel({ name: 'no_such_param' }), 'no_such_param')
  const ps = { name: 'nf_dB', type: 'number', unit: 'dB', description: '噪声系数', min: 0, max: 30 } as unknown as ParamSpec
  assert.equal(paramTitle(ps, '0 … 30'), 'nf_dB\n噪声系数\n范围 0 … 30')
  assert.equal(paramTitle({ ...ps, description: '' } as ParamSpec, ''), 'nf_dB')
})
