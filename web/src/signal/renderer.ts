// 信号页渲染器（U-3）：不依赖 React 的引擎——持有离屏瀑布画布、迹线状态、视窗请求器与交互几何；
// React 组件只提供画布元素并转发指针事件（09 §7.2；D-048）。
//
// 两种模式：跟随（环里最近 H 行，1 行 = 1 设备像素行，频率全带，位移追加）与回看（B-7 抽取的矩阵整窗画）。
// 两种模式的像素列归约同式（reduce.ts / waterfall.ts），量程共用 [ref − range, ref]。
// 主 store 只存视窗、仪表设置与元信息；高频量与 Float32 结果在 viewStore（09 附录 A.1）。

import { getEnvelopeWindow, getSpectrumWindow } from '../api/client.js'
import { fmtDb, fmtHz, fmtSeconds } from '../shell/format.js'
import { productStateNote, scaleLabel } from '../state/selectors.js'
import type { StoreApi } from '../state/store.js'
import type { AppState } from '../state/types.js'
import { signalBuffer } from './buffer.js'
import { buildLut, dbToIndex, hexToRgb, type Rgb } from './colormap.js'
import { bucketIndexForTime, envelopeRange, envelopeToDb, envelopeUnit, groupForPixelRows } from './envelopeMap.js'
import { composeExportPng, csvFromWindow, exportFilename } from './export.js'
import { WindowFetcher, type FetchKey, type WindowData } from './fetcher.js'
import { reduceSpectrum, type Extract } from './reduce.js'
import { autoRange, niceTicks } from './scale.js'
import { TraceState, peakOf } from './trace.js'
import { TERMINAL } from '../state/reducer.js'
import { signalHooks, viewStore } from './viewStore.js'
import {
  FLOOR_DB, boxToViewport, clampViewport, colEdgeHz, envelopeGeomOf, fullWindow, groupBounds, liveWindow, panSpan,
  planSpectrumQuery, spectrumGeomOf, srcIndexForPixel, yToTime, zoomSpan, type SpectrumGeom, type Viewport,
} from './viewport.js'
import { buildLiveRows, buildWindowImage, planShift } from './waterfall.js'

/** 画布内的固定留白（CSS 像素）：左 = 轴标，右 = 包络条 + 色带 + 色带标签。频谱与瀑布同一套，故列像素对齐。 */
export const GUT_L = 56
export const ENV_W = 72
export const BAR_W = 14
export const LABEL_W = 44
export const GAP = 6
export const GUT_R = ENV_W + GAP + BAR_W + GAP + LABEL_W
export const SPEC_TOP = 10
export const SPEC_BOTTOM = 22

/** 与 app.css 的 :root 色表同值（D-017：壳的配色从 Airports 的 PM 色表取）。 */
const C = {
  paper: '#f4f1ec', earth: '#faf8f5', ink: '#48423a', dim: '#7b7367', poi: '#8b8173', border: '#ddd7cd', white: '#ffffff',
  bound: '#c3bcb2', warn: '#b8860b', bad: '#a33333', water: '#5d87a3', trace: '#2f5d7c', band: '#c9d9e4',
}
const INK: Rgb = hexToRgb(C.ink)
const PAPER: Rgb = hexToRgb(C.paper)
const FONT = '11px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'

type Which = 'spectrum' | 'waterfall'

interface Shown { t0: number; t1: number; f0: number; f1: number }

function keyString(k: FetchKey): string {
  return `${k.task}|${k.op}|${k.t0}|${k.t1}|${k.f0}|${k.f1}|${k.px}|${k.py}|${k.stat}|${k.envPx}`
}

function toExtract(w: WindowData): Extract {
  return { data: w.data, rows: w.meta.rows, cols: w.meta.cols, t0: w.meta.t0, t1: w.meta.t1, f0: w.meta.f0, f1: w.meta.f1 }
}

export class SignalRenderer {
  private spec: HTMLCanvasElement | null = null
  private wf: HTMLCanvasElement | null = null
  private offA: HTMLCanvasElement = document.createElement('canvas')
  private offB: HTMLCanvasElement = document.createElement('canvas')
  private readonly lut = buildLut()
  private readonly trace = new TraceState()
  private readonly fetcher: WindowFetcher
  private visible = false
  private raf: number | null = null
  private needFull = true
  private prevNewest = -1
  private traceUpTo = -1
  private hatched = 0
  private mode: 'follow' | 'browse' = 'follow'
  private lo = -140
  private hi = -40
  private scaleInit = false
  private lastTask: string | null = null
  private lastOp: string | null = null
  private browseImageKey = ''
  private browseTraceKey = ''
  private box: { x0: number; y0: number; x1: number; y1: number; which: Which } | null = null
  private shown: Shown | null = null
  private envDt: number | null = null
  private envUnit: 'dBm' | 'dBFS' = 'dBFS'
  /** 设备像素尺寸（瀑布绘图区） */
  private W = 0
  private H = 0
  private dpr = 1
  private cssW = 0
  private cssHSpec = 0
  private cssHWf = 0
  /** 已对哪个任务做过「结束即转回看」 */
  private finalizedTask: string | null = null

  constructor(private readonly store: StoreApi) {
    this.fetcher = new WindowFetcher({
      spectrum: (t, o, q, sig) => getSpectrumWindow(t, o, q, sig),
      envelope: (t, o, q, sig) => getEnvelopeWindow(t, o, q, sig),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onResult: (key, spec, env) => this.onFetchResult(key, spec, env),
      onStatus: (s, d) => viewStore.patch({ fetchStatus: s, fetchDetail: d ?? null }),
      onLog: (level, message) => store.dispatch({ type: 'log/client', level, message }),
    })
    signalHooks.csv = () => this.csv()
    signalHooks.png = () => this.png()
    signalHooks.clearHold = () => this.clearHold()
  }

  attach(spec: HTMLCanvasElement, wf: HTMLCanvasElement): void {
    this.spec = spec
    this.wf = wf
    this.needFull = true
    this.resize()
  }

  detach(): void {
    this.spec = null
    this.wf = null
    viewStore.patch({ bounds: { spectrum: null, waterfall: null } })
  }

  dispose(): void {
    this.detach()
    this.fetcher.cancel()
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    if (signalHooks.csv && signalHooks.csv === this.csvHook) signalHooks.csv = null
  }
  private csvHook = () => this.csv()

  setVisible(v: boolean): void {
    if (v === this.visible) return
    this.visible = v
    if (v) { this.needFull = true; this.resize() }
  }

  /** 按 CSS 尺寸与 DPR 重设画布背景尺寸；绘图区尺寸变了就全画。 */
  resize(): void {
    if (!this.spec || !this.wf) return
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const rs = this.spec.getBoundingClientRect()
    const rw = this.wf.getBoundingClientRect()
    const cssW = Math.floor(Math.max(rs.width, rw.width))
    const hs = Math.floor(rs.height)
    const hw = Math.floor(rw.height)
    if (cssW <= 0 || hw <= 0) return
    const W = Math.max(1, Math.round((cssW - GUT_L - GUT_R) * dpr))
    const H = Math.max(1, Math.round(hw * dpr))
    const changed = W !== this.W || H !== this.H || dpr !== this.dpr || cssW !== this.cssW || hs !== this.cssHSpec
    this.W = W; this.H = H; this.dpr = dpr; this.cssW = cssW; this.cssHSpec = hs; this.cssHWf = hw
    const size = (c: HTMLCanvasElement, h: number) => {
      const bw = Math.round(cssW * dpr)
      const bh = Math.round(h * dpr)
      if (c.width !== bw) c.width = bw
      if (c.height !== bh) c.height = bh
    }
    size(this.spec, hs)
    size(this.wf, hw)
    if (this.offA.width !== W || this.offA.height !== H) { this.offA.width = W; this.offA.height = H; this.offB.width = W; this.offB.height = H; this.needFull = true }
    if (changed) this.needFull = true
    const x0 = Math.round((rw.left + GUT_L) * 100) / 100
    const x1 = Math.round((rw.left + cssW - GUT_R) * 100) / 100
    const sx0 = Math.round((rs.left + GUT_L) * 100) / 100
    const sx1 = Math.round((rs.left + cssW - GUT_R) * 100) / 100
    viewStore.patch({ W, H, dpr, bounds: { spectrum: [sx0, sx1], waterfall: [x0, x1] } })
    this.schedule()
  }

  onStore(): void { this.schedule() }
  onBuffer(): void { this.schedule() }

  private schedule(): void {
    if (this.raf !== null) return
    this.raf = requestAnimationFrame(() => { this.raf = null; this.render() })
  }

  // ---------- 主循环 ----------

  private render(): void {
    const s = this.store.getState()
    const dev = s.ui.devMode
    if (dev) performance.mark('cuav-render-0')
    try { this.renderInner(s) } finally { if (dev) performance.measure('signal.render', 'cuav-render-0') }
  }

  private renderInner(s: AppState): void {
    const sig = s.signal
    const task = s.task.id
    const op = sig.opId
    if (task !== this.lastTask || op !== this.lastOp) {
      this.lastTask = task
      this.lastOp = op
      this.trace.reset()
      this.prevNewest = -1
      this.traceUpTo = -1
      this.hatched = 0
      this.needFull = true
      this.scaleInit = false
      this.browseImageKey = ''
      this.browseTraceKey = ''
      this.shown = null
      this.finalizedTask = null
      this.fetcher.cancel()
      viewStore.patch({ lastFetch: null, drawnRows: 0, hatchedRows: 0, m1: null, m2Level: null, shown: null, envRange: null, liveRows: 0, hover: null })
    }
    if (!this.visible || !this.spec || !this.wf || this.W === 0) return
    const index = sig.index
    const geom = index ? spectrumGeomOf(index) : null
    if (!index || !geom || !task || !op) { this.drawWaiting('等待产品索引…'); return }
    this.trace.configure(sig.display.trace, sig.display.avgN)
    const envIdx = sig.envelopeIndex
    const eg = envIdx ? envelopeGeomOf(envIdx) : null
    this.envDt = eg ? eg.dt : null
    this.envUnit = envelopeUnit(envIdx?.scale)
    if (sig.follow) {
      this.renderFollow(s, geom, op)
      // 任务到终态且索引收尾：把当前画面转成回看窗口重取。服务端在突发下会丢行帧（D-044），
      // 环里的尾部与缺口只有文件才完整；结束后的画面从 B-7 补齐，丢行斜纹随之消失（D-048）。
      // 三个条件缺一不可：索引自己的 run_state 已终态且收尾（任务事件先于最后一次索引到达时，index_final 可能只是
      // 某次 64 行刷新的巧合）；本地已折叠到流里的结束事件（resultProvisional = false）——订阅应答会先把运行态标成
      // finished，那时回放的行帧还没到，环是空的，此时收口会把空画面当成终态画面（U-3 e2e 实测到的竞态）
      if (TERMINAL.has(index.run_state) && index.index_final && !s.task.resultProvisional && this.finalizedTask !== task && this.shown) {
        this.finalizedTask = task
        const t1 = Math.max(this.shown.t1, geom.rowsAvail * geom.dt)
        const t0 = Math.max(0, t1 - this.H * geom.dt)
        this.store.dispatch({ type: 'signal/viewport', viewport: { t0, t1, f0: this.shown.f0, f1: this.shown.f1 } })
      }
    } else {
      this.renderBrowse(s, geom, task, op)
    }
  }

  private ensureScale(display: AppState['signal']['display'], values: ArrayLike<number> | null): void {
    if (!display.auto) {
      const hi = display.refLevel_dB
      const lo = display.refLevel_dB - Math.max(1, display.range_dB)
      if (hi !== this.hi || lo !== this.lo) { this.hi = hi; this.lo = lo; this.needFull = true }
      this.scaleInit = true
      return
    }
    if (!values) return
    const r = autoRange(values)
    if (!r) return
    const lo = r.refLevel_dB - r.range_dB
    // 自动量程只扩不缩：新峰超过上限或新底噪低于下限 10 dB 才重算
    if (!this.scaleInit || r.refLevel_dB > this.hi || lo < this.lo - 10) {
      this.hi = r.refLevel_dB
      this.lo = lo
      this.scaleInit = true
      this.needFull = true
      const st = this.store.getState().signal.display
      if (st.refLevel_dB !== this.hi || st.range_dB !== this.hi - this.lo) {
        this.store.dispatch({ type: 'signal/display', patch: { refLevel_dB: this.hi, range_dB: this.hi - this.lo } })
      }
    }
  }

  private renderFollow(s: AppState, geom: SpectrumGeom, op: string): void {
    const sig = s.signal
    if (this.mode !== 'follow') {
      this.mode = 'follow'
      this.fetcher.cancel()
      this.trace.reset()
      this.traceUpTo = -1
      this.prevNewest = -1
      this.needFull = true
      this.browseTraceKey = ''
    }
    const newest = signalBuffer.newestRowIndex(op, 'spectrum')
    const rows = signalBuffer.rows(op, 'spectrum')
    const src = { rowByIndex: (i: number) => signalBuffer.rowByIndex(op, 'spectrum', i) }
    // 迹线：把新到的行按序推入（有限于环里还在的行）
    if (newest >= 0) {
      const oldest = signalBuffer.rowIndexAt(op, 'spectrum', rows - 1)
      let from = Math.max(this.traceUpTo + 1, oldest)
      if (this.trace.mode === 'single') from = newest
      for (let i = from; i <= newest; i++) { const r = src.rowByIndex(i); if (r) this.trace.push(r) }
      this.traceUpTo = newest
    }
    const tv = this.trace.value()
    this.ensureScale(sig.display, tv)
    const cols = Math.min(this.W, geom.nfft)
    const cb = groupBounds(geom.nfft, cols)
    const paint = { W: this.W, lo: this.lo, hi: this.hi, lut: this.lut, stat: sig.viewport.stat, colLo: 0, cb, ink: INK, paper: PAPER }
    const plan = this.needFull ? { kind: 'full' as const } : planShift(this.prevNewest, newest, this.H)
    const ctxA = this.offA.getContext('2d')!
    let drawn = viewStore.get().drawnRows
    if (plan.kind === 'full') {
      const r = buildLiveRows(src, newest - this.H + 1, newest, paint)
      ctxA.putImageData(new ImageData(r.img, this.W, r.rows), 0, 0)
      this.hatched = r.hatched
      drawn = r.rows - r.blank
      this.needFull = false
    } else if (plan.kind === 'shift') {
      const k = plan.k
      const ctxB = this.offB.getContext('2d')!
      ctxB.drawImage(this.offA, 0, 0, this.W, this.H - k, 0, k, this.W, this.H - k)
      const r = buildLiveRows(src, newest - k + 1, newest, paint)
      ctxB.putImageData(new ImageData(r.img, this.W, r.rows), 0, 0)
      const t = this.offA; this.offA = this.offB; this.offB = t
      this.hatched += r.hatched
      drawn = Math.min(this.H, drawn + k)
    }
    this.prevNewest = newest
    const win = liveWindow(newest, this.H, geom.dt)
    this.shown = { t0: win.t0, t1: win.t1, f0: colEdgeHz(0, geom.bw, geom.nfft), f1: colEdgeHz(geom.nfft, geom.bw, geom.nfft) }
    viewStore.patch({ mode: 'follow', shown: this.shown, drawnRows: drawn, hatchedRows: this.hatched, liveRows: rows, liveFrames: viewStore.get().liveFrames + (plan.kind === 'none' ? 0 : 1) })
    this.compose(s, geom, tv, op)
  }

  private renderBrowse(s: AppState, geom: SpectrumGeom, task: string, op: string): void {
    const sig = s.signal
    if (this.mode !== 'browse') { this.mode = 'browse'; this.needFull = true; this.browseImageKey = '' }
    const req = planSpectrumQuery(clampViewport(sig.viewport, geom), this.W, this.H, geom)
    const wantEnv = !!sig.envelopeIndex && s.task.observationPoints.some((o) => o.op_id === op && o.products.includes('envelope'))
    const key: FetchKey = { task, op, t0: req.t0, t1: req.t1, f0: req.f0, f1: req.f1, px: req.px, py: req.py, stat: req.stat, envPx: wantEnv ? this.H : 0 }
    this.fetcher.request(key)
    const lf = viewStore.get().lastFetch
    if (!lf || lf.key.task !== task || lf.key.op !== op) {
      viewStore.patch({ mode: 'browse' })
      this.drawWaiting(viewStore.get().fetchDetail ?? '重取中…')
      return
    }
    this.ensureScale(sig.display, lf.spec.data)
    const imgKey = `${keyString(lf.key)}|${this.lo}|${this.hi}`
    if (this.needFull || imgKey !== this.browseImageKey) {
      const img = buildWindowImage(lf.spec, this.W, this.H, this.lo, this.hi, this.lut, PAPER)
      this.offA.getContext('2d')!.putImageData(new ImageData(img, this.W, this.H), 0, 0)
      this.browseImageKey = imgKey
      this.needFull = false
    }
    this.shown = { t0: lf.spec.t0, t1: lf.spec.t1, f0: lf.spec.f0 ?? sig.viewport.f0, f1: lf.spec.f1 ?? sig.viewport.f1 }
    // 迹线：游标所在行（缺省最新行）；平均 / 保持模式覆盖整窗
    const rowsN = lf.spec.rows
    let r = rowsN - 1
    if (sig.cursor_t_s !== null && rowsN > 0 && lf.spec.t1 > lf.spec.t0) {
      r = Math.max(0, Math.min(rowsN - 1, Math.floor(((sig.cursor_t_s - lf.spec.t0) / (lf.spec.t1 - lf.spec.t0)) * rowsN)))
    }
    const traceKey = `${imgKey}|${this.trace.mode}|${this.trace.n}|${r}`
    if (traceKey !== this.browseTraceKey) {
      this.trace.reset()
      const rowAt = (i: number) => lf.spec.data.subarray(i * lf.spec.cols, (i + 1) * lf.spec.cols)
      if (rowsN > 0) {
        if (this.trace.mode === 'single') this.trace.push(rowAt(r))
        else for (let i = 0; i < rowsN; i++) this.trace.push(rowAt(i))
      }
      this.browseTraceKey = traceKey
    }
    viewStore.patch({ mode: 'browse', shown: this.shown, drawnRows: Math.min(this.H, rowsN), hatchedRows: 0, liveRows: signalBuffer.rows(op, 'spectrum') })
    this.compose(s, geom, this.trace.value(), op)
  }

  private onFetchResult(key: FetchKey, spec: WindowData, env: WindowData | null): void {
    viewStore.patch({ lastFetch: { key, spec: toExtract(spec), env: env ? toExtract(env) : null, state: spec.meta.state, meta: spec.meta } })
    this.needFull = true
    this.schedule()
  }

  // ---------- 合成上屏 ----------

  private compose(s: AppState, geom: SpectrumGeom, tv: Float32Array | null, op: string): void {
    const sig = s.signal
    const shown = this.shown
    if (!shown || !sig.index) return
    const center = sig.index.center_Hz
    const t0s = sig.index.t0_s
    const span = shown.f1 - shown.f0
    const cols = tv ? tv.length : 0
    // marker
    let m1: { k: number; f: number; v: number } | null = null
    const pk = peakOf(tv)
    if (pk && cols > 0) m1 = { k: pk.k, f: center + shown.f0 + ((pk.k + 0.5) / cols) * span, v: pk.v }
    let m2Level: number | null = null
    const m2 = sig.markers.find((m) => m.id === 'M2')
    if (m2 && m2.freq_Hz !== null && tv && cols > 0 && span > 0) {
      const k = Math.floor(((m2.freq_Hz - center - shown.f0) / span) * cols)
      if (k >= 0 && k < cols) m2Level = tv[k]!
    }
    viewStore.patch({ m1, m2Level })
    this.drawSpectrum(s, geom, tv, shown, center, m1, m2 ?? null, m2Level)
    this.drawWaterfall(s, shown, center, t0s, m1, m2 ?? null, op)
  }

  private plotRect(which: Which): { x0: number; x1: number; y0: number; y1: number } {
    const x0 = GUT_L
    const x1 = this.cssW - GUT_R
    if (which === 'spectrum') return { x0, x1, y0: SPEC_TOP, y1: this.cssHSpec - SPEC_BOTTOM }
    return { x0, x1, y0: 0, y1: this.cssHWf }
  }

  private drawWaiting(text: string): void {
    for (const c of [this.spec, this.wf]) {
      if (!c) continue
      const ctx = c.getContext('2d')!
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.fillStyle = C.earth
      ctx.fillRect(0, 0, c.width / this.dpr, c.height / this.dpr)
    }
    const ctx = this.wf?.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = C.poi
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, this.cssW / 2, this.cssHWf / 2)
  }

  private freqLabel(fRel: number, center: number, axis: 'rf' | 'offset'): string {
    if (axis === 'rf') return fmtHz(center + fRel)
    return `${fRel >= 0 ? '+' : '−'}${fmtHz(Math.abs(fRel))}`
  }

  private drawSpectrum(
    s: AppState, geom: SpectrumGeom, tv: Float32Array | null, shown: Shown, center: number,
    m1: { k: number; f: number; v: number } | null, m2: { freq_Hz: number | null } | null, m2Level: number | null,
  ): void {
    const c = this.spec!
    const ctx = c.getContext('2d')!
    const dpr = this.dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const { x0, x1, y0, y1 } = this.plotRect('spectrum')
    const pw = x1 - x0
    const ph = y1 - y0
    ctx.fillStyle = C.earth
    ctx.fillRect(0, 0, this.cssW, this.cssHSpec)
    ctx.fillStyle = C.white
    ctx.fillRect(x0, y0, pw, ph)
    ctx.font = FONT
    const lo = this.lo
    const hi = this.hi
    const yOf = (v: number) => y1 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * ph
    const xOfRel = (f: number) => x0 + ((f - shown.f0) / (shown.f1 - shown.f0)) * pw
    // dB 网格与轴标
    ctx.strokeStyle = C.border
    ctx.lineWidth = 1
    ctx.fillStyle = C.dim
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const t of niceTicks(lo, hi, Math.max(2, Math.floor(ph / 32)))) {
      const y = Math.round(yOf(t)) + 0.5
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke()
      ctx.fillText(String(t), x0 - 6, y)
    }
    // 频率网格与轴标（共用轴，画在频谱下方）
    const axis = s.signal.display.freqAxis
    const fa = axis === 'rf' ? center + shown.f0 : shown.f0
    const fb = axis === 'rf' ? center + shown.f1 : shown.f1
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const t of niceTicks(fa, fb, Math.max(2, Math.floor(pw / 120)))) {
      const rel = axis === 'rf' ? t - center : t
      const x = Math.round(xOfRel(rel)) + 0.5
      ctx.strokeStyle = C.border
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke()
      ctx.fillStyle = C.dim
      ctx.fillText(this.freqLabel(rel, center, axis), x, y1 + 5)
    }
    ctx.textAlign = 'right'
    ctx.fillStyle = C.dim
    ctx.fillText(`RBW ${fmtHz(geom.bw)}`, x1, y1 + 5)
    // 单位与迹线说明（右侧留白）
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = C.ink
    const unit = scaleLabel(s.signal.index, false) ?? ''
    ctx.fillText(unit, x1 + GAP, y0)
    ctx.fillStyle = C.dim
    const tr = s.signal.display.trace
    const trText = tr === 'single' ? '单帧' : tr === 'avg' ? `平均 ${this.trace.frames}/${this.trace.n} 帧` : tr === 'maxhold' ? '最大保持' : '最小保持'
    ctx.fillText(trText, x1 + GAP, y0 + 16)
    ctx.fillText(s.signal.viewport.stat === 'max' ? '统计 max' : s.signal.viewport.stat === 'mean' ? '统计 mean' : '统计 min', x1 + GAP, y0 + 32)
    // 迹线
    if (tv && tv.length > 0) {
      const cols = tv.length
      ctx.save()
      ctx.beginPath()
      ctx.rect(x0, y0, pw, ph)
      ctx.clip()
      ctx.strokeStyle = C.trace
      ctx.lineWidth = 1.2
      ctx.beginPath()
      for (let k = 0; k < cols; k++) {
        const x = x0 + ((k + 0.5) / cols) * pw
        const v = tv[k]!
        const y = yOf(v > FLOOR_DB ? v : lo)
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()
    }
    // marker 与悬停
    const drawMarker = (fAbs: number, color: string, label: string, level: number | null) => {
      const x = Math.round(xOfRel(fAbs - center)) + 0.5
      if (x < x0 || x > x1) return
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color
      ctx.textAlign = x > x1 - 60 ? 'right' : 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(level === null ? label : `${label} ${fmtDb(level, '')}`.trim(), x + (x > x1 - 60 ? -4 : 4), y0 + 2)
      if (level !== null) { ctx.beginPath(); ctx.arc(x, yOf(level), 3, 0, Math.PI * 2); ctx.fill() }
    }
    if (m1) drawMarker(m1.f, C.warn, 'M1', m1.v)
    if (m2 && m2.freq_Hz !== null) drawMarker(m2.freq_Hz, C.bad, 'M2', m2Level)
    const hv = viewStore.get().hover
    if (hv) {
      const x = Math.round(xOfRel(hv.f - center)) + 0.5
      if (x >= x0 && x <= x1) {
        ctx.strokeStyle = C.poi
        ctx.setLineDash([2, 4])
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke()
        ctx.setLineDash([])
      }
    }
    // 框选（频率方向）
    if (this.box && this.box.which === 'spectrum') {
      ctx.fillStyle = 'rgba(93, 135, 163, 0.18)'
      ctx.fillRect(Math.min(this.box.x0, this.box.x1), y0, Math.abs(this.box.x1 - this.box.x0), ph)
    }
    ctx.strokeStyle = C.bound
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1)
  }

  private drawWaterfall(
    s: AppState, shown: Shown, center: number, t0s: number,
    m1: { f: number } | null, m2: { freq_Hz: number | null } | null, op: string,
  ): void {
    const c = this.wf!
    const ctx = c.getContext('2d')!
    const dpr = this.dpr
    const { x0, x1, y0, y1 } = this.plotRect('waterfall')
    const pw = x1 - x0
    const ph = y1 - y0
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = C.earth
    ctx.fillRect(0, 0, c.width, c.height)
    // 瀑布图像（设备像素 1:1）
    ctx.drawImage(this.offA, Math.round(x0 * dpr), Math.round(y0 * dpr))
    // 包络条与色带（设备像素）
    this.drawEnvelopeStrip(ctx, shown, op)
    this.drawColorBar(ctx)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = FONT
    // 时间轴（绝对秒 = t0_s + 相对）
    ctx.fillStyle = C.dim
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = C.bound
    const tspan = shown.t1 - shown.t0
    if (tspan > 0) {
      for (const t of niceTicks(t0s + shown.t0, t0s + shown.t1, Math.max(2, Math.floor(ph / 48)))) {
        const y = Math.round(y0 + ((shown.t1 - (t - t0s)) / tspan) * ph) + 0.5
        if (y < y0 || y > y1) continue
        ctx.beginPath(); ctx.moveTo(x0 - 4, y); ctx.lineTo(x0, y); ctx.stroke()
        ctx.fillText(fmtSeconds(t), x0 - 6, y)
      }
    }
    // marker 竖线（与频谱同 x）
    const xOfRel = (f: number) => x0 + ((f - shown.f0) / (shown.f1 - shown.f0)) * pw
    const vline = (fAbs: number, color: string) => {
      const x = Math.round(xOfRel(fAbs - center)) + 0.5
      if (x < x0 || x > x1) return
      ctx.strokeStyle = color
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke()
      ctx.setLineDash([])
    }
    if (m1) vline(m1.f, C.warn)
    if (m2 && m2.freq_Hz !== null) vline(m2.freq_Hz, C.bad)
    // 时间游标：贯穿瀑布与包络条的同一条横线
    const cur = s.signal.cursor_t_s
    if (cur !== null && tspan > 0 && cur >= shown.t0 && cur <= shown.t1) {
      const y = Math.round(y0 + ((shown.t1 - cur) / tspan) * ph) + 0.5
      ctx.strokeStyle = C.warn
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1 + GAP + ENV_W, y); ctx.stroke()
      ctx.fillStyle = C.warn
      ctx.textAlign = 'right'
      ctx.textBaseline = 'bottom'
      ctx.fillText(`t ${fmtSeconds(t0s + cur)}`, x1 - 4, y - 2)
    }
    // 悬停十字与读数
    const hv = viewStore.get().hover
    if (hv && hv.t !== null && tspan > 0) {
      const x = Math.round(xOfRel(hv.f - center)) + 0.5
      const y = Math.round(y0 + ((shown.t1 - hv.t) / tspan) * ph) + 0.5
      ctx.strokeStyle = C.poi
      ctx.setLineDash([2, 4])
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke()
      ctx.setLineDash([])
      const text = `${fmtHz(hv.f)}  ${fmtSeconds(t0s + hv.t)}${hv.v !== null ? `  ${fmtDb(hv.v, '')}` : ''}`
      ctx.fillStyle = 'rgba(250, 248, 245, 0.9)'
      const tw = ctx.measureText(text).width + 8
      const bx = x + 8 + tw > x1 ? x - 8 - tw : x + 8
      const by = y + 18 > y1 ? y - 18 : y + 4
      ctx.fillRect(bx, by, tw, 14)
      ctx.fillStyle = C.ink
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(text, bx + 4, by + 1)
    }
    if (this.box && this.box.which === 'waterfall') {
      ctx.fillStyle = 'rgba(93, 135, 163, 0.18)'
      ctx.strokeStyle = C.water
      const bx = Math.min(this.box.x0, this.box.x1)
      const by = Math.min(this.box.y0, this.box.y1)
      ctx.fillRect(bx, by, Math.abs(this.box.x1 - this.box.x0), Math.abs(this.box.y1 - this.box.y0))
      ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(this.box.x1 - this.box.x0), Math.abs(this.box.y1 - this.box.y0))
    }
    // 降级原因：图上叠一行（09 §13.2），颜色随四态，形状 + 文字不只靠颜色
    const note = productStateNote(s.signal.index)
    if (note) {
      const color = note.tone === 'warn' ? C.warn : note.tone === 'bad' ? C.bad : C.poi
      const text = `${note.tone === 'bad' ? '✖' : note.tone === 'warn' ? '▲' : '—'} ${note.text}`
      const w = ctx.measureText(text).width + 12
      ctx.fillStyle = 'rgba(250, 248, 245, 0.92)'
      ctx.fillRect(x0 + 6, y0 + 6, w, 18)
      ctx.strokeStyle = color
      ctx.strokeRect(x0 + 6.5, y0 + 6.5, w - 1, 17)
      ctx.fillStyle = color
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x0 + 12, y0 + 15)
    }
    // 回看等待期：半透明蒙层
    const fs = viewStore.get().fetchStatus
    if (this.mode === 'browse' && (fs === 'pending' || fs === 'inflight' || fs === 'waiting')) {
      ctx.fillStyle = 'rgba(244, 241, 236, 0.45)'
      ctx.fillRect(x0, y0, pw, ph)
    }
    ctx.strokeStyle = C.bound
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1)
  }

  /** 包络竖条：与瀑布共时间轴，每个设备像素行一组；min–max 带浅色、rms 墨色。 */
  private drawEnvelopeStrip(ctx: CanvasRenderingContext2D, shown: Shown, op: string): void {
    const dpr = this.dpr
    const sx = Math.round((this.cssW - GUT_R + GAP) * dpr)
    const sw = Math.round(ENV_W * dpr)
    const H = this.H
    const rowsDb = new Float32Array(H * 3)
    const has = new Uint8Array(H)
    const raw = new Float32Array(H * 3)
    let n = 0
    if (this.envDt !== null) {
      if (this.mode === 'follow') {
        for (let y = 0; y < H; y++) {
          const t = yToTime(y + 0.5, H, shown.t0, shown.t1)
          const j = bucketIndexForTime(t, this.envDt)
          const r = signalBuffer.rowByIndex(op, 'envelope', j)
          if (!r) continue
          raw[y * 3] = r[0]!; raw[y * 3 + 1] = r[1]!; raw[y * 3 + 2] = r[2]!
          has[y] = 1; n++
        }
      } else {
        const env = viewStore.get().lastFetch?.env ?? null
        if (env && env.rows > 0) {
          const g = groupForPixelRows(env, this.envDt, shown, H)
          for (let y = 0; y < H; y++) {
            const j = g[y]!
            if (j < 0) continue
            raw[y * 3] = env.data[j * 3]!; raw[y * 3 + 1] = env.data[j * 3 + 1]!; raw[y * 3 + 2] = env.data[j * 3 + 2]!
            has[y] = 1; n++
          }
        }
      }
    }
    // 量程：只扩不缩
    const packed = new Float32Array(n * 3)
    let q = 0
    for (let y = 0; y < H; y++) if (has[y]) { packed[q * 3] = raw[y * 3]!; packed[q * 3 + 1] = raw[y * 3 + 1]!; packed[q * 3 + 2] = raw[y * 3 + 2]!; q++ }
    const rng = n > 0 ? envelopeRange(packed, n) : null
    const prev = viewStore.get().envRange
    const range = rng ? (prev ? { lo: Math.min(prev.lo, rng.lo), hi: Math.max(prev.hi, rng.hi) } : rng) : prev
    if (range && (!prev || prev.lo !== range.lo || prev.hi !== range.hi)) viewStore.patch({ envRange: range })
    const img = ctx.createImageData(sw, H)
    const d = img.data
    const paper = PAPER
    const band = hexToRgb(C.band)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < sw; x++) { const o = (y * sw + x) * 4; d[o] = paper[0]; d[o + 1] = paper[1]; d[o + 2] = paper[2]; d[o + 3] = 255 }
      if (!has[y] || !range) continue
      for (let k = 0; k < 3; k++) rowsDb[y * 3 + k] = envelopeToDb(raw[y * 3 + k]!)
      const map = (v: number) => Math.max(0, Math.min(sw - 1, Math.round(((v - range.lo) / (range.hi - range.lo)) * (sw - 1))))
      const a = map(rowsDb[y * 3]!)
      const b = map(rowsDb[y * 3 + 1]!)
      for (let x = Math.min(a, b); x <= Math.max(a, b); x++) { const o = (y * sw + x) * 4; d[o] = band[0]; d[o + 1] = band[1]; d[o + 2] = band[2] }
      const xr = map(rowsDb[y * 3 + 2]!)
      const o = (y * sw + xr) * 4
      d[o] = INK[0]; d[o + 1] = INK[1]; d[o + 2] = INK[2]
    }
    ctx.putImageData(img, sx, 0)
    // 标签
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = FONT
    ctx.fillStyle = 'rgba(250, 248, 245, 0.85)'
    ctx.fillRect(this.cssW - GUT_R + GAP, 0, ENV_W, 15)
    ctx.fillStyle = C.dim
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(`包络 ${n > 0 ? this.envUnit : ''}`, this.cssW - GUT_R + GAP + 2, 2)
    if (range) {
      ctx.fillStyle = 'rgba(250, 248, 245, 0.85)'
      ctx.fillRect(this.cssW - GUT_R + GAP, this.cssHWf - 15, ENV_W, 15)
      ctx.fillStyle = C.dim
      ctx.textBaseline = 'bottom'
      ctx.fillText(String(range.lo), this.cssW - GUT_R + GAP + 2, this.cssHWf - 1)
      ctx.textAlign = 'right'
      ctx.fillText(String(range.hi), this.cssW - GUT_R + GAP + ENV_W - 2, this.cssHWf - 1)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** 色带：竖向 LUT，上 = 参考电平，下 = 参考电平 − 动态范围；标签在右侧留白。 */
  private drawColorBar(ctx: CanvasRenderingContext2D): void {
    const dpr = this.dpr
    const bx = Math.round((this.cssW - GUT_R + GAP + ENV_W + GAP) * dpr)
    const bw = Math.round(BAR_W * dpr)
    const H = this.H
    const img = ctx.createImageData(bw, H)
    const d = img.data
    for (let y = 0; y < H; y++) {
      const idx = dbToIndex(this.hi - ((y + 0.5) / H) * (this.hi - this.lo), this.lo, this.hi) * 4
      for (let x = 0; x < bw; x++) { const o = (y * bw + x) * 4; d[o] = this.lut[idx]!; d[o + 1] = this.lut[idx + 1]!; d[o + 2] = this.lut[idx + 2]!; d[o + 3] = 255 }
    }
    ctx.putImageData(img, bx, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = FONT
    ctx.fillStyle = C.dim
    ctx.textAlign = 'left'
    const lx = this.cssW - GUT_R + GAP + ENV_W + GAP + BAR_W + 3
    ctx.textBaseline = 'top'
    ctx.fillText(String(this.hi), lx, 1)
    ctx.textBaseline = 'bottom'
    ctx.fillText(String(this.lo), lx, this.cssHWf - 1)
    ctx.textBaseline = 'middle'
    for (const t of niceTicks(this.lo, this.hi, Math.max(2, Math.floor(this.cssHWf / 60)))) {
      if (t === this.lo || t === this.hi) continue
      const y = ((this.hi - t) / (this.hi - this.lo)) * this.cssHWf
      if (y < 12 || y > this.cssHWf - 12) continue
      ctx.fillText(String(t), lx, y)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  // ---------- 交互（CSS 像素，相对画布左上角） ----------

  private geomNow(): { geom: SpectrumGeom; shown: Shown; index: NonNullable<AppState['signal']['index']> } | null {
    const s = this.store.getState()
    const index = s.signal.index
    const geom = index ? spectrumGeomOf(index) : null
    if (!index || !geom || !this.shown) return null
    return { geom, shown: this.shown, index }
  }

  private fAt(x: number): number | null {
    const g = this.geomNow()
    if (!g) return null
    const { x0, x1 } = this.plotRect('waterfall')
    if (x < x0 || x > x1) return null
    return g.shown.f0 + ((x - x0) / (x1 - x0)) * (g.shown.f1 - g.shown.f0)
  }

  private tAt(y: number): number | null {
    const g = this.geomNow()
    if (!g) return null
    const { y0, y1 } = this.plotRect('waterfall')
    if (y < y0 || y > y1) return null
    return yToTime(y - y0, y1 - y0, g.shown.t0, g.shown.t1)
  }

  hoverSpectrum(x: number | null): void {
    const g = this.geomNow()
    const fRel = x === null ? null : this.fAt(x)
    if (!g || fRel === null) { if (viewStore.get().hover) { viewStore.patch({ hover: null }); this.schedule() } return }
    const tv = this.trace.value()
    let v: number | null = null
    if (tv && tv.length > 0) {
      const k = Math.floor(((fRel - g.shown.f0) / (g.shown.f1 - g.shown.f0)) * tv.length)
      if (k >= 0 && k < tv.length) v = tv[k]!
    }
    viewStore.patch({ hover: { f: g.index.center_Hz + fRel, t: null, v } })
    this.schedule()
  }

  hoverWaterfall(x: number | null, y: number | null): void {
    const g = this.geomNow()
    const fRel = x === null ? null : this.fAt(x)
    const t = y === null ? null : this.tAt(y)
    if (!g || fRel === null || t === null) { if (viewStore.get().hover) { viewStore.patch({ hover: null }); this.schedule() } return }
    let v: number | null = null
    const { x0, x1, y0, y1 } = this.plotRect('waterfall')
    const xd = Math.floor(((x! - x0) / (x1 - x0)) * this.W)
    const yd = Math.floor(((y! - y0) / (y1 - y0)) * this.H)
    if (this.mode === 'follow') {
      const op = this.store.getState().signal.opId
      const newest = signalBuffer.newestRowIndex(op, 'spectrum')
      const row = signalBuffer.rowByIndex(op, 'spectrum', newest - yd)
      if (row) v = row[srcIndexForPixel(xd, row.length, this.W)]!
    } else {
      const lf = viewStore.get().lastFetch
      if (lf && lf.spec.rows > 0) {
        const r = lf.spec.rows - 1 - srcIndexForPixel(yd, lf.spec.rows, this.H)
        const c = srcIndexForPixel(xd, lf.spec.cols, this.W)
        if (c >= 0) v = lf.spec.data[r * lf.spec.cols + c]!
      }
    }
    viewStore.patch({ hover: { f: g.index.center_Hz + fRel, t, v } })
    this.schedule()
  }

  /** 单击：在该频率放 M2。 */
  clickAt(x: number): void {
    const g = this.geomNow()
    const fRel = this.fAt(x)
    if (!g || fRel === null) return
    this.store.dispatch({ type: 'signal/marker', id: 'M2', freq_Hz: g.index.center_Hz + fRel })
  }

  boxStart(x: number, y: number, which: Which): void { this.box = { x0: x, y0: y, x1: x, y1: y, which }; this.schedule() }
  boxMove(x: number, y: number): void { if (this.box) { this.box.x1 = x; this.box.y1 = y; this.schedule() } }

  /** 松开：框够大就缩放（瀑布时间 × 频率，频谱只频率），否则当作单击放 M2。 */
  boxEnd(x: number, y: number): void {
    const b = this.box
    this.box = null
    this.schedule()
    if (!b) return
    const g = this.geomNow()
    if (!g) return
    const dx = Math.abs(x - b.x0)
    const dy = Math.abs(y - b.y0)
    if (dx < 4 && (b.which === 'spectrum' || dy < 4)) { this.clickAt(x); return }
    const { x0, x1, y0, y1 } = this.plotRect('waterfall')
    const base: Viewport = { ...g.shown, stat: this.store.getState().signal.viewport.stat }
    if (b.which === 'spectrum') {
      const fa = this.fAt(Math.max(x0, Math.min(b.x0, x)))
      const fb = this.fAt(Math.min(x1, Math.max(b.x0, x)))
      if (fa === null || fb === null) return
      this.store.dispatch({ type: 'signal/viewport', viewport: { t0: base.t0, t1: base.t1, f0: fa, f1: fb } })
      return
    }
    const sx = (v: number) => ((Math.max(x0, Math.min(x1, v)) - x0) / (x1 - x0)) * this.W
    const sy = (v: number) => ((Math.max(y0, Math.min(y1, v)) - y0) / (y1 - y0)) * this.H
    const vp = boxToViewport(base, { x0: sx(b.x0), y0: sy(b.y0), x1: sx(x), y1: sy(y) }, this.W, this.H, g.geom)
    this.store.dispatch({ type: 'signal/viewport', viewport: vp })
  }

  /** 平移（CSS 像素位移）。 */
  pan(dx: number, dy: number, which: Which): void {
    const g = this.geomNow()
    if (!g) return
    const { x0, x1, y0, y1 } = this.plotRect('waterfall')
    const fspan = g.shown.f1 - g.shown.f0
    const tspan = g.shown.t1 - g.shown.t0
    const fb = { lo: colEdgeHz(0, g.geom.bw, g.geom.nfft), hi: colEdgeHz(g.geom.nfft, g.geom.bw, g.geom.nfft) }
    const tb = { lo: 0, hi: Math.max(1, g.geom.rowsAvail) * g.geom.dt }
    const f = panSpan({ lo: g.shown.f0, hi: g.shown.f1 }, (-dx / (x1 - x0)) * fspan, fb)
    const t = which === 'waterfall' ? panSpan({ lo: g.shown.t0, hi: g.shown.t1 }, (dy / (y1 - y0)) * tspan, tb) : { lo: g.shown.t0, hi: g.shown.t1 }
    this.store.dispatch({ type: 'signal/viewport', viewport: { t0: t.lo, t1: t.hi, f0: f.lo, f1: f.hi } })
  }

  /** 滚轮：瀑布上时间缩放，Shift 频率缩放；频谱上只频率。 */
  wheel(x: number, y: number, deltaY: number, shift: boolean, which: Which): void {
    const g = this.geomNow()
    if (!g) return
    const factor = deltaY > 0 ? 1.25 : 0.8
    const fb = { lo: colEdgeHz(0, g.geom.bw, g.geom.nfft), hi: colEdgeHz(g.geom.nfft, g.geom.bw, g.geom.nfft) }
    const tb = { lo: 0, hi: Math.max(1, g.geom.rowsAvail) * g.geom.dt }
    if (which === 'spectrum' || shift) {
      const fa = this.fAt(x) ?? (g.shown.f0 + g.shown.f1) / 2
      const f = zoomSpan({ lo: g.shown.f0, hi: g.shown.f1 }, fa, factor, g.geom.bw, fb)
      this.store.dispatch({ type: 'signal/viewport', viewport: { t0: g.shown.t0, t1: g.shown.t1, f0: f.lo, f1: f.hi } })
      return
    }
    const ta = this.tAt(y) ?? (g.shown.t0 + g.shown.t1) / 2
    const t = zoomSpan({ lo: g.shown.t0, hi: g.shown.t1 }, ta, factor, g.geom.dt, tb)
    this.store.dispatch({ type: 'signal/viewport', viewport: { t0: t.lo, t1: t.hi, f0: g.shown.f0, f1: g.shown.f1 } })
  }

  /** 双击：复位全窗（仍是回看）。 */
  doubleClick(): void {
    const g = this.geomNow()
    if (!g) return
    const vp = fullWindow(g.geom, this.store.getState().signal.viewport.stat)
    this.store.dispatch({ type: 'signal/viewport', viewport: vp })
  }

  clearHold(): void {
    this.trace.reset()
    this.traceUpTo = -1
    this.browseTraceKey = ''
    this.schedule()
  }

  // ---------- 导出 ----------

  csv(): { name: string; text: string } | null {
    const s = this.store.getState()
    const index = s.signal.index
    const task = s.task.id
    const op = s.signal.opId
    const geom = index ? spectrumGeomOf(index) : null
    if (!index || !geom || !task || !op || !this.shown) return null
    const unit = s.signal.display.unit
    let spec: Extract
    let env: Extract | null = null
    if (this.mode === 'browse') {
      const lf = viewStore.get().lastFetch
      if (!lf) return null
      spec = lf.spec
      env = lf.env
    } else {
      const floorRow = new Float32Array(geom.nfft).fill(FLOOR_DB)
      const rowAt = (i: number) => signalBuffer.rowByIndex(op, 'spectrum', i) ?? floorRow
      const cols = Math.min(this.W, geom.nfft)
      spec = reduceSpectrum(rowAt, { ...geom, rowsAvail: Math.max(geom.rowsAvail, signalBuffer.newestRowIndex(op, 'spectrum') + 1) },
        { t0: this.shown.t0, t1: this.shown.t1, f0: null, f1: null, px: cols, py: this.H, stat: s.signal.viewport.stat })
    }
    return { name: exportFilename('csv', task, op, index.t0_s + spec.t0, index.t0_s + spec.t1), text: csvFromWindow(spec, env, index, unit, this.envDt) }
  }

  async png(): Promise<{ name: string; blob: Blob } | null> {
    const s = this.store.getState()
    const task = s.task.id
    const op = s.signal.opId
    if (!this.spec || !this.wf || !task || !op || !this.shown || !s.signal.index) return null
    const t0 = s.signal.index.t0_s + this.shown.t0
    const t1 = s.signal.index.t0_s + this.shown.t1
    const title = `${task} · ${op} · ${fmtSeconds(t0)} – ${fmtSeconds(t1)} · ${fmtHz(s.signal.index.center_Hz + this.shown.f0)} – ${fmtHz(s.signal.index.center_Hz + this.shown.f1)} · ${scaleLabel(s.signal.index, false) ?? ''}`
    const blob = await composeExportPng(this.spec, this.wf, title, this.dpr)
    return blob ? { name: exportFilename('png', task, op, t0, t1), blob } : null
  }
}
