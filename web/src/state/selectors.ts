// 纯派生函数：轴标文字、状态条文字、探针 app 子对象（09 §10）。

import type { AppState, CalibrationSource, ProductIndex, WsState } from './types.js'
import type { SignalViewState } from '../signal/viewStore.js'
import { spectrumGeomOf } from '../signal/viewport.js'

export const SOURCE_LABEL: Record<CalibrationSource, string> = { measured: '实测', paper: '论文', assumed: '假定', model: '模型' }

/**
 * 纵轴文字。用户看到的只有 `dBm`（D-047 ④：来源徽标不给用户显示）；开发者模式带「标定：来源」。
 * 索引没有标定常数一律 `dBFS（未标定）`——包括写了 dBm 却没带 calibration 的索引（铁律 15，D-020）。
 */
export function scaleLabel(index: ProductIndex | null, dev: boolean): string | null {
  if (!index) return null
  if (index.scale === 'dBm' && index.calibration) {
    return dev ? `dBm · 标定：${SOURCE_LABEL[index.calibration.source] ?? index.calibration.source}` : 'dBm'
  }
  return 'dBFS（未标定）'
}

/**
 * 观测点产品的结果四态提示（09 §13.2「降级时图上叠一行原因」；铁律 15 不静默降级）。
 * `valid` 或没有索引时为 null；有原因就带上第一条，没有原因也要说出状态本身。
 */
export function productStateNote(index: ProductIndex | null): { text: string; tone: 'warn' | 'bad' | 'na' } | null {
  if (!index || index.state === 'valid') return null
  const label = index.state === 'degraded' ? '降级' : index.state === 'invalid' ? '无效' : '不适用'
  const tone = index.state === 'degraded' ? 'warn' : index.state === 'invalid' ? 'bad' : 'na'
  const reason = (index.state_reasons ?? []).find((r) => !!r)
  return { text: reason ? `${label}：${reason}` : label, tone }
}

export function timeBasis(s: AppState): { text: string; attr: string } {
  const t = s.task.dataRefs > 0 ? 'FileAcquisition' : 'LogicalSim'
  return { text: `WGS-84 · AGL · ${t}`, attr: `WGS-84 AGL ${t}` }
}

export function wsStatusText(ws: WsState): string {
  if (ws.status === 'connected') return `● 已连接 seq ${ws.lastSeq}`
  if (ws.status === 'reconnecting') return `● 重连中（第 ${ws.attempt} 次，${Math.round(ws.nextRetryMs / 1000)} s 后）`
  return '● 已断开'
}

export interface ProbeExtras {
  mapInstanceId: number
  rows: number
  cols: number
  peakBin: number | null
  /** 信号页外部 store 的快照（U-3）；信号页尚未挂载时为 null */
  signalView?: SignalViewState | null
  /** 开发者模式的长任务计数（PerformanceObserver longtask） */
  longTasks?: { count: number; maxMs: number } | null
}

function probeMarkers(s: AppState, v: SignalViewState | null | undefined): Array<{ id: string; freq_Hz: number | null; level_dB: number | null }> {
  return s.signal.markers.map((m) => {
    if (m.id === 'M1') return { id: 'M1', freq_Hz: v?.m1?.f ?? m.freq_Hz, level_dB: v?.m1?.v ?? null }
    return { id: m.id, freq_Hz: m.freq_Hz, level_dB: v?.m2Level ?? null }
  })
}

export function probeApp(s: AppState, x: ProbeExtras) {
  const index = s.signal.index
  const v = x.signalView ?? null
  const geom = index ? spectrumGeomOf(index) : null
  return {
    view: s.ui.view,
    context: {
      projectId: s.context.projectId, experimentId: s.context.experimentId, scenarioId: s.context.scenarioId,
      diagramId: s.context.diagramId, taskId: s.context.taskId, seed: s.context.seed, mode: s.context.mode,
    },
    task: {
      runState: s.task.runState, result: s.task.result, t_s: s.task.t_s, duration_s: s.task.duration_s,
      realtimeFactor: s.task.realtimeFactor, resultProvisional: s.task.resultProvisional, lastSeq: s.task.lastSeq,
    },
    ws: { status: s.ws.status, lastSeq: s.ws.lastSeq, reconnects: s.ws.reconnects, dropped: s.ws.dropped },
    drawer: { open: s.ui.drawer.open, tab: s.ui.drawer.tab },
    unsaved: { scene: s.scene.dirty, diagram: s.diagram.dirty },
    undo: {
      scene: { depth: s.scene.undo.past.length, redo: s.scene.undo.future.length },
      diagram: { depth: s.diagram.undo.past.length, redo: s.diagram.undo.future.length },
    },
    links: [] as { id: string; los: boolean; distance_m: number; pathLoss_dB: number }[],
    signal: {
      opId: s.signal.opId,
      viewport: s.signal.viewport,
      rows: Math.max(index?.rows_available ?? 0, x.rows),
      cols: index?.row_len ?? x.cols,
      peakBin: x.peakBin,
      scaleLabel: scaleLabel(index, s.ui.devMode),
      calibration: s.signal.display.calibration,
      waterfallNewestRow: 'top' as const,
      markers: probeMarkers(s, v),
      mode: v?.mode ?? (s.signal.follow ? 'follow' : 'browse'),
      follow: s.signal.follow,
      cursor_t_s: s.signal.cursor_t_s,
      stat: s.signal.viewport.stat,
      trace: s.signal.display.trace,
      geom: geom ? { nfft: geom.nfft, bw: geom.bw, dt: geom.dt, center_Hz: index?.center_Hz ?? 0, t0_s: index?.t0_s ?? 0 } : null,
      lastFetch: v?.lastFetch
        ? {
            rows: v.lastFetch.spec.rows, cols: v.lastFetch.spec.cols, px: v.lastFetch.key.px, py: v.lastFetch.key.py,
            t0: v.lastFetch.spec.t0, t1: v.lastFetch.spec.t1, f0: v.lastFetch.spec.f0, f1: v.lastFetch.spec.f1,
            stat: v.lastFetch.key.stat, state: v.lastFetch.state, envRows: v.lastFetch.env?.rows ?? null,
          }
        : null,
      fetchStatus: v?.fetchStatus ?? 'idle',
      bounds: v?.bounds ?? { spectrum: null, waterfall: null },
      canvas: v ? { W: v.W, H: v.H, dpr: v.dpr } : null,
      drawnRows: v?.drawnRows ?? 0,
      hatchedRows: v?.hatchedRows ?? 0,
      liveFrames: v?.liveFrames ?? 0,
      liveRows: v?.liveRows ?? 0,
      shown: v?.shown ?? null,
      envelopeRows: s.signal.envelopeIndex?.rows_available ?? 0,
    },
    perf: s.ui.devMode ? { longTasks: x.longTasks ?? null } : null,
    badges: { noScene: !s.scene.summary },
    mapInstanceId: x.mapInstanceId,
  }
}

export type AppProbe = ReturnType<typeof probeApp>
