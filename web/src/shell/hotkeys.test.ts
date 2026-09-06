import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapHotkey } from './hotkeys.js'

const k = (code: string, o: Partial<{ key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
  ({ code, key: o.key ?? code, altKey: !!o.altKey, ctrlKey: !!o.ctrlKey, metaKey: !!o.metaKey, shiftKey: !!o.shiftKey })

test('Alt+数字切视图，按 code 不按 key（macOS Option+2 的 key 是 ™）', () => {
  assert.equal(mapHotkey(k('Digit1', { altKey: true, key: '¡' })), 'view:scene')
  assert.equal(mapHotkey(k('Digit2', { altKey: true, key: '™' })), 'view:diagram')
  assert.equal(mapHotkey(k('Digit3', { altKey: true })), 'view:results')
  assert.equal(mapHotkey(k('Digit4', { altKey: true })), 'view:data')
  assert.equal(mapHotkey(k('Digit5', { altKey: true })), null)
})

test('Ctrl/Meta 组合与 Esc', () => {
  assert.equal(mapHotkey(k('KeyS', { ctrlKey: true })), 'save')
  assert.equal(mapHotkey(k('KeyS', { metaKey: true })), 'save')
  assert.equal(mapHotkey(k('Enter', { ctrlKey: true })), 'run')
  assert.equal(mapHotkey(k('Backquote', { ctrlKey: true })), 'drawer')
  assert.equal(mapHotkey(k('Escape')), 'escape')
})

test('Chromium 保留键一律不绑定', () => {
  assert.equal(mapHotkey(k('Digit2', { ctrlKey: true })), null)
  assert.equal(mapHotkey(k('Tab', { ctrlKey: true })), null)
  assert.equal(mapHotkey(k('KeyW', { ctrlKey: true })), null)
  assert.equal(mapHotkey(k('KeyT', { ctrlKey: true })), null)
  assert.equal(mapHotkey(k('KeyN', { ctrlKey: true })), null)
  for (const f of ['F5', 'F11', 'F12']) assert.equal(mapHotkey(k(f)), null)
  assert.equal(mapHotkey(k('Digit2', { altKey: true, shiftKey: true })), null)
})

test('信号页键：M / Delete / Backspace / ←→（Shift 十帧）只在信号页且焦点不在输入框时生效', () => {
  const on = { editable: false, signalActive: true }
  assert.equal(mapHotkey(k('KeyM'), on), 'signal:marker')
  assert.equal(mapHotkey(k('Delete'), on), 'signal:markerDelete')
  assert.equal(mapHotkey(k('Backspace'), on), 'signal:markerDelete')
  assert.equal(mapHotkey(k('ArrowLeft'), on), 'signal:cursorPrev')
  assert.equal(mapHotkey(k('ArrowRight', { shiftKey: true }), on), 'signal:cursorNext10')
  assert.equal(mapHotkey(k('ArrowLeft', { shiftKey: true }), on), 'signal:cursorPrev10')
  assert.equal(mapHotkey(k('KeyM'), { editable: true, signalActive: true }), null)
  assert.equal(mapHotkey(k('KeyM'), { editable: false, signalActive: false }), null)
  assert.equal(mapHotkey(k('KeyM')), null)
  assert.equal(mapHotkey(k('KeyM', { ctrlKey: true }), on), null)
  assert.equal(mapHotkey(k('Escape'), on), 'escape')
})
