// 视窗抽取纯函数：行列选择、分组边界、内存行源（B-7）。不碰文件、不起服务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAP_PX,
  CAP_PY,
  MemoryRowSource,
  chunkRows,
  colEdgeHz,
  groupBounds,
  groupCount,
  selectCols,
  selectRows,
} from './window.js'

test('groupBounds：长度 m+1、首 0 末 n、单调不减；m ≤ n 时每组至少一项；m = n 恒等；m = 0 → [0]', () => {
  assert.deepEqual(groupBounds(10, 0), [0])
  assert.deepEqual(groupBounds(0, 0), [0])
  assert.deepEqual(groupBounds(6, 3), [0, 2, 4, 6])
  assert.deepEqual(groupBounds(7, 3), [0, 2, 4, 7])
  assert.deepEqual(groupBounds(5, 5), [0, 1, 2, 3, 4, 5])
  for (const n of [1, 2, 3, 7, 13, 64, 1953]) {
    for (const m of [1, 2, 3, 5, 8, 13, 64]) {
      if (m > n) continue
      const b = groupBounds(n, m)
      assert.equal(b.length, m + 1)
      assert.equal(b[0], 0)
      assert.equal(b[m], n)
      for (let g = 0; g < m; g++) {
        assert.ok(b[g + 1] > b[g], `n=${n} m=${m} g=${g} 组为空`)
        assert.ok(Number.isInteger(b[g]), '边界必须是整数')
      }
    }
  }
})

test('selectRows：缺省全程、floor/ceil、钳位、窗外归零、dt 异常不裁剪', () => {
  const dt = 0.001
  assert.deepEqual(selectRows(null, null, dt, 37), { lo: 0, hi: 37 })
  // 恰在边界：t0 = 3·dt → 第 3 行；t1 = 13·dt → 到第 13 行（半开）
  assert.deepEqual(selectRows(0.003, 0.013, dt, 37), { lo: 3, hi: 13 })
  // 窗内取整：floor(3.5) = 3，ceil(12.1) = 13
  assert.deepEqual(selectRows(0.0035, 0.0121, dt, 37), { lo: 3, hi: 13 })
  assert.deepEqual(selectRows(-5, 100, dt, 37), { lo: 0, hi: 37 })
  assert.deepEqual(selectRows(1, 2, dt, 37), { lo: 37, hi: 37 }) // 全在数据之后
  assert.deepEqual(selectRows(-2, -1, dt, 37), { lo: 0, hi: 0 }) // 全在数据之前
  assert.deepEqual(selectRows(0.02, 0.01, dt, 37), { lo: 20, hi: 20 }) // 倒置在 HTTP 层已 400，这里归零
  assert.deepEqual(selectRows(0.001, 0.002, 0, 37), { lo: 0, hi: 37 })
  assert.deepEqual(selectRows(null, null, dt, 0), { lo: 0, hi: 0 })
})

test('selectCols：half = floor(nfft/2) 对奇偶通用；bin 边界半格；钳位与全带', () => {
  const bw = 1000
  assert.deepEqual(selectCols(null, null, bw, 64), { lo: 0, hi: 64 })
  // 列 k 覆盖 [(k-32-0.5)·bw, (k-32+0.5)·bw)；零宽频段选中包含该频点的那一列
  assert.deepEqual(selectCols(0, 0, bw, 64), { lo: 32, hi: 33 })
  assert.deepEqual(selectCols(-12500, 7300, bw, 64), { lo: 20, hi: 40 })
  assert.deepEqual(selectCols(-1e9, 1e9, bw, 64), { lo: 0, hi: 64 })
  assert.deepEqual(selectCols(-32000, 32000, bw, 64), { lo: 0, hi: 64 })
  // 奇数 nfft：half = 3，列 3 是直流
  assert.deepEqual(selectCols(0, 0, bw, 7), { lo: 3, hi: 4 })
  assert.deepEqual(selectCols(null, null, bw, 7), { lo: 0, hi: 7 })
  // 倒置区间在 HTTP 层已 400，纯函数按 hi = max(lo, hi) 归零
  assert.deepEqual(selectCols(5000, 0, bw, 64), { lo: 37, hi: 37 })
  assert.deepEqual(selectCols(0, 0, 0, 64), { lo: 0, hi: 64 })
})

test('colEdgeHz：列区间的频率边界与 selectCols 互为反函数（在格点上）', () => {
  const bw = 1000
  assert.equal(colEdgeHz(0, bw, 64), -32500)
  assert.equal(colEdgeHz(64, bw, 64), 31500)
  assert.equal(colEdgeHz(32, bw, 64), -500)
  const s = selectCols(colEdgeHz(19, bw, 64), colEdgeHz(40, bw, 64), bw, 64)
  assert.deepEqual(s, { lo: 19, hi: 40 })
})

test('groupCount：缺省取 min(n, cap)，显式目标超过原始数不插值，n = 0 → 0', () => {
  assert.equal(groupCount(0, null, CAP_PY), 0)
  assert.equal(groupCount(0, 100, CAP_PY), 0)
  assert.equal(groupCount(1953, null, CAP_PY), 1953)
  assert.equal(groupCount(5000, null, CAP_PY), CAP_PY)
  assert.equal(groupCount(1024, null, CAP_PX), 1024)
  assert.equal(groupCount(9000, null, CAP_PX), CAP_PX)
  assert.equal(groupCount(64, 1000, CAP_PX), 64) // 不插值
  assert.equal(groupCount(64, 7, CAP_PX), 7)
  assert.equal(groupCount(64, 1, CAP_PX), 1)
})

test('MemoryRowSource 与 chunkRows', async () => {
  const d = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])
  const src = new MemoryRowSource(d, 2)
  assert.equal(src.rows, 4)
  assert.deepEqual([...(await src.read(1, 2))], [3, 4, 5, 6])
  assert.equal(chunkRows(1024, 4 * 1024 * 1024), 1024)
  assert.equal(chunkRows(3, 40), 3)
  assert.equal(chunkRows(1 << 20, 16), 1) // 行比块还大时至少一行
})
