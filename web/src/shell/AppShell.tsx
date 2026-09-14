// 应用壳：顶栏 + 视图区（三视图挂载后只隐藏不卸载；数据中心按需挂载）+ 底部抽屉 + 提示。
// 引导请求、快捷键、WS 流、索引轮询、探针注册与 beforeunload 都在这里接线（09 §2、§4、附录 A.2）。

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { installAppProbe, probeMapInstanceId } from '../scene/probe.js'
import { SceneView } from '../scene/SceneView.js'
import { situationSnapshot } from '../scene/sceneStore.js'
import { currentSituation } from '../scene/situationView.js'
import { timelineMarkers } from './timelineOps.js'
import { Timeline } from './Timeline.js'
import { timeStore } from './timeStore.js'
import { buildSiteCards, buildTargetCards, probeCards, probeSiteCards } from '../scene/cards/derive.js'
import { ChainView } from '../chain/ChainView.js'
import { ResultsView } from '../results/ResultsView.js'
import { detectionStore, probeDetections } from '../results/detectionStore.js'
import { probeRecognitions, recognitionStore } from '../results/recognitionStore.js'
import { metricsStore, probeMetrics } from '../results/metricsStore.js'
import { probeTruth, truthStore, visibleTruth } from '../results/truthStore.js'
import { probeTimeline3, timeline3 } from '../results/timeline3.js'
import { focusSite, visibleSegments } from '../results/detectionStore.js'
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
  // 隐藏用 visibility 而不是 display：地图容器尺寸不能归零，瀑布画布也要在隐藏期继续累积（09 §4.2、D-048）。
  //
  // 只有 visibility 还不够，`opacity: 0` 是一道兜底：visibility 虽然继承，后代却可以把自己改回
  // visible。这一条是 React Flow 逼出来的（它量完节点尺寸就在每个节点上写行内 visibility: visible，
  // 于是框图节点穿透隐藏浮到场景地图上）；画布已随 D-060 删掉，兜底保留——
  // opacity 在祖先上后代无法覆盖，代价为零，而下一个这么干的第三方件不会提前打招呼。
  // inert 让隐藏页的输入框接不到快捷键。
  return (
    <section className="view" data-view={id} data-active={active}
      style={{ visibility: active ? 'visible' : 'hidden', opacity: active ? undefined : 0 }}
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
      // 框图的规范文本。探针里的 diagram 只给节点数与连线数，读不到参数；
      // 端到端要核对「传播参数写进了 scn、没写进 ch」这类事就得看原文（D-058）。
      diagramText: () => store.getState().diagram.text,
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
      // 探针看到的态势 = 画面上的那一帧：live 是最新，回放是时间轴 t 处（13 §5.5）
      ...situationSnapshot(currentSituation(st.scene.scenario.doc)),
      cards: probeCards(buildTargetCards(st.scene.scenario.doc, currentSituation(st.scene.scenario.doc))),
      siteCards: probeSiteCards(buildSiteCards(st.scene.scenario.doc, currentSituation(st.scene.scenario.doc))),
      timeline: { ...timeStore.get(), markers: timelineMarkers(st).length, source: currentSituation(st.scene.scenario.doc).source },
      detections: probeDetections(detectionStore.get()),
      recognitions: probeRecognitions(recognitionStore.get()),
      metrics: probeMetrics(metricsStore.get()),
      truth: probeTruth(truthStore.get()),
      // 时间线三行算的是焦点站那一份，与画面上看到的完全同一条路径（results/timeline3.ts）
      timeline3: (() => {
        const d = detectionStore.get()
        const site = focusSite(d)
        return probeTimeline3(timeline3(site, visibleTruth(truthStore.get(), site), visibleSegments(d), recognitionStore.get().rows))
      })(),
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
        {visited.has('diagram') && (
          <ViewHost id="diagram" active={view === 'diagram'}>
            {/* 框图页只有一种形态：典型链路视图（C-7，D-051；自由画布已由 D-060 删掉）。 */}
            <ChainView />
          </ViewHost>
        )}
        {visited.has('results') && <ViewHost id="results" active={view === 'results'}><ResultsView /></ViewHost>}
        {view === 'data' && <ViewHost id="data" active><DataCenter /></ViewHost>}
      </div>
      <Timeline />
      <Drawer />
      <Toasts />
    </div>
  )
}
