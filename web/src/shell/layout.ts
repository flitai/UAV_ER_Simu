// 栏宽与抽屉高度只存浏览器本地（09 §2）。localStorage 可能不可用或被清空，读写都包 try/catch。

import { defaultLayout } from '../state/reducer.js'
import type { AppState } from '../state/types.js'

const KEY = 'cuav.layout.v1'
export const MIN_LEFT = 220
export const MIN_RIGHT = 260
export const MIN_DRAWER = 120

export function loadLayout(innerWidth: number): AppState['ui']['layout'] {
  const d = defaultLayout(innerWidth)
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return d
    const j = JSON.parse(raw) as Partial<AppState['ui']['layout']>
    return {
      leftW: typeof j.leftW === 'number' && j.leftW >= MIN_LEFT ? j.leftW : d.leftW,
      rightW: typeof j.rightW === 'number' && j.rightW >= MIN_RIGHT ? j.rightW : d.rightW,
      drawerH: typeof j.drawerH === 'number' && j.drawerH >= MIN_DRAWER ? j.drawerH : d.drawerH,
    }
  } catch { return d }
}

export function saveLayout(l: AppState['ui']['layout']): void {
  try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* 私密模式或配额：忽略 */ }
}
