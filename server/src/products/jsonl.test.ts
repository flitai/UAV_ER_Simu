// 时间窗 JSONL 读取（B-7）：闭区间、按键抽稀、过滤、半行与坏行。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { makeRoot, rmrf } from '../tasks/testkit.js'
import { readJsonlWindow } from './jsonl.js'

const roots: string[] = []
after(async () => {
  for (const r of roots) await rmrf(r)
})

/** 两个实体交替，各 6 条，t_s 0.0 起每条 +0.5。 */
function trackText(): string {
  const lines: string[] = []
  for (let i = 0; i < 6; i++) {
    for (const id of ['uav-1', 'uav-2']) {
      lines.push(JSON.stringify({ t_s: i * 0.5, id, lon: 116.4 + i * 0.001, lat: 39.99, alt_m: 100 + i }))
    }
  }
  return lines.join('\n') + '\n'
}

test('闭区间取窗、按键抽稀、末尾半行丢弃、坏行与缺 t_s 计数、CRLF、文件不存在返回 null', async () => {
  const root = await makeRoot('cuav-jsonl-')
  roots.push(root)
  const path = join(root, 'track.jsonl')
  const text =
    trackText().replace('\n', '\r\n') +
    '{"t_s": 9.0, "id": "uav-1"\n' + // 坏 JSON
    '{"id": "uav-3", "lon": 1}\n' + // 缺 t_s
    '[1,2,3]\n' + // 不是对象
    '\n' + // 空行
    '{"t_s": 8.0, "id": "uav-1"' // 末尾半行，无换行
  await fsp.writeFile(path, text)

  const all = (await readJsonlWindow(path, { t0: null, t1: null, stride: 1 }))!
  assert.equal(all.records.length, 12)
  assert.equal(all.skipped, 3) // 坏 JSON、缺 t_s、数组；末尾半行不计
  assert.equal(all.records[0].id, 'uav-1')

  // 闭区间：t_s = 0.5 与 t_s = 1.5 都要在内
  const win = (await readJsonlWindow(path, { t0: 0.5, t1: 1.5, stride: 1 }))!
  assert.deepEqual(win.records.map((r) => r.t_s), [0.5, 0.5, 1, 1, 1.5, 1.5])

  // 按 id 抽稀：每个实体各留第 0、2、4 条
  const thin = (await readJsonlWindow(path, { t0: null, t1: null, stride: 2, strideKey: (r) => String(r.id) }))!
  assert.equal(thin.records.length, 6)
  assert.deepEqual(thin.records.filter((r) => r.id === 'uav-1').map((r) => r.t_s), [0, 1, 2])
  assert.deepEqual(thin.records.filter((r) => r.id === 'uav-2').map((r) => r.t_s), [0, 1, 2])

  // 全局抽稀（不给键）：整体每 3 条留 1 条
  const g = (await readJsonlWindow(path, { t0: null, t1: null, stride: 3 }))!
  assert.equal(g.records.length, 4)

  // 过滤在抽稀之前生效：只看 uav-2 时它自己的第 0、2、4 条
  const f = (await readJsonlWindow(path, { t0: null, t1: null, stride: 2, filter: (r) => r.id === 'uav-2' }))!
  assert.deepEqual(f.records.map((r) => r.t_s), [0, 1, 2])

  assert.equal(await readJsonlWindow(join(root, 'nope.jsonl'), { t0: null, t1: null, stride: 1 }), null)
})

test('空文件与只有半行的文件都返回空结果而不是 null', async () => {
  const root = await makeRoot('cuav-jsonl2-')
  roots.push(root)
  const empty = join(root, 'links.jsonl')
  await fsp.writeFile(empty, '')
  assert.deepEqual(await readJsonlWindow(empty, { t0: null, t1: null, stride: 1 }), { records: [], skipped: 0 })
  const half = join(root, 'detections.jsonl')
  await fsp.writeFile(half, '{"t_s": 1.0')
  assert.deepEqual(await readJsonlWindow(half, { t0: null, t1: null, stride: 1 }), { records: [], skipped: 0 })
})
