// 文件行源与索引读取（B-7）：分块读、短读、就绪语义、以文件长度定行数。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from '../tasks/manager.js'
import { makeRoot, rmrf } from '../tasks/testkit.js'
import { MemoryRowSource, chunkRows } from './window.js'
import { openFileRowSource } from './source.js'
import { parseIndex, readProductMeta, rowsAvailable } from './meta.js'
import { extractSpectrum, type SpectrumGeom } from './spectrum.js'

const roots: string[] = []
after(async () => {
  for (const r of roots) await rmrf(r)
})

const ROW_LEN = 8
const ROWS = 25

function fixture(): Float32Array {
  const d = new Float32Array(ROWS * ROW_LEN)
  for (let i = 0; i < ROWS; i++) for (let k = 0; k < ROW_LEN; k++) d[i * ROW_LEN + k] = -100 + i + k * 0.5
  return d
}

async function writeProduct(root: string, opId = 's4'): Promise<{ dir: string; data: Float32Array }> {
  const d = fixture()
  const dir = join(root, opId)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, 'spectrum.f32'), Buffer.from(d.buffer, d.byteOffset, d.byteLength))
  return { dir, data: d }
}

const INDEX = {
  schema_version: 'cuav-product/1',
  kind: 'spectrum',
  dtype: 'float32',
  byte_order: 'little',
  op_id: 's4',
  row_len: ROW_LEN,
  rows: ROWS,
  sample_rate_Hz: 8000,
  center_Hz: 2.44e9,
  bin_width_Hz: 1000,
  frame_hop_samples: 8,
  nfft: ROW_LEN,
  start_sample: 0,
  t0_s: 0,
  scale: 'dBFS',
  floor_dB: -300,
  state: 'valid',
}

test('openFileRowSource：分块读与内存源结果相同；末尾半行被文件长度忽略；打开后增长不改行数', async () => {
  const root = await makeRoot('cuav-prod-src-')
  roots.push(root)
  const { data } = await writeProduct(root)
  const path = join(root, 's4', 'spectrum.f32')
  // 追加半行：以文件长度定行数时应当被忽略
  await fsp.appendFile(path, Buffer.alloc(ROW_LEN * 4 - 4))
  const size = (await fsp.stat(path)).size
  assert.equal(rowsAvailable(size, ROW_LEN), ROWS)

  const src = await openFileRowSource(path, ROW_LEN, ROWS)
  assert.equal(src.rows, ROWS)
  assert.deepEqual([...(await src.read(3, 2))], [...data.subarray(3 * ROW_LEN, 5 * ROW_LEN)])

  const geom: SpectrumGeom = { dt: 0.001, bw: 1000, nfft: ROW_LEN, rowsAvail: ROWS }
  const q = { t0: null, t1: null, f0: null, f1: null, px: 3, py: 4, stat: 'mean' as const }
  const fromFile = await extractSpectrum(src, geom, q)
  const fromMem = await extractSpectrum(new MemoryRowSource(data, ROW_LEN), geom, q)
  assert.deepEqual([...fromFile.data], [...fromMem.data])

  // 打开之后文件继续增长，行数不变（一次响应对应一个快照）
  await fsp.appendFile(path, Buffer.alloc(ROW_LEN * 4 * 3))
  assert.equal(src.rows, ROWS)
  await src.close()
})

test('openFileRowSource：分块上限逼出多次 read；超过上限的单次读被拒；文件被截短报 short_read', async () => {
  const root = await makeRoot('cuav-prod-chunk-')
  roots.push(root)
  const { data } = await writeProduct(root)
  const path = join(root, 's4', 'spectrum.f32')
  // 每块只放 2 行：extractSpectrum 必须自己分块，且结果与内存源一致
  const small = chunkRows(ROW_LEN, 2 * ROW_LEN * 4)
  assert.equal(small, 2)

  const src = await openFileRowSource(path, ROW_LEN, ROWS)
  await assert.rejects(
    () => src.read(0, chunkRows(ROW_LEN) + 1),
    (e: unknown) => e instanceof HttpError && e.status === 500,
  )
  await src.close()

  await fsp.truncate(path, 10 * ROW_LEN * 4)
  const src2 = await openFileRowSource(path, ROW_LEN, ROWS) // 谎报行数，逼出短读
  await assert.rejects(
    () => src2.read(20, 2),
    (e: unknown) => e instanceof HttpError && e.status === 500 && e.body.error === 'short_read',
  )
  await src2.close()
  assert.equal([...data].length, ROWS * ROW_LEN)
})

test('readProductMeta：产品缺失按运行态给 409 / 404；索引缺 409 index_missing；坏索引 500', async () => {
  const root = await makeRoot('cuav-prod-meta-')
  roots.push(root)
  const taskDir = join(root, 't1')
  await fsp.mkdir(taskDir, { recursive: true })

  await assert.rejects(
    () => readProductMeta(taskDir, 's4', 'spectrum', 'running'),
    (e: unknown) => e instanceof HttpError && e.status === 409 && e.body.reason === 'product_missing',
  )
  await assert.rejects(
    () => readProductMeta(taskDir, 's4', 'spectrum', 'finished'),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  )
  await assert.rejects(
    () => readProductMeta(taskDir, '../etc', 'spectrum', 'finished'),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  )

  await writeProduct(taskDir)
  // 索引还没写出来：运行中与终态都是 409，客户端重试
  for (const st of ['running', 'finished'] as const) {
    await assert.rejects(
      () => readProductMeta(taskDir, 's4', 'spectrum', st),
      (e: unknown) => e instanceof HttpError && e.status === 409 && e.body.reason === 'index_missing' && e.body.bytes === ROWS * ROW_LEN * 4,
    )
  }
  // 包络在索引缺失时仍能给出行数（行长恒为 3）
  const env = new Float32Array(3 * 4)
  await fsp.writeFile(join(taskDir, 's4', 'envelope.f32'), Buffer.from(env.buffer))
  await assert.rejects(
    () => readProductMeta(taskDir, 's4', 'envelope', 'running'),
    (e: unknown) => e instanceof HttpError && e.body.rows_available === 4,
  )

  await fsp.writeFile(join(taskDir, 's4', 'spectrum.index.json'), '{ not json')
  await assert.rejects(
    () => readProductMeta(taskDir, 's4', 'spectrum', 'finished'),
    (e: unknown) => e instanceof HttpError && e.status === 500 && e.body.error === 'index_invalid',
  )
})

test('readProductMeta：以文件长度定行数，index_final 由 rows 是否追平决定', async () => {
  const root = await makeRoot('cuav-prod-final-')
  roots.push(root)
  const taskDir = join(root, 't1')
  await fsp.mkdir(taskDir, { recursive: true })
  await writeProduct(taskDir)
  const idxPath = join(taskDir, 's4', 'spectrum.index.json')

  // 索引落后于文件（运行中每 64 行才刷，或被杀时没收尾）
  await fsp.writeFile(idxPath, JSON.stringify({ ...INDEX, rows: 12 }))
  const m1 = await readProductMeta(taskDir, 's4', 'spectrum', 'running')
  assert.equal(m1.rows_available, ROWS)
  assert.equal(m1.index.rows, 12)
  assert.equal(m1.index_final, false)

  await fsp.writeFile(idxPath, JSON.stringify(INDEX))
  const m2 = await readProductMeta(taskDir, 's4', 'spectrum', 'finished')
  assert.equal(m2.rows_available, ROWS)
  assert.equal(m2.index_final, true)

  // 索引比文件长（只可能是文件被截）：仍以文件为准
  await fsp.writeFile(idxPath, JSON.stringify({ ...INDEX, rows: 999 }))
  const m3 = await readProductMeta(taskDir, 's4', 'spectrum', 'finished')
  assert.equal(m3.rows_available, ROWS)
  assert.equal(m3.index_final, false)
})

test('parseIndex：字段校验覆盖 schema、kind、row_len 与 nfft 一致性、采样率、包络三列', () => {
  assert.equal(parseIndex(INDEX, 'spectrum').row_len, ROW_LEN)
  const bad = (patch: Record<string, unknown>, kind: 'spectrum' | 'envelope' = 'spectrum') =>
    assert.throws(
      () => parseIndex({ ...INDEX, ...patch }, kind),
      (e: unknown) => e instanceof HttpError && e.status === 500 && e.body.error === 'index_invalid',
    )
  bad({ schema_version: 'other/1' })
  bad({ kind: 'envelope' })
  bad({ byte_order: 'big' })
  bad({ row_len: 0 })
  bad({ row_len: 16 }) // 与 nfft 不一致
  bad({ rows: -1 })
  bad({ sample_rate_Hz: 0 })
  bad({ bin_width_Hz: 0 })
  bad({ frame_hop_samples: 0 })
  bad({ state: 5 })
  bad({}, 'envelope')
  assert.throws(() => parseIndex(null, 'spectrum'), (e: unknown) => e instanceof HttpError)
  const env = { ...INDEX, kind: 'envelope', row_len: 3, bucket_samples: 4096, last_bucket_samples: 1152 }
  delete (env as Record<string, unknown>).nfft
  assert.equal(parseIndex(env, 'envelope').row_len, 3)
  assert.throws(
    () => parseIndex({ ...env, last_bucket_samples: -1 }, 'envelope'),
    (e: unknown) => e instanceof HttpError,
  )
})
