// 鼠标经纬度走独立的小外部 store（useSyncExternalStore），不进主 store：每秒十次的 mousemove
// 不该让整棵界面树重渲染。

import type { Cursor } from '../state/types.js'

let cursor: Cursor | null = null
const subs = new Set<() => void>()

export const cursorStore = {
  get: () => cursor,
  set(c: Cursor | null) { cursor = c; for (const f of subs) f() },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f) } },
}
