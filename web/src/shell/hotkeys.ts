// 快捷键映射（09 §11）。按 e.code 匹配数字键：macOS 上 Option+2 的 e.key 是 ™。
// Chromium 保留键（Ctrl+1…9、Ctrl+Tab、Ctrl+W/T/N、F5/F11/F12）一律不绑定，这里对它们返回 null。

export type Hotkey =
  | 'view:scene' | 'view:diagram' | 'view:results' | 'view:data' | 'save' | 'run' | 'escape' | 'drawer'
  | 'signal:marker' | 'signal:markerDelete' | 'signal:cursorPrev' | 'signal:cursorNext' | 'signal:cursorPrev10' | 'signal:cursorNext10'
  | 'timeline:play' | 'timeline:home' | 'timeline:end'

/** 信号页快捷键的上下文：焦点在输入框时不响应；只在结果视图信号页生效（09 §11）。 */
export interface HotkeyContext { editable: boolean; signalActive: boolean; /** 时间轴可见（场景页或结果页，D-061） */ timelineActive?: boolean }

export interface KeyLike { code: string; key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

const VIEW_BY_DIGIT: Record<string, Hotkey> = {
  Digit1: 'view:scene', Digit2: 'view:diagram', Digit3: 'view:results', Digit4: 'view:data',
}

export function mapHotkey(e: KeyLike, ctx?: HotkeyContext): Hotkey | null {
  const mod = e.ctrlKey || e.metaKey
  if (e.altKey && !mod && !e.shiftKey && VIEW_BY_DIGIT[e.code]) return VIEW_BY_DIGIT[e.code]!
  if (ctx?.signalActive && !ctx.editable && !mod && !e.altKey) {
    if (e.code === 'KeyM' && !e.shiftKey) return 'signal:marker'
    if ((e.code === 'Delete' || e.code === 'Backspace') && !e.shiftKey) return 'signal:markerDelete'
    if (e.code === 'ArrowLeft') return e.shiftKey ? 'signal:cursorPrev10' : 'signal:cursorPrev'
    if (e.code === 'ArrowRight') return e.shiftKey ? 'signal:cursorNext10' : 'signal:cursorNext'
  }
  if (ctx?.timelineActive && !ctx.editable && !mod && !e.altKey && !e.shiftKey) {
    if (e.code === 'Space') return 'timeline:play'
    if (e.code === 'Home') return 'timeline:home'
    if (e.code === 'End') return 'timeline:end'
  }
  if (mod && !e.altKey && !e.shiftKey) {
    if (e.code === 'KeyS') return 'save'
    if (e.code === 'Enter' || e.code === 'NumpadEnter') return 'run'
    if (e.code === 'Backquote') return 'drawer'
    return null
  }
  if (!mod && !e.altKey && e.code === 'Escape') return 'escape'
  return null
}
