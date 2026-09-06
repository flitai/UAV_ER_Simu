// 信号视图（U-3，09 §7.1–§7.2）：页头 → 读数栏 → 频谱（上）→ 瀑布 + 包络条 + 色带（下）→ 页脚。
// 画布由 SignalRenderer 绘制；本组件只管布局、尺寸、可见性与指针事件的转发。

import { useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { useAppState, useStore } from '../state/store.js'
import { signalBuffer } from './buffer.js'
import { downloadBlob } from './export.js'
import { MarkerBar } from './MarkerBar.js'
import { SignalHead } from './SignalHead.js'
import { SignalRenderer } from './renderer.js'
import { fmtInt } from '../shell/format.js'
import { spectrumGeomOf } from './viewport.js'
import { signalHooks, viewStore } from './viewStore.js'

type Which = 'spectrum' | 'waterfall'

export function SignalView() {
  const s = useAppState()
  const store = useStore()
  const rendererRef = useRef<SignalRenderer | null>(null)
  if (!rendererRef.current) rendererRef.current = new SignalRenderer(store)
  const r = rendererRef.current
  const wrapRef = useRef<HTMLDivElement>(null)
  const specRef = useRef<HTMLCanvasElement>(null)
  const wfRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ which: Which; mode: 'box' | 'pan'; x: number; y: number; acc: { dx: number; dy: number }; raf: number | null } | null>(null)
  const v = useSyncExternalStore(viewStore.subscribe, viewStore.get, viewStore.get)
  const active = s.ui.view === 'results' && s.ui.resultsTab === 'signal'

  useEffect(() => {
    const spec = specRef.current
    const wf = wfRef.current
    const wrap = wrapRef.current
    if (!spec || !wf || !wrap) return
    r.attach(spec, wf)
    const ro = new ResizeObserver(() => r.resize())
    ro.observe(wrap)
    // DPR 变化（跨屏拖动）：matchMedia 只报一次，换新查询再挂
    let mq: MediaQueryList | null = null
    const watchDpr = () => {
      mq?.removeEventListener('change', onDpr)
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mq.addEventListener('change', onDpr)
    }
    const onDpr = () => { r.resize(); watchDpr() }
    watchDpr()
    // wheel 必须非被动才能 preventDefault，React 的 onWheel 做不到
    const onWheel = (which: Which) => (e: WheelEvent) => {
      e.preventDefault()
      const el = which === 'spectrum' ? spec : wf
      const rc = el.getBoundingClientRect()
      r.wheel(e.clientX - rc.left, e.clientY - rc.top, e.deltaY, e.shiftKey, which)
    }
    const ws = onWheel('spectrum')
    const ww = onWheel('waterfall')
    spec.addEventListener('wheel', ws, { passive: false })
    wf.addEventListener('wheel', ww, { passive: false })
    return () => {
      ro.disconnect()
      mq?.removeEventListener('change', onDpr)
      spec.removeEventListener('wheel', ws)
      wf.removeEventListener('wheel', ww)
      r.detach()
    }
  }, [r])

  useEffect(() => { r.setVisible(active) }, [r, active])
  useEffect(() => { r.onStore() }, [r, s.signal, s.task.id, s.task.runState, s.task.observationPoints])
  useEffect(() => signalBuffer.subscribe(() => r.onBuffer()), [r])
  useEffect(() => () => r.dispose(), [r])

  const rel = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rc = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rc.left, y: e.clientY - rc.top }
  }
  const onDown = (which: Which) => (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    const { x, y } = rel(e)
    const mode = e.button === 1 || e.altKey ? 'pan' : 'box'
    drag.current = { which, mode, x, y, acc: { dx: 0, dy: 0 }, raf: null }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (mode === 'box') r.boxStart(x, y, which)
    e.preventDefault()
  }
  const onMove = (which: Which) => (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = rel(e)
    const d = drag.current
    if (d && d.which === which) {
      if (d.mode === 'box') { r.boxMove(x, y); return }
      d.acc.dx += x - d.x
      d.acc.dy += y - d.y
      d.x = x
      d.y = y
      if (d.raf === null) d.raf = requestAnimationFrame(() => { d.raf = null; const a = d.acc; d.acc = { dx: 0, dy: 0 }; r.pan(a.dx, a.dy, which) })
      return
    }
    if (which === 'spectrum') r.hoverSpectrum(x)
    else r.hoverWaterfall(x, y)
  }
  const onUp = (which: Which) => (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d || d.which !== which) return
    drag.current = null
    const { x, y } = rel(e)
    if (d.mode === 'box') r.boxEnd(x, y)
    else if (d.raf !== null) { cancelAnimationFrame(d.raf); r.pan(d.acc.dx, d.acc.dy, which) }
  }
  const onLeave = (which: Which) => () => { if (which === 'spectrum') r.hoverSpectrum(null); else r.hoverWaterfall(null, null) }

  const exportPng = async () => {
    const out = await signalHooks.png?.()
    if (out) downloadBlob(out.name, out.blob)
    else store.dispatch({ type: 'ui/toast', kind: 'warn', text: '还没有可导出的画面' })
  }
  const exportCsv = () => {
    const out = signalHooks.csv?.()
    if (out) downloadBlob(out.name, new Blob([out.text], { type: 'text/csv;charset=utf-8' }))
    else store.dispatch({ type: 'ui/toast', kind: 'warn', text: '还没有可导出的数据' })
  }

  const geom = s.signal.index ? spectrumGeomOf(s.signal.index) : null
  const growing = v.mode === 'browse' && s.task.runState === 'running' && geom && v.shown && v.shown.t1 >= geom.rowsAvail * geom.dt
  let status = ''
  if (v.mode === 'follow') status = `已收 ${fmtInt(v.liveRows)} 行${v.hatchedRows > 0 ? `，丢 ${fmtInt(v.hatchedRows)} 行` : ''}`
  else if (v.fetchStatus === 'pending' || v.fetchStatus === 'inflight') status = '重取中…'
  else if (v.fetchStatus === 'waiting' || v.fetchStatus === 'error') status = v.fetchDetail ?? ''
  else if (v.lastFetch) status = `${fmtInt(v.lastFetch.spec.rows)} × ${fmtInt(v.lastFetch.spec.cols)}${growing ? ' · 数据仍在增长' : ''}`

  return (
    <div className="signal-view" ref={wrapRef} data-signal-mode={v.mode}>
      <SignalHead />
      <MarkerBar />
      <canvas ref={specRef} className="signal-spectrum" data-signal-canvas="spectrum"
        onPointerDown={onDown('spectrum')} onPointerMove={onMove('spectrum')} onPointerUp={onUp('spectrum')} onPointerLeave={onLeave('spectrum')}
        onDoubleClick={() => r.doubleClick()} />
      <canvas ref={wfRef} className="signal-waterfall" data-signal-canvas="waterfall"
        onPointerDown={onDown('waterfall')} onPointerMove={onMove('waterfall')} onPointerUp={onUp('waterfall')} onPointerLeave={onLeave('waterfall')}
        onDoubleClick={() => r.doubleClick()} />
      <div className="signal-foot">
        <label><input type="checkbox" checked={s.signal.follow} onChange={(e) => store.dispatch({ type: 'signal/follow', on: e.target.checked })} data-signal-follow /> 跟随实时</label>
        <span className="muted" data-signal-status>{status}</span>
        <span className="spacer" />
        <button type="button" onClick={() => void exportPng()} data-action="export-png">导出 PNG</button>
        <button type="button" onClick={exportCsv} data-action="export-csv">导出 CSV</button>
      </div>
    </div>
  )
}
