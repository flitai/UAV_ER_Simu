// 底图样式与 Airports 原样式的等价性测试（决策 D-017：逐项照搬，不改视觉参数）。
//
// 基准 tests/golden/airports-basemap-style.json 是 Airports `protomapsStyle()` 的求值结果，
// 生成方式见 tests/golden/README.md。**基准不得静默变化**（铁律 10）：本测试挂掉说明移植版
// 与原样式产生了视觉差异，要么是移植出错，要么是有意调整——后者必须先记决策再更新基准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { protomapsStyle } from './protomaps.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = resolve(HERE, '../../../../tests/golden/airports-basemap-style.json')
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
const mine = protomapsStyle({ url: '__PMTILES_URL__', maxzoom: 15 }) as unknown as Record<string, unknown>

test('图层数量一致', () => {
  assert.equal((mine.layers as unknown[]).length, golden.layers.length)
})

test('图层 id 与顺序一致（顺序决定压盖关系，不能只比集合）', () => {
  const ids = (o: { layers: Array<{ id: string }> }) => o.layers.map((l) => l.id)
  assert.deepEqual(ids(mine as never), ids(golden))
})

test('逐层完全一致：过滤条件、线宽档位、色值、缩放门槛、标注参数', () => {
  const a = golden.layers as unknown[]
  const b = mine.layers as unknown[]
  for (let i = 0; i < a.length; i++) {
    assert.equal(JSON.stringify(b[i]), JSON.stringify(a[i]),
      `第 ${i} 层（${(a[i] as { id: string }).id}）与基准不一致`)
  }
})

test('数据源、字形地址与版本一致', () => {
  assert.equal(JSON.stringify(mine.sources), JSON.stringify(golden.sources))
  assert.equal(mine.glyphs, golden.glyphs)
  assert.equal(mine.version, golden.version)
})

test('归档地址被拼进 pmtiles 协议', () => {
  const s = protomapsStyle({ url: '/data/basemap/planet.pmtiles' }) as unknown as
    { sources: { pm: { url: string } } }
  assert.equal(s.sources.pm.url, 'pmtiles:///data/basemap/planet.pmtiles')
})

test('署名字段保留（OpenStreetMap 按 ODbL 要求署名，铁律 13）', () => {
  const s = mine.sources as { pm: { attribution: string } }
  assert.match(s.pm.attribution, /OpenStreetMap/)
  assert.match(s.pm.attribution, /Protomaps/)
})
