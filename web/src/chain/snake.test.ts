// 蛇形排布的单测（2026-09-09 用户指定：每行四张，双数行从右往左）。
//
// 版式本身在浏览器里量（`slice4-smoke` / `slice6-smoke`），这里只钉住那个纯函数：
// 哪一张卡片落在第几行第几列、与下一张之间的连接件朝哪边。它是版式的唯一真相来源，
// 改列数只改这里与 `.chain-strip` 的 `grid-template-columns` 两处。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CHAIN_COLS, snakePos } from './ChainView.js'
import { SLOTS } from './model.js'

test('蛇形：单数行从左往右，双数行从右往左', () => {
  const n = 11
  const seen = SLOTS.slice(0, n).map((_, i) => snakePos(i, n))
  // 第 0 行：列 1..4
  assert.deepEqual(seen.slice(0, 4).map((p) => [p.row, p.col]), [[0, 1], [0, 2], [0, 3], [0, 4]])
  // 第 1 行：列 4..1（掉头）
  assert.deepEqual(seen.slice(4, 8).map((p) => [p.row, p.col]), [[1, 4], [1, 3], [1, 2], [1, 1]])
  // 第 2 行：又从左往右
  assert.deepEqual(seen.slice(8, 11).map((p) => [p.row, p.col]), [[2, 1], [2, 2], [2, 3]])
})

test('蛇形：转折处上下同列——一行读到头，下一张就在正下方', () => {
  const n = 11
  for (let r = 0; r + 1 < 3; r++) {
    const lastOfRow = snakePos(r * CHAIN_COLS + CHAIN_COLS - 1, n)
    const firstOfNext = snakePos((r + 1) * CHAIN_COLS, n)
    assert.equal(lastOfRow.col, firstOfNext.col, `第 ${r} 行末尾与第 ${r + 1} 行开头应同列`)
    assert.equal(lastOfRow.row + 1, firstOfNext.row)
  }
})

test('蛇形：连接件方向随行方向翻转，行末向下，最后一张没有', () => {
  const n = 11
  const dirs = Array.from({ length: n }, (_, i) => snakePos(i, n).next)
  assert.deepEqual(dirs, [
    'right', 'right', 'right', 'down',      // 第 0 行
    'left', 'left', 'left', 'down',         // 第 1 行掉头
    'right', 'right', null,                 // 第 2 行，末张无连接件
  ])
})

test('蛇形：列数可配，槽位数不是列数整数倍时末行短一截', () => {
  // 三列时十一个排成 3 + 3 + 3 + 2
  const rows: number[][] = []
  for (let i = 0; i < 11; i++) {
    const p = snakePos(i, 11, 3)
    ;(rows[p.row] ??= []).push(p.col)
  }
  assert.deepEqual(rows, [[1, 2, 3], [3, 2, 1], [1, 2, 3], [3, 2]])
  // 末行仍从右往左（行号为奇），最后一张没有连接件
  assert.equal(snakePos(10, 11, 3).next, null)
  assert.equal(snakePos(9, 11, 3).next, 'left')
})

test('蛇形：单行放得下时退化成一条直线，全是向右', () => {
  const dirs = Array.from({ length: 4 }, (_, i) => snakePos(i, 4, 4).next)
  assert.deepEqual(dirs, ['right', 'right', 'right', null])
})
