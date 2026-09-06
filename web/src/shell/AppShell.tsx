// 应用壳：顶栏 + 视图区（三视图挂载后只隐藏不卸载；数据中心按需挂载）+ 底部抽屉 + 提示。
// 引导请求、快捷键、WS 流、索引轮询、探针注册与 beforeunload 都在这里接线（09 §2、§4、附录 A.2）。

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { installAppProbe, probeMapInstanceId } from '../scene/probe.js'
import { SceneView } from '../scene/SceneView.js'
import { DiagramJsonView } from '../diagram/DiagramJsonView.js'
import { ResultsView } from '../results/ResultsView.js'
import { DataCenter } from '../data/DataCenter.js'
import { peakBinOf, signalBuffer } from '../signal/buffer.js'
import { signalHooks, viewStore } from '../signal/viewStore.js'
import { installLongTaskCounter, type LongTaskCounter } from './longTasks.js'
import { probeApp } from '../state/selectors.js'
import { useAppState, useStore } from '../state/store.js'
import type { View } from '../state/types.js'
import { Drawer } from './Drawer.js'
import { Router } from './Router.js'
import { Toasts } from './Toasts.js'
import { TopBar } from './TopBar.js'
import { bootstrap } from './actions.js'
import { loadLayout, saveLayout } from './layout.js'
import { useHotkeys } from './useHotkeys.js'
import { useProductIndex } from './useProductIndex.js'
import { useTaskStream } from './useTaskStream.js'

function ViewHost({ id, active, children }: { id: View; active: boolean; children: ReactNode }) {
  // visibility 而不是 display：地图容器尺寸不能归零（09 §4.2）；inert 让隐藏页的输入框接不到快捷键
  return (
    <section className="view" data-view={id} data-active={active} style={{ visibility: active ? 'visible' : 'hidden' }}
      // @ts-expect-error React 19 支持 inert 布尔属性
      inert={active ? undefined : ''}>
      {children}
    </section>
  )
}

export function AppShell() {
  const s = useAppState()
  const store = useStore()
  useHotkeys()
  useTaskStream()
  useProductIndex()

  const [visited, setVisited] = useState<Set<View>>(() => new Set<View>(['scene', s.ui.view]))
  useEffect(() => {
    if (!visited.has(s.ui.view)) setVisited((v) => new Set(v).add(s.ui.view))
  }, [s.ui.view, visited])

  useEffect(() => {
    let alive = true
    store.dispatch({ type: 'ui/layout', layout: loadLayout(window.innerWidth) })
    void bootstrap(store, () => alive)
    return () => { alive = false }
  }, [store])

  useEffect(() => {
    const t = setTimeout(() => saveLayout(s.ui.layout), 300)
    return () => clearTimeout(t)
  }, [s.ui.layout])

  const longTasks = useRef<LongTaskCounter | null>(null)
  useEffect(() => {
    if (!s.ui.devMode) return
    longTasks.current = installLongTaskCounter()
    window.__cuav = {
      ...(window.__cuav ?? { ws: { dropForTest: () => false, state: () => null } }),
      signal: {
        zoomTo: (vp) => store.dispatch({ type: 'signal/viewport', viewport: vp }),
        reset: () => store.dispatch({ type: 'signal/follow', on: true }),
        csv: () => signalHooks.csv?.() ?? null,
      },
      perf: { reset: () => longTasks.current?.reset() },
    }
    return () => { longTasks.current?.dispose(); longTasks.current = null }
  }, [s.ui.devMode, store])

  useEffect(() => installAppProbe(() => {
    const st = store.getState()
    const op = st.signal.opId
    return probeApp(st, {
      mapInstanceId: probeMapInstanceId(),
      rows: signalBuffer.rows(op, 'spectrum'),
      cols: signalBuffer.cols(op, 'spectrum'),
      peakBin: peakBinOf(signalBuffer.latestRow(op, 'spectrum')),
      signalView: viewStore.get(),
      longTasks: longTasks.current?.snapshot() ?? null,
    })
  }), [store])

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const st = store.getState()
      if (st.scene.dirty || st.diagram.dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [store])

  const view = s.ui.view
  return (
    <div className="app" data-dev-mode={s.ui.devMode ? '1' : undefined}>
      <Router />
      <TopBar />
      <div className="views">
        <ViewHost id="scene" active={view === 'scene'}><SceneView active={view === 'scene'} /></ViewHost>
        {visited.has('diagram') && <ViewHost id="diagram" active={view === 'diagram'}><DiagramJsonView /></ViewHost>}
        {visited.has('results') && <ViewHost id="results" active={view === 'results'}><ResultsView /></ViewHost>}
        {view === 'data' && <ViewHost id="data" active><DataCenter /></ViewHost>}
      </div>
      <Drawer />
      <Toasts />
    </div>
  )
}
