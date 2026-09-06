import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeRowFrame, isEnvelope } from './frames.js'

function frame(header: object, row: number[], padOverride?: number): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const pad = padOverride ?? (4 - (json.length % 4)) % 4
  const headerLen = json.length + pad
  const buf = new ArrayBuffer(4 + headerLen + row.length * 4)
  new DataView(buf).setUint32(0, headerLen, true)
  new Uint8Array(buf, 4, json.length).set(json)
  for (let i = 0; i < pad; i++) new Uint8Array(buf)[4 + json.length + i] = 0x20
  const dv = new DataView(buf)
  row.forEach((v, i) => dv.setFloat32(4 + headerLen + i * 4, v, true))   // 用 DataView 写，补齐不合法时也能构造出坏帧
  return buf
}

test('二进制帧：0 到 3 字节补齐都能零拷贝解出', () => {
  for (let extra = 0; extra < 4; extra++) {
    const h = { seq: 7, task_id: 't', op_id: 's4', kind: 'spectrum', row_index: 3, row_len: 4, t_s: 0.5, x: 'y'.repeat(extra) }
    const buf = frame(h, [1.5, -2, 3, 4])
    const { header, data } = decodeRowFrame(buf)
    assert.equal(header.seq, 7); assert.equal(header.row_len, 4)
    assert.deepEqual(Array.from(data), [1.5, -2, 3, 4])
    assert.equal(data.byteOffset % 4, 0); assert.equal(data.buffer, buf)
  }
})

test('帧头长度不是 4 的倍数或越界要抛', () => {
  const bad = frame({ seq: 1, row_len: 1 }, [1], 1)   // 强制补 1 字节，长度非 4 倍数
  assert.throws(() => decodeRowFrame(bad), /帧头长度不合法/)
  assert.throws(() => decodeRowFrame(new ArrayBuffer(2)), /不足/)
  const cut = new ArrayBuffer(8); new DataView(cut).setUint32(0, 400, true)
  assert.throws(() => decodeRowFrame(cut), /帧头长度不合法/)
})

test('文本信封判别', () => {
  assert.equal(isEnvelope({ seq: 1, task_id: 't', type: 'log', t_s: 0, payload: {} }), true)
  assert.equal(isEnvelope({ seq: '1', task_id: 't', type: 'log', t_s: 0, payload: {} }), false)
  assert.equal(isEnvelope({ seq: 1, task_id: 't', type: 'log', t_s: 0 }), false)
  assert.equal(isEnvelope(null), false)
})
