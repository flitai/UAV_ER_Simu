// 这份单测是把 enumLabels.ts 钉在组件目录上的那道闸：目录里每个会显示给用户的枚举取值
// 都必须有中文名，新组件上目录时漏一个当场红（与 paramLabels.test.ts 同一套办法）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Catalog, ParamSpec } from '../api/catalog.js'
import { ENUM_LABELS, KEEP_AS_IS, boolLabel, enumLabel, valueLabel } from './enumLabels.js'
import { fieldsFor } from '../scene/editor/deviceFields.js'
import { displayWidth } from './paramLabels.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog

test('目录里每个可见枚举取值都有中文名（登记为不翻译的除外）', () => {
  const missing: string[] = []
  for (const c of cat.components) {
    for (const p of c.params as ParamSpec[]) {
      if (p.internal || !p.enum || KEEP_AS_IS.has(p.name)) continue
      for (const e of p.enum) if (!(`${p.name}.${e}` in ENUM_LABELS)) missing.push(`${c.type}.${p.name}=${e}`)
    }
  }
  assert.deepEqual(missing, [], '新枚举上目录时在 enumLabels.ts 补一行')
})

test('表里不留目录与场景字段都已经没有的条目（改了枚举要跟着删）', () => {
  const live = new Set<string>()
  for (const c of cat.components) {
    for (const p of c.params as ParamSpec[]) {
      if (!p.enum) continue
      for (const e of p.enum) live.add(`${p.name}.${e}`)
    }
  }
  // 场景里的设备字段（deviceFields.ts）也有枚举，它们不在组件目录里
  for (const f of [...fieldsFor('emitter', {}), ...fieldsFor('site', {})]) {
    if (!f.options) continue
    const name = f.rel.split('.').pop() ?? ''
    for (const o of f.options) live.add(`${name}.${o}`)
  }
  const stale = Object.keys(ENUM_LABELS).filter((k) => !live.has(k))
  assert.deepEqual(stale, [], '目录里已经没有这些取值了')
})

test('中文名不超过 8 个汉字宽：卡片摘要一行放得下', () => {
  for (const [k, v] of Object.entries(ENUM_LABELS)) assert.ok(displayWidth(v) <= 16, `${k} 的名字太长：${v}`)
})

test('没登记的取值退回原始标识，不显示成空或 undefined', () => {
  assert.equal(enumLabel('pattern', 'omni'), '全向')
  assert.equal(enumLabel('pattern', 'no_such_value'), 'no_such_value')
  assert.equal(enumLabel('no_such_param', 'x'), 'x')
})

test('场景设备字段的枚举也有中文名（框图页与场景页共用那套下拉）', () => {
  const missing: string[] = []
  for (const f of [...fieldsFor('emitter', {}), ...fieldsFor('site', {})]) {
    if (!f.options) continue
    const name = f.rel.split('.').pop() ?? ''
    for (const o of f.options) if (!(`${name}.${o}` in ENUM_LABELS)) missing.push(`${f.key}=${o}`)
  }
  assert.deepEqual(missing, [], '在 enumLabels.ts 补一行')
})

test('布尔量写「是 / 否」，不写 true / false', () => {
  assert.equal(boolLabel(true), '是')
  assert.equal(boolLabel(false), '否')
  assert.equal(valueLabel(undefined, true), '是')
  assert.equal(valueLabel(undefined, false), '否')
})

test('非枚举参数原样显示，不去查表', () => {
  // 取值恰好和某个枚举名撞上也不该被翻译——它不是枚举参数
  const ps = { name: 'pattern', type: 'string' } as unknown as ParamSpec
  assert.equal(valueLabel(ps, 'omni'), 'omni')
  assert.equal(valueLabel(undefined, 'omni'), 'omni')
  const enumPs = { name: 'pattern', type: 'string', enum: ['omni', 'directional'] } as unknown as ParamSpec
  assert.equal(valueLabel(enumPs, 'omni'), '全向')
})
