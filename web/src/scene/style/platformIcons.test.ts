// 机型剪影的判据与形状（D-078、D-109）：遥控器按波形预设的角色判，其余按 platform_type。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emitterPlatformKind, PLATFORM_SHAPES, platformSvg, type PlatformKind } from './platformIcons.js'
import { GFSK_PRESETS, RADIATOR_PRESETS } from '../presets.js'

const em = (platform_type: string, waveform: Record<string, unknown>) =>
  ({ id: 'x', platform_type, emission: { center_Hz: 2.44e9, waveform } })

test('预设角色是 rc_hopping 即遥控器，不管 platform_type 写的是什么', () => {
  const rc = [...RADIATOR_PRESETS, ...GFSK_PRESETS].filter((p) => p.role === 'rc_hopping')
  // 三档 DJI 遥控上行 + 两种 GFSK 遥控；表里多了少了都该有人看一眼
  assert.deepEqual(rc.map((p) => p.id).sort(),
    ['dji-uplink-1m', 'dji-uplink-2m', 'dji-uplink-4m', 'frsky-d16v2-fcc', 'futaba-sfhss'])
  for (const p of rc) assert.equal(emitterPlatformKind(em('multirotor', { type: p.type, preset_id: p.id })), 'remote', p.id)
})

test('图传、DroneID 广播与无预设的波形按 platform_type 判', () => {
  for (const p of RADIATOR_PRESETS.filter((x) => x.role !== 'rc_hopping')) {
    assert.equal(emitterPlatformKind(em('multirotor', { type: p.type, preset_id: p.id })), 'multirotor', p.id)
    assert.equal(emitterPlatformKind(em('fixed_wing', { type: p.type, preset_id: p.id })), 'fixed_wing', p.id)
  }
  // golden 场景里的「穿越机 · 遥控」是机载 burst，没有预设，仍画穿越机（多旋翼剪影）
  assert.equal(emitterPlatformKind(em('racing', { type: 'burst', period_s: 0.01, duty: 0.3 })), 'multirotor')
  assert.equal(emitterPlatformKind(em('medium', { type: 'tone' })), 'fixed_wing')
})

test('预设 id 认不出、缺 emission 或缺 platform_type 时回落，不抛错', () => {
  assert.equal(emitterPlatformKind(em('fixed_wing', { type: 'ofdm', preset_id: 'no-such-preset' })), 'fixed_wing')
  assert.equal(emitterPlatformKind({ id: 'x', platform_type: 'fixed_wing' }), 'fixed_wing')
  assert.equal(emitterPlatformKind({ id: 'x' }), 'multirotor')
  assert.equal(emitterPlatformKind(undefined), 'multirotor')
})

test('每种剪影的 viewBox 都是正方形（光栅化与告警环都按正方形算）', () => {
  for (const [kind, s] of Object.entries(PLATFORM_SHAPES)) {
    const [, , w, h] = s.viewBox.split(' ').map(Number)
    assert.ok(w! > 0 && w === h, `${kind}: ${s.viewBox}`)
  }
})

test('遥控器 SVG 带描边外壳；告警变体另加一圈环', () => {
  const plain = platformSvg('remote' satisfies PlatformKind)
  const ring = platformSvg('remote', true)
  assert.equal((plain.match(/<path /g) ?? []).length, PLATFORM_SHAPES.remote.paths.length + 1)
  assert.match(plain, /stroke-width="18"[^>]*stroke-linejoin="round"/)
  assert.ok(!plain.includes('<circle'))
  assert.ok(ring.includes('<circle') && ring.includes('stroke-width="18"'))
})
