// hash ↔ ui.view 双向同步。相等就不写，避免 hashchange → dispatch → effect → hash 的环。

import { useEffect } from 'react'
import { useAppState, useDispatch } from '../state/store.js'
import { formatHash, parseHash } from './route.js'

export function Router() {
  const s = useAppState()
  const dispatch = useDispatch()
  useEffect(() => {
    const apply = () => {
      const r = parseHash(location.hash)
      dispatch({ type: 'ui/navigate', view: r.view, resultsTab: r.resultsTab })
      // 顺手把非规范的写法改回规范形式（D-060）。**必须在这里做**：下面那个 effect 只在
      // view / resultsTab 变化时才跑，而 `#/diagram` → `#/diagram/canvas` 这种同文档跳转
      // 解析出的视图没变、状态不动、组件不重渲染，那个 effect 一次也不会触发，
      // 地址栏就会一直挂着 `#/diagram/canvas`，冒充一个已经不存在的子形态。
      // 用 replaceState 不进历史栈：用户按后退键不该在两种写法之间跳。
      const want = formatHash(r)
      if (location.hash !== want) history.replaceState(null, '', `${location.pathname}${location.search}${want}`)
    }
    if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/scene`)
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [dispatch])
  useEffect(() => {
    // 只在地址栏里的写法与状态的规范写法不一致时才写：首次渲染的状态已按 hash 初始化（App.tsx），
    // 否则挂载时会用初始状态把地址栏里的 #/results 覆盖成 #/scene。
    //
    // 比的是**规范化之后的字符串**而不是解析结果，于是非规范的写法会被写回规范形式
    // ——`#/diagram/canvas` 这类旧地址解得开、落在框图页，但不该继续留在地址栏里
    // 冒充一个还存在的子形态（D-060）。规范形式与自身相等，所以照旧不会形成
    // hashchange → dispatch → effect → hash 的环。
    const want = formatHash({ view: s.ui.view, resultsTab: s.ui.resultsTab })
    if (location.hash === want) return
    const cur = parseHash(location.hash)
    if (cur.view !== s.ui.view || cur.resultsTab !== s.ui.resultsTab) { location.hash = want; return }
    // 解析一致、写法不一致：原地规范化，不进历史栈（用户按后退键不该在两种写法之间跳）
    history.replaceState(null, '', `${location.pathname}${location.search}${want}`)
  }, [s.ui.view, s.ui.resultsTab])
  return null
}
