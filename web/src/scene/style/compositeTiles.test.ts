// 合成底图的两条纯规则（D-084 补充）：哪一层取哪一份、地址怎么解析。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCompositeUrl, pickArchive } from './compositeTiles.js'

test('zoom ≤ 概览最高层级取概览，以上取区域底图', () => {
  for (let z = 0; z <= 6; z++) assert.equal(pickArchive(z, 6), 'overview')
  for (let z = 7; z <= 15; z++) assert.equal(pickArchive(z, 6), 'regional')
})

test('地址解析：TileJSON 与瓦片两种，其余拒绝', () => {
  assert.deepEqual(parseCompositeUrl('cuavpm://beijing'), { key: 'beijing', zxy: null })
  assert.deepEqual(parseCompositeUrl('cuavpm://beijing/6/52/24'), { key: 'beijing', zxy: [6, 52, 24] })
  assert.equal(parseCompositeUrl('pmtiles:///data/basemap/planet.pmtiles'), null)
  assert.equal(parseCompositeUrl('cuavpm://Beijing/1/2/3'), null)
  assert.equal(parseCompositeUrl('cuavpm://beijing/1/2'), null)
})
