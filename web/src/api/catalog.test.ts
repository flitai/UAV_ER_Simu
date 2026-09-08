// 连线判据的单测，对拍**真目录**（tests/golden/component-catalog.json，由 cuav_run --catalog 生成）。
// 用桩数据测这层没意义：这层的全部价值就是「不复制规则、只查目录」，必须拿引擎的真输出验。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isCatalog, canConnect, connectionHint, byCategory, findComponent, CATEGORIES, CATEGORY_COLOR, PORT_SHAPE, type Catalog } from './catalog.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog

test('黄金目录能被识别为 Catalog', () => {
  assert.equal(isCatalog(cat), true)
  assert.equal(cat.schema_version, 'cuav-catalog/1')
})

test('端口兼容矩阵是 7×7 全枚举，只有对角线为真', () => {
  assert.equal(cat.port_types.length, 7)
  assert.equal(cat.port_compat.length, 49, '49 条全枚举')
  let ok = 0
  for (const t of cat.port_types) for (const u of cat.port_types) {
    const v = canConnect(cat, t, u)
    assert.equal(v.ok, t === u, `${t} → ${u}`)
    if (v.ok) ok++
    else assert.ok(v.reason.length > 0, `${t} → ${u} 必须带理由`)
  }
  assert.equal(ok, 7)
})

test('IQ 流与参数流不得直连，理由取目录原文并点名 D-013', () => {
  const v = canConnect(cat, 'IQStream', 'SceneParamFrame')
  assert.equal(v.ok, false)
  assert.match(v.reason, /不得直连/)
  assert.match(v.reason, /D-013/)
})

test('可操作建议只在显示层补充，不改变判据', () => {
  assert.match(connectionHint('IQStream', 'SceneParamFrame'), /施加类组件/)
  assert.match(connectionHint('SceneParamFrame', 'IQStream'), /不能直接接进/)
  assert.equal(connectionHint('IQStream', 'IQStream'), '', '合法连接不给建议')
})

test('六类分组齐全且都不为空（C-2 补上天线与接收机后，04 §8.1 的六类首次全有组件）', () => {
  const g = byCategory(cat)
  assert.deepEqual(g.map((x) => x.key), CATEGORIES.map((c) => c.key))
  const empty = g.filter((x) => x.items.length === 0).map((x) => x.key)
  assert.deepEqual(empty, [], '六个分组都应有组件')
  assert.equal(g.reduce((n, x) => n + x.items.length, 0), cat.components.length)
  // 天线一件、接收机两件（AntennaGain / ReceiverFrontEnd / AdcQuantizer，D-051）
  assert.deepEqual(g.find((x) => x.key === 'antenna')!.items.map((c) => c.type), ['AntennaGain'])
  assert.deepEqual(g.find((x) => x.key === 'receiver')!.items.map((c) => c.type).sort(),
    ['AdcQuantizer', 'ReceiverFrontEnd'])
})

test('可选输入口在目录里带 optional 标记，且只有它带（D-051）', () => {
  const withOptional: string[] = []
  for (const c of cat.components) {
    for (const p of c.ports.in ?? []) {
      if (p.optional) withOptional.push(`${c.type}.${p.name}`)
    }
  }
  assert.deepEqual(withOptional, ['AntennaGain.scene'])
})

test('每个组件的类别都在六类内，且都有类别色', () => {
  for (const c of cat.components) {
    assert.ok(CATEGORIES.some((k) => k.key === c.category), `${c.type} 的类别 ${c.category}`)
    assert.ok(CATEGORY_COLOR[c.category], `${c.category} 应有色值`)
  }
})

test('每个端口类型都有把手形状', () => {
  for (const t of cat.port_types) assert.ok(PORT_SHAPE[t], `${t} 应有形状`)
})

test('目录里每条边都能按类型查到判据（画布不会遇到查不到的组合）', () => {
  for (const c of cat.components) {
    for (const p of [...(c.ports.in ?? []), ...(c.ports.out ?? [])]) {
      assert.ok(cat.port_types.includes(p.type), `${c.type}.${p.name} 的类型 ${p.type} 应在 port_types 内`)
    }
  }
})

test('互斥参数成对出现，界面据此并排显示（09 §6.6 第 2 条）', () => {
  const pairs: string[] = []
  for (const c of cat.components) {
    for (const p of c.params) {
      if (!p.excludes?.length) continue
      for (const other of p.excludes) {
        assert.ok(c.params.some((q) => q.name === other), `${c.type}.${p.name} 互斥的 ${other} 应存在`)
        pairs.push(`${c.type}.${p.name}⊥${other}`)
      }
    }
  }
  assert.deepEqual(pairs.sort(), ['NoiseSource.power_dBm⊥power', 'ToneSource.level_dBm⊥amplitude'])
})

test('内部参数在目录里有标记，画布据此隐藏（D-037）', () => {
  const internal: string[] = []
  for (const c of cat.components) for (const p of c.params) if (p.internal) internal.push(`${c.type}.${p.name}`)
  // 2 处路径类（manifest_path、out_dir）+ 三个场景绑定组件各 3 处（scenario_path、scenario_id、实体标识）= 11
  assert.equal(internal.length, 11, '全库 11 处内部参数')
  assert.ok(internal.includes('FileReplaySource.manifest_path'))
  assert.ok(internal.includes('ObservationTap.out_dir'))
  for (const t of ['ScenarioSource', 'SceneBoundChannel', 'SceneEmitterSource']) {
    assert.ok(internal.includes(`${t}.scenario_path`), `${t} 的场景路径应是内部参数`)
    assert.ok(internal.includes(`${t}.scenario_id`), `${t} 的场景标识应是内部参数`)
  }
})

test('ScenarioSource 是动态端口的唯一使用者，未 configure 时没有具体输出口', () => {
  const s = findComponent(cat, 'ScenarioSource')
  assert.ok(s)
  assert.ok(s!.dynamic_ports, '应声明 dynamic_ports')
  assert.equal(s!.dynamic_ports!.type, 'SceneParamFrame')
  assert.match(s!.dynamic_ports!.pattern, /link:/)
  assert.equal((s!.ports.out ?? []).length, 0, '未 configure 时输出口为空')
  const others = cat.components.filter((c) => c.type !== 'ScenarioSource' && c.dynamic_ports)
  assert.equal(others.length, 0)
})

test('可绑定场景的组件恰是三个；回放源不可绑定（06 防线二、三）', () => {
  const b = cat.components.filter((c) => c.scene_bindable).map((c) => c.type).sort()
  assert.deepEqual(b, ['ScenarioSource', 'SceneBoundChannel', 'SceneEmitterSource'])
  assert.equal(findComponent(cat, 'FileReplaySource')!.scene_bindable ?? false, false)
})
