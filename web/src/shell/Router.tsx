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
    }
    if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/scene`)
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [dispatch])
  useEffect(() => {
    // 只在解析出的路由与状态不一致时才写 hash：首次渲染的状态已按 hash 初始化（App.tsx），
    // 否则挂载时会用初始状态把地址栏里的 #/results 覆盖成 #/scene
    const cur = parseHash(location.hash)
    if (cur.view === s.ui.view && cur.resultsTab === s.ui.resultsTab) return
    location.hash = formatHash({ view: s.ui.view, resultsTab: s.ui.resultsTab })
  }, [s.ui.view, s.ui.resultsTab])
  return null
}
