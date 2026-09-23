// 场景编辑操作的单测（G-4；D-053 的「布目标」）。
//
// 对着**真场景** golden-01 跑：产出的文档必须仍然是引擎认得的那一份，
// 用桩数据测这层没有意义——`addEmitter` 最容易出的错正是「漏了航线」这类跨引用问题。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { ScenarioDoc } from '../../state/types.js'
import { activities, addActivity, addEmitter, addSite, addWaypoint, addZone, DEFAULT_SPEED_MPS, emitters, hopSequenceMHz, insertWaypoint, moveEmitter, moveZone, posOf, removeEmitter, removeZone, routeOf, setHopArgs, setPath, sites, splitLinkId, zoneOf, zones } from './scenarioOps.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
function demo(): ScenarioDoc {
  return JSON.parse(
    readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json'), 'utf8'),
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
  // golden-01 自 2026-09-23 起补了站钟，这里先把它去掉，才测得到「中间对象缺席」那一支
  const base = demo()
  const doc = { ...base, sites: sites(base).map((s, i) => {
    if (i !== 0) return s
    const { clock: _drop, ...rest } = s as Record<string, unknown>
    return rest
  }) } as typeof base
  assert.equal(sites(doc)[0]!.clock, undefined)
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

test('告警区：布区 / 移动 / 删除是纯函数，删空后键一起消失；进圈判定按弦长与限高（D-061）', () => {
  const doc = demo()   // golden-01 没有 zones
  assert.equal(zones(doc).length, 0)
  const r = addZone(doc, 116.41, 39.99)
  assert.equal(zones(doc).length, 0, '入参不变')
  assert.equal(r.id, 'z-1')
  const z = zones(r.doc)[0]!
  assert.equal(z.kind, 'alert')
  assert.equal(z.shape, 'circle')
  assert.equal(z.radius_m, 500)
  assert.equal(z.alt_max_m, undefined)
  // 圆心处在圈内；圈外 600 m 处不在；限高之上不在
  assert.equal(zoneOf(r.doc, 116.41, 39.99, 100)?.id, 'z-1')
  assert.equal(zoneOf(r.doc, 116.41, 39.99 + 600 / 111132, 100), null)
  const capped = setPath(r.doc, 'zones.0.alt_max_m', 120)
  assert.equal(zoneOf(capped, 116.41, 39.99, 100)?.id, 'z-1')
  assert.equal(zoneOf(capped, 116.41, 39.99, 121), null)
  const moved = moveZone(r.doc, 'z-1', 116.42, 39.98)
  assert.deepEqual((zones(moved)[0]!.center as Record<string, number>), { lon: 116.42, lat: 39.98 })
  const gone = removeZone(r.doc, 'z-1')
  assert.equal('zones' in gone, false)
  assert.equal(zoneOf(null, 116.41, 39.99, 0), null)
})

test('跳频活动：新建带 args、序列按 MHz 文本改写、与单值互斥（G-6，D-069）', () => {
  const doc = demo()
  const withHop = addActivity(doc, 'uav-1', 5, 'hop', { sequence: [2440e6, 2441e6], dwell_s: 0.01 })
  const idx = activities(withHop).findIndex((a) => a.event === 'hop')
  assert.ok(idx >= 0)
  assert.deepEqual((activities(withHop)[idx]!.args as Record<string, unknown>).sequence, [2440e6, 2441e6])
  // 其余事件不写 args，既有场景文件的形状因此不变
  const plain = addActivity(doc, 'uav-1', 5, 'tx_off')
  const pi = activities(plain).findIndex((a) => a.event === 'tx_off')
  assert.equal('args' in activities(plain)[pi]!, false)

  // 文本 → Hz 整数；MHz 小数也对
  const edited = setHopArgs(withHop, idx, '2439.5, 2442.25 2441', 0.02)
  const args = activities(edited)[idx]!.args as Record<string, unknown>
  assert.deepEqual(args.sequence, [2439500000, 2442250000, 2441000000])
  assert.equal(args.dwell_s, 0.02)

  // 序列与单值互斥：写序列时把 center_Hz 删掉（cross_check 拒同时给两种）
  const single = addActivity(doc, 'uav-1', 6, 'hop', { center_Hz: 2450e6 })
  const si = activities(single).findIndex((a) => a.event === 'hop')
  assert.equal(hopSequenceMHz(activities(single)[si]), '2450')
  const swapped = setHopArgs(single, si, '2445, 2446', undefined)
  const sa = activities(swapped)[si]!.args as Record<string, unknown>
  assert.deepEqual(sa.sequence, [2445000000, 2446000000])
  assert.equal('center_Hz' in sa, false)

  // 空串与非法值不动原值（不静默清空用户已填的东西，铁律 15）
  const kept = setHopArgs(edited, idx, '', undefined)
  assert.deepEqual((activities(kept)[idx]!.args as Record<string, unknown>).sequence,
                   [2439500000, 2442250000, 2441000000])
})

/**
 * 2026-09-19 用户实测：布一个目标、画几个航点，保存报
 * 「场景保存失败 [scenario] routes[2].waypoints[0] 的 speed_mps 必须为正」。
 *
 * 根子有两处，都在这里钉住：`addEmitter` 给首个航点写的是 0（schema `exclusiveMinimum: 0`、
 * 引擎 `positive()` 都不收），而 `addWaypoint` / `insertWaypoint` 的「沿用上一个航点的速度」
 * 用的是 `typeof x === 'number'`——**对 0 为真**，于是那个 0 顺着整条航线传下去，
 * 写在旁边的 `?? 15` 兜底一次也没触发过。
 */
test('编辑出来的每一个航点速度都为正（存得进去），非正的上一段不当作可沿用的值', () => {
  const doc = demo()
  const r = addEmitter(doc, 116.41, 39.99)
  let d = r.doc
  d = addWaypoint(d, r.id, 116.42, 39.995)
  d = addWaypoint(d, r.id, 116.43, 40.0)
  d = insertWaypoint(d, r.id, 0)

  const wps = (routeOf(d, r.id)!.waypoints as Array<{ speed_mps: number }>)
  assert.equal(wps.length, 4)
  for (const [i, w] of wps.entries()) {
    assert.ok(typeof w.speed_mps === 'number' && w.speed_mps > 0,
      `航点 ${i} 的 speed_mps 必须为正，实得 ${w.speed_mps}`)
  }
  assert.equal(wps[0].speed_mps, DEFAULT_SPEED_MPS, '布目标时那一个也要是正数，不是 0')

  // 全场景扫一遍：别的航线也不许被带坏
  for (const route of (d.routes as Array<{ emitter_id: string; waypoints: Array<{ speed_mps: number }> }>)) {
    for (const [i, w] of route.waypoints.entries()) {
      assert.ok(w.speed_mps > 0, `${route.emitter_id} 的航点 ${i} 速度非正：${w.speed_mps}`)
    }
  }
})

test('沿用速度：上一个是正数就跟着它，是 0 或负数就退回缺省而不是照抄', () => {
  const doc = demo()
  const r = addEmitter(doc, 116.41, 39.99)
  let d = setPath(r.doc, `routes.${(r.doc.routes as unknown[]).length - 1}.waypoints.0.speed_mps`, 7)
  d = addWaypoint(d, r.id, 116.42, 39.995)
  let wps = (routeOf(d, r.id)!.waypoints as Array<{ speed_mps: number }>)
  assert.equal(wps[1].speed_mps, 7, '正常值要沿用，不能每段都跳回缺省')

  d = setPath(d, `routes.${(d.routes as unknown[]).length - 1}.waypoints.1.speed_mps`, 0)
  d = addWaypoint(d, r.id, 116.43, 40.0)
  wps = (routeOf(d, r.id)!.waypoints as Array<{ speed_mps: number }>)
  assert.equal(wps[2].speed_mps, DEFAULT_SPEED_MPS, '上一段是 0（存不进去的值）就不该照抄')
})
