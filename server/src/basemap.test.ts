// 底图选用（D-084）：用临时目录造出「只有全球 / 只有区域 / 两份都有 / 多份区域 / 都没有」几种盘面，
// 逐一核对选用结果。重点是两条：不设环境变量时开发机的老行为不变（全球底图在就用它）；
// 点了名却不在盘上时报错，不退回另一份（铁律 15）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBasemap } from './basemap.js'

function fixture(opts: { planet?: boolean; regional?: string[]; overview?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'cuav-basemap-'))
  const bm = join(root, 'data', 'basemap')
  mkdirSync(join(bm, 'regional'), { recursive: true })
  if (opts.planet) writeFileSync(join(bm, 'planet.pmtiles'), 'x')
  for (const id of opts.regional ?? []) {
    writeFileSync(join(bm, 'regional', `${id}.pmtiles`), 'x')
    writeFileSync(join(bm, 'regional', `${id}.manifest.json`), JSON.stringify({ output: { bounds: [115.41, 39.44, 117.51, 41.06] } }))
  }
  if (opts.overview) {
    mkdirSync(join(bm, 'overview'), { recursive: true })
    writeFileSync(join(bm, 'overview', 'world-z6.pmtiles'), 'x')
    writeFileSync(join(bm, 'overview', 'world-z6.manifest.json'), JSON.stringify({ output: { maxzoom: 6 } }))
  }
  // 抽取中途留下的临时文件不算一份底图
  writeFileSync(join(bm, 'regional', 'beijing.part.pmtiles'), 'x')
  return root
}

test('不设环境变量：全球底图在就用它（开发机老行为）', async () => {
  const root = fixture({ planet: true, regional: ['beijing'] })
  try {
    const r = await resolveBasemap(root, undefined)
    assert.ok(r.ok)
    assert.equal(r.choice.id, 'planet')
    assert.equal(r.choice.pmtiles_url, '/data/basemap/planet.pmtiles')
    assert.equal(r.choice.dem_tiles, '/data/basemap/dem/{z}/{x}/{y}.png')
    assert.equal(r.choice.bounds, null)
    assert.equal(r.choice.selected_by, 'auto')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('不设环境变量、只有一份区域底图：用它（交付包的形态）', async () => {
  const root = fixture({ regional: ['beijing'] })
  try {
    const r = await resolveBasemap(root, '')
    assert.ok(r.ok)
    assert.equal(r.choice.id, 'beijing')
    assert.equal(r.choice.pmtiles_url, '/data/basemap/regional/beijing.pmtiles')
    assert.equal(r.choice.dem_tiles, '/data/basemap/regional/beijing-dem/{z}/{x}/{y}.png')
    assert.deepEqual(r.choice.bounds, [115.41, 39.44, 117.51, 41.06])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('点名区域底图：即使全球底图也在，用点名的那份', async () => {
  const root = fixture({ planet: true, regional: ['beijing'] })
  try {
    const r = await resolveBasemap(root, 'beijing')
    assert.ok(r.ok)
    assert.equal(r.choice.id, 'beijing')
    assert.equal(r.choice.selected_by, 'env')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('点了名却不在盘上：报错，不退回另一份', async () => {
  const root = fixture({ regional: ['beijing'] })
  try {
    const r1 = await resolveBasemap(root, 'planet')
    assert.equal(r1.ok, false)
    if (!r1.ok) { assert.equal(r1.status, 503); assert.match(r1.message, /planet\.pmtiles/) }
    const r2 = await resolveBasemap(root, 'shanghai')
    assert.equal(r2.ok, false)
    const r3 = await resolveBasemap(root, '../etc')
    assert.equal(r3.ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('多份区域底图又没点名：不猜；什么都没有：说清楚', async () => {
  const many = fixture({ regional: ['beijing', 'tianjin'] })
  const none = fixture({})
  try {
    const r1 = await resolveBasemap(many, undefined)
    assert.equal(r1.ok, false)
    if (!r1.ok) assert.equal(r1.code, 'basemap_ambiguous')
    const r2 = await resolveBasemap(none, undefined)
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.code, 'basemap_unavailable')
  } finally {
    rmSync(many, { recursive: true, force: true })
    rmSync(none, { recursive: true, force: true })
  }
})

test('全球概览只配区域底图：有则给地址与最高层级，全球底图恒为 null，概览不算一份可选底图', async () => {
  const withOv = fixture({ regional: ['beijing'], overview: true })
  const noOv = fixture({ regional: ['beijing'] })
  const planet = fixture({ planet: true, overview: true })
  try {
    const r1 = await resolveBasemap(withOv, undefined)
    assert.ok(r1.ok)
    assert.equal(r1.choice.id, 'beijing')
    assert.equal(r1.choice.overview_url, '/data/basemap/overview/world-z6.pmtiles')
    assert.equal(r1.choice.overview_maxzoom, 6)
    const r2 = await resolveBasemap(noOv, undefined)
    assert.ok(r2.ok)
    assert.equal(r2.choice.overview_url, null)
    const r3 = await resolveBasemap(planet, undefined)
    assert.ok(r3.ok)
    assert.equal(r3.choice.id, 'planet')
    assert.equal(r3.choice.overview_url, null)
    // 概览放在 overview/ 而不是 regional/：点名 world-z6 当区域底图是找不到的
    const r4 = await resolveBasemap(withOv, 'world-z6')
    assert.equal(r4.ok, false)
  } finally {
    for (const d of [withOv, noOv, planet]) rmSync(d, { recursive: true, force: true })
  }
})
