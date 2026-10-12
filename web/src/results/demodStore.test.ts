import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DemodBursts } from '../api/client.js'
import { burstsOf, defaultBurst, defaultEmitter } from './demodStore.js'
import { histogram } from './demodPlot.js'

const list: DemodBursts = {
  op_id: 's3', sample_rate_Hz: 80e6, center_Hz: 2.44e9, band_Hz: [2.4e9, 2.48e9], site_id: 'site-1', algo_version: 'demod-v1',
  emitters: [
    { emitter_id: 'rc-1', label: 'rc_hopping', waveform: 'ofdm', preset_id: 'dji-uplink-2m', preset_name: null, count: 2 },
    { emitter_id: 'uav-1', label: 'video_link', waveform: 'ofdm', preset_id: 'dji-video-20m-a', preset_name: null, count: 3 },
  ],
  bursts: [
    { emitter_id: 'uav-1', label: 'video_link', waveform: 'ofdm', preset_id: null, t_s: 0, t_end_s: 0.001, center_Hz: 2.4625e9, bw_Hz: 18e6, overlap: [], edge: true },
    { emitter_id: 'uav-1', label: 'video_link', waveform: 'ofdm', preset_id: null, t_s: 0.002, t_end_s: 0.003, center_Hz: 2.4625e9, bw_Hz: 18e6, overlap: ['rc-1'], edge: false },
    { emitter_id: 'uav-1', label: 'video_link', waveform: 'ofdm', preset_id: null, t_s: 0.004, t_end_s: 0.005, center_Hz: 2.4625e9, bw_Hz: 18e6, overlap: [], edge: false },
    { emitter_id: 'rc-1', label: 'rc_hopping', waveform: 'ofdm', preset_id: null, t_s: 0.004, t_end_s: 0.0045, center_Hz: 2.43e9, bw_Hz: 2.2e6, overlap: [], edge: false },
  ],
}

test('解调页签缺省：图传优先，取第一个不重叠、不贴文件起止的突发', () => {
  assert.equal(defaultEmitter(list), 'uav-1')
  assert.equal(defaultBurst(list, 'uav-1')?.t_s, 0.004)
  assert.equal(burstsOf(list, 'rc-1').length, 1)
  assert.equal(defaultEmitter({ ...list, emitters: [] }), null)
})

test('GFSK 频偏直方图：±2·f_dev、64 箱，范围外不计', () => {
  const h = histogram(Float32Array.from([-57000, 57000, 57100, 1e6]), 57128.9)
  assert.equal(h.counts.length, 64)
  assert.equal(h.counts.reduce((a, c) => a + c, 0), 3)
  assert.ok(Math.abs(h.lo + 2 * 57128.9) < 1e-6)
})
