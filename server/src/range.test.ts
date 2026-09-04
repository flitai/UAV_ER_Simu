// Range 解析的单元测试。跑法：npm run test（server 目录）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRange, rangeLength, contentRange, unsatisfiedContentRange } from './range.js'

const SIZE = 1000

test('无 Range 头', () => {
  assert.deepEqual(parseRange(undefined, SIZE), { kind: 'none' })
  assert.deepEqual(parseRange('', SIZE), { kind: 'none' })
})

test('闭区间', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { kind: 'range', start: 0, end: 99 })
  assert.equal(rangeLength({ start: 0, end: 99 }), 100)
  assert.equal(contentRange({ start: 0, end: 99 }, SIZE), 'bytes 0-99/1000')
})

test('开区间 bytes=start-', () => {
  assert.deepEqual(parseRange('bytes=990-', SIZE), { kind: 'range', start: 990, end: 999 })
})

test('后缀区间 bytes=-N', () => {
  assert.deepEqual(parseRange('bytes=-10', SIZE), { kind: 'range', start: 990, end: 999 })
})

test('后缀长度超过文件时截到文件头', () => {
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { kind: 'range', start: 0, end: 999 })
})

test('末端越界要截到文件末字节，不能报错', () => {
  assert.deepEqual(parseRange('bytes=900-99999', SIZE), { kind: 'range', start: 900, end: 999 })
})

test('起点越界返回 416', () => {
  assert.deepEqual(parseRange('bytes=1000-', SIZE), { kind: 'unsatisfiable' })
  assert.deepEqual(parseRange('bytes=5000-6000', SIZE), { kind: 'unsatisfiable' })
  assert.equal(unsatisfiedContentRange(SIZE), 'bytes */1000')
})

test('倒置区间返回 416', () => {
  assert.deepEqual(parseRange('bytes=500-499', SIZE), { kind: 'unsatisfiable' })
})

test('后缀长度为 0 返回 416', () => {
  assert.deepEqual(parseRange('bytes=-0', SIZE), { kind: 'unsatisfiable' })
})

test('空文件的任何区间都不可满足', () => {
  assert.deepEqual(parseRange('bytes=0-', 0), { kind: 'unsatisfiable' })
  assert.deepEqual(parseRange('bytes=-1', 0), { kind: 'unsatisfiable' })
})

test('多区间不支持，按无 Range 处理返回整文件', () => {
  assert.deepEqual(parseRange('bytes=0-9,20-29', SIZE), { kind: 'none' })
})

test('语法不认识的按无 Range 处理', () => {
  assert.deepEqual(parseRange('items=0-9', SIZE), { kind: 'none' })
  assert.deepEqual(parseRange('bytes=abc-def', SIZE), { kind: 'none' })
})

test('首字节与末字节的边界', () => {
  assert.deepEqual(parseRange('bytes=0-0', SIZE), { kind: 'range', start: 0, end: 0 })
  assert.deepEqual(parseRange('bytes=999-999', SIZE), { kind: 'range', start: 999, end: 999 })
  assert.equal(rangeLength({ start: 999, end: 999 }), 1)
})
