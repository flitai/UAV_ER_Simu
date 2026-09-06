// 快捷键映射（09 §11）。按 e.code 匹配数字键：macOS 上 Option+2 的 e.key 是 ™。
// Chromium 保留键（Ctrl+1…9、Ctrl+Tab、Ctrl+W/T/N、F5/F11/F12）一律不绑定，这里对它们返回 null。

export type Hotkey = 'view:scene' | 'view:diagram' | 'view:results' | 'view:data' | 'save' | 'run' | 'escape' | 'drawer'

export interface KeyLike { code: string; key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

const VIEW_BY_DIGIT: Record<string, Hotkey> = {
  Digit1: 'view:scene', Digit2: 'view:diagram', Digit3: 'view:results', Digit4: 'view:data',
}

export function mapHotkey(e: KeyLike): Hotkey | null {
  const mod = e.ctrlKey || e.metaKey
  if (e.altKey && !mod && !e.shiftKey && VIEW_BY_DIGIT[e.code]) return VIEW_BY_DIGIT[e.code]!
  if (mod && !e.altKey && !e.shiftKey) {
    if (e.code === 'KeyS') return 'save'
    if (e.code === 'Enter' || e.code === 'NumpadEnter') return 'run'
    if (e.code === 'Backquote') return 'drawer'
    return null
  }
  if (!mod && !e.altKey && e.code === 'Escape') return 'escape'
  return null
}
