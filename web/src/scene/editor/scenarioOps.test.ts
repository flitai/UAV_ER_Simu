// 场景编辑操作的单测（G-4；D-053 的「布目标」）。
//
// 对着**真场景** demo-01 跑：产出的文档必须仍然是引擎认得的那一份，
// 用桩数据测这层没有意义——`addEmitter` 最容易出的错正是「漏了航线」这类跨引用问题。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { ScenarioDoc } from '../../state/types.js'
import { addEmitter, addSite, emitters, moveEmitter, posOf, removeEmitter, routeOf, setPath, sites, splitLinkId } from './scenarioOps.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
function demo(): ScenarioDoc {
  return JSON.parse(
    readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json'), 'utf8'),
  ) as ScenarioDoc
}

test('布目标：复制第一个源的发射参数，并建一条单航点航线（静止目标也要有航线）', () => {
  const doc = demo()
  const before = emitters(doc).length
  const r = addEmitter(doc, 116.41, 39.99)
  assert.equal(emitters(r.doc).length, before + 1)
  assert.notEqual(r.id, String(emitters(doc)[0]!.id), '新 id 不得与既有的撞')

  const added = emitters(r.doc).find((x) => x.id === r.id)!
  const first = emitters(doc)[0]!
  assert.deepEqual(added.emission, first.emission, '发射参数照抄模板，同频是多源混叠演示要的')
  assert.equal(posOf(added)!.lon, 116.41)

  const route = routeOf(r.doc, r.id)
  assert.ok(route, '必须建航线：没有航线的源在运行时取不到位置')
  assert.equal((route!.waypoints as unknown[]).length, 1)

  // 原文档不受影响（编辑操作是纯函数，撤销栈靠这一点）
  assert.equal(emitters(doc).length, before)
})

test('布目标：连放两个，id 递增且都带航线', () => {
  let doc = demo()
  const ids: string[] = []
  for (let i = 0; i < 2; i++) {
    const r = addEmitter(doc, 116.4 + i * 0.01, 39.99)
    doc = r.doc
    ids.push(r.id)
  }
  assert.equal(new Set(ids).size, 2)
  for (const id of ids) assert.ok(routeOf(doc, id))
})

test('删目标：连同航线与活动一起删，不留悬空引用', () => {
  const r = addEmitter(demo(), 116.41, 39.99)
  const doc = removeEmitter(r.doc, r.id)
  assert.equal(emitters(doc).find((x) => x.id === r.id), undefined)
  assert.equal(routeOf(doc, r.id), null)
  for (const a of (doc.activities ?? []) as Array<Record<string, unknown>>) {
    assert.notEqual(a.emitter_id, r.id)
  }
})

test('移动目标：位置与第一个航点同步改，两处不脱节', () => {
  const r = addEmitter(demo(), 116.41, 39.99)
  const doc = moveEmitter(r.doc, r.id, 116.45, 40.01)
  const em = emitters(doc).find((x) => x.id === r.id)!
  assert.equal(posOf(em)!.lon, 116.45)
  const wp = (routeOf(doc, r.id)!.waypoints as Array<Record<string, unknown>>)[0]!
  assert.equal((wp.position as Record<string, number>).lon, 116.45)
})

test('布站：新站沿用第一个站的接收机参数——多站要求各站同采样率同中心频率（D-053）', () => {
  const doc = demo()
  const r = addSite(doc, 116.42, 40.0)
  const added = sites(r.doc).find((x) => x.id === r.id)!
  assert.deepEqual(added.receiver, sites(doc)[0]!.receiver)
})

test('setPath：改既有字段，其余部分一字不动', () => {
  const doc = demo()
  const next = setPath(doc, 'sites.0.receiver.nf_dB', 4)
  assert.equal((sites(next)[0]!.receiver as Record<string, number>).nf_dB, 4)
  // 原文档不被就地改（撤销栈存的是整份文档，就地改会把历史一起改掉）
  assert.equal((sites(doc)[0]!.receiver as Record<string, number>).nf_dB, 6)
  assert.deepEqual(next.emitters, doc.emitters)
})

test('setPath：中间对象缺席时建出来——站钟与设备型号本来就不存在（D-054）', () => {
  const doc = demo()
  assert.equal(sites(doc)[0]!.clock, undefined)   // demo-01 的站没有 clock
  const next = setPath(doc, 'sites.0.clock.sync_sigma_ns', 3)
  assert.deepEqual(sites(next)[0]!.clock, { sync_sigma_ns: 3 })
  // 顶层的可选标量字段同理
  const withModel = setPath(doc, 'sites.0.equipment_model', '宽带站-A')
  assert.equal(sites(withModel)[0]!.equipment_model, '宽带站-A')
})

test('setPath：不凭下标造数组元素——那会造出没有 id 的半个站', () => {
  const doc = demo()
  assert.equal(sites(doc).length, 1)
  assert.equal(setPath(doc, 'sites.7.receiver.nf_dB', 4), doc)   // 原样返回同一个引用
  assert.equal(sites(doc).length, 1)
})

test('链路标识按已知的站与源精确拆分：site-1-uav-1 是 site-1 与 uav-1，不是 site-1-uav 与 1（D-061）', () => {
  const doc = demo()
  assert.deepEqual(splitLinkId(doc, 'site-1-uav-1'), { site: 'site-1', emitter: 'uav-1' })
  // 对不上的不猜：不存在的站、只有一半的标识、空文档
  assert.equal(splitLinkId(doc, 'site-9-uav-1'), null)
  assert.equal(splitLinkId(doc, 'site-1'), null)
  assert.equal(splitLinkId(null, 'site-1-uav-1'), null)
})
