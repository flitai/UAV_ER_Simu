import { test } from 'node:test'
import assert from 'node:assert/strict'
import { datasetCells, datasetsNote, detailRows, truthRows } from './datasetRows.js'
import type { DatasetDetail, DatasetRow } from '../api/client.js'

const row: DatasetRow = {
  data_id: 'dronerfb_0_CH0_S4', kind: 'measured', batch: 'dronerfb', holdout: false,
  class_name: 'DJI Mini 4 Pro', visibility: 'LOS', distance_text: '10 m', split: 'test',
  center_frequency_Hz: 2.44e9, sample_count: 4000000, quality: 'degraded',
}

const full: DatasetDetail = {
  data_id: row.data_id, kind: 'measured', batch: 'dronerfb', holdout: false, detail_level: 'manifest',
  index: { dataset: 'DroneRFb-DIR', channel_id: 'CH0', center_frequency_Hz: 2.44e9, sample_count: 4000000, segments: 1, quality: 'degraded',
    truth: { class_code: 'D1', class_name: 'DJI Mini 4 Pro', split: 'test', visibility: 'LOS', individual: 1, distance_m: 10 } },
  calibration: { full_scale_dBm: -1.6, source: 'model', status: 'prototype' },
  manifest: {
    sampling: { sample_rate_Hz: 8e7, sample_count: 4000000, duration_s: 0.05 },
    frequency: { center_frequency_Hz: 2.44e9, effective_bandwidth_Hz: 8e7 },
    time: { time_basis: 'file_acquisition', continuity: { flag: 'continuous' } },
    quality: { status: 'degraded', checks: { hash_duplicate: 'valid' }, reasons: ['采样率取自论文', '标定常数为估算值'] },
    model_trace: { model_id: 'measured:DroneRFb-DIR', model_layer: 'M3', model_level: 'E4', credibility: 'V2' },
    segments: { count: 1, sample_count: 4000000 },
  },
}

const indexOnly: DatasetDetail = {
  data_id: row.data_id, kind: 'measured', batch: 'dronerfb', holdout: true, detail_level: 'index',
  index: { dataset: 'DroneRFb-DIR', channel_id: 'CH0', center_frequency_Hz: 2.44e9, sample_count: 4000000, quality: 'degraded', truth: {} },
  calibration: { full_scale_dBm: -1.6, source: 'model', status: 'prototype' },
}

test('datasetCells：视距译成中文，缺的写「—」不编', () => {
  const c = datasetCells(row)
  assert.equal(c.visibility, '视距')
  assert.equal(c.distance, '10 m')
  assert.equal(c.quality, 'degraded')
  const bare = datasetCells({ data_id: 'x', kind: 'measured', batch: 'b', holdout: true })
  assert.deepEqual([bare.className, bare.visibility, bare.distance, bare.center, bare.samples], ['—', '—', '—', '—', '—'])
  assert.equal(bare.quality, 'not_applicable', '没有质量字段时是「不适用」，不是「有效」')
  assert.equal(bare.holdout, true)
})

test('datasetsNote：列不全才写「列出多少」，出错时说出错', () => {
  assert.equal(datasetsNote(4714, 916, 12, true), '共 4714 段 · 匹配 916 段 · 列出 12 段')
  assert.equal(datasetsNote(4714, 24, 24, false), '共 4714 段 · 匹配 24 段')
  assert.equal(datasetsNote(0, 0, 0, false, '连不上'), '数据清单取不到：连不上')
})

test('detailRows：manifest 档出采样率与片长', () => {
  const rows = detailRows(full, false)
  const by = new Map(rows.map((r) => [r.key, r.value]))
  assert.equal(by.get('fs'), '80 MHz')
  assert.equal(by.get('duration'), '50.0 ms')
  assert.equal(by.get('center'), '2.44 GHz')
  assert.equal(by.get('calibration'), '-1.6 dBm')
  assert.equal(by.get('quality'), 'degraded')
})

test('detailRows：index 档采样率与片长缺席就写「—」，不拿别的数顶替（铁律 15）', () => {
  const by = new Map(detailRows(indexOnly, false).map((r) => [r.key, r.value]))
  assert.equal(by.get('fs'), '—')
  assert.equal(by.get('duration'), '—')
  assert.equal(by.get('samples'), '4 M', '索引里有的照样出')
  assert.equal(by.get('calibration'), '-1.6 dBm', '标定常数是批级的，index 档也有')
})

test('detailRows：质检原因、八项质检、标定来源、溯源只在 ?dev=1（D-042b、D-047 ④、D-039）', () => {
  const plain = detailRows(full, false)
  const dev = detailRows(full, true)
  for (const k of ['quality_reasons', 'quality_checks', 'calibration_source', 'model_trace']) {
    assert.ok(!plain.some((r) => r.key === k), `默认不该出现 ${k}`)
    assert.ok(dev.some((r) => r.key === k && r.dev === true), `?dev=1 要有 ${k} 且标了 dev`)
  }
  // 「取自论文」这类来源解释句默认一个字都不许出现
  const text = plain.map((r) => `${r.label}${r.value}`).join('')
  assert.ok(!text.includes('论文'), '默认视图里不出现来源解释')
  assert.ok(!text.includes('估算'), '默认视图里不出现估算说明')
  assert.ok(dev.map((r) => r.value).join('').includes('取自论文'), '开发者模式里照实给')
})

test('truthRows：只摆记着的项，两批数据各给各的', () => {
  const by = new Map(truthRows(full).map((r) => [r.key, r.value]))
  assert.equal(by.get('class_name'), 'DJI Mini 4 Pro')
  assert.equal(by.get('visibility'), '视距')
  assert.equal(by.get('distance'), '10 m')
  assert.equal(by.get('split'), '测试集')
  assert.deepEqual(truthRows(indexOnly), [], '没有真值就一行都不写，不列一堆「—」')

  const a: DatasetDetail = { ...indexOnly, index: { truth: { class_name: 'DJI Phantom 4 Pro', distance_range_m: [20, 40], band_state: '2.4G' } } }
  const byA = new Map(truthRows(a).map((r) => [r.key, r.value]))
  assert.equal(byA.get('distance'), '20–40 m', '只有区间时给区间')
  assert.equal(byA.get('band_state'), '2.4G')
})
