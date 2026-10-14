// 设备字段表的单测：框图页右栏只在用得上时显示站钟；缺席字段的占位文字写缺席的实际含义。
//
// 对着真场景跑。基准场景的站点都写了站钟；「没写站钟」的情形（正式集的场景就是这样）
// 由 golden-01 的站点去掉 `clock` 构造。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { ScenarioDoc } from '../../state/types.js'
import { sites } from './scenarioOps.js'
import { chainFieldsFor, DEVICE_FIELDS, fieldsFor } from './deviceFields.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const load = (id: string): ScenarioDoc =>
  JSON.parse(readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios', `${id}.scenario.json`), 'utf8')) as ScenarioDoc
const clockKeys = (fs: { rel: string; key: string }[]) => fs.filter((f) => f.rel.startsWith('clock.')).map((f) => f.key)
const withoutClock = (s: Record<string, unknown>) => { const { clock: _drop, ...rest } = s; return rest }

test('站点没写站钟、链也不做时差定位：框图页不显示站钟一组，场景表单照常显示', () => {
  const site = withoutClock(sites(load('golden-01'))[0]!)
  assert.equal(site.clock, undefined)
  assert.deepEqual(clockKeys(chainFieldsFor('site', site, false)), [])
  assert.equal(clockKeys(fieldsFor('site', site)).length, 5)
})

test('链做时差定位，或站点写了站钟：框图页显示站钟一组', () => {
  const bare = withoutClock(sites(load('golden-01'))[0]!)
  assert.equal(clockKeys(chainFieldsFor('site', bare, true)).length, 5)
  const withClock = sites(load('golden-03'))[0]!
  assert.notEqual(withClock.clock, undefined)
  assert.equal(clockKeys(chainFieldsFor('site', withClock, false)).length, 5)
})

test('站钟以外的站点字段不受影响；辐射源字段与 fieldsFor 相同', () => {
  const site = withoutClock(sites(load('golden-01'))[0]!)
  const rest = (fs: { rel: string; key: string }[]) => fs.filter((f) => !f.rel.startsWith('clock.')).map((f) => f.key)
  assert.deepEqual(rest(chainFieldsFor('site', site, false)), rest(fieldsFor('site', site)))
  const em = (load('golden-01').emitters as Record<string, unknown>[])[0]!
  assert.deepEqual(chainFieldsFor('emitter', em, false).map((f) => f.key), fieldsFor('emitter', em).map((f) => f.key))
})

test('缺席即有确定含义的字段带占位文字：载频偏差 0，型号与站钟「—」', () => {
  const byKey = new Map([...DEVICE_FIELDS.site, ...DEVICE_FIELDS.emitter].map((f) => [f.key, f]))
  assert.equal(byKey.get('em.cfo')!.absent, '0')
  for (const k of ['site.model', 'em.model', 'site.clock_sigma', 'site.clock_bias', 'site.rx_delay', 'site.rx_delay_sigma']) {
    assert.equal(byKey.get(k)!.absent, '—', k)
  }
  // 缺席会出错的字段不给占位文字，界面照旧显示「未设置」
  for (const k of ['site.nf', 'site.fs', 'em.tx_power', 'em.center']) assert.equal(byKey.get(k)!.absent, undefined, k)
})
