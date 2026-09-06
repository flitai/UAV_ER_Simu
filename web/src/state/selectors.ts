// 纯派生函数：轴标文字、状态条文字、探针 app 子对象（09 §10）。

import type { AppState, CalibrationSource, ProductIndex, WsState } from './types.js'

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
}

export function probeApp(s: AppState, x: ProbeExtras) {
  const index = s.signal.index
  return {
    view: s.ui.view,
    context: {
      projectId: s.context.projectId, experimentId: s.context.experimentId, scenarioId: s.context.scenarioId,
      diagramId: s.context.diagramId, taskId: s.context.taskId, seed: s.context.seed, mode: s.context.mode,
    },
    task: {
      runState: s.task.runState, result: s.task.result, t_s: s.task.t_s, duration_s: s.task.duration_s,
      realtimeFactor: s.task.realtimeFactor,
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
      markers: [] as { id: string; freq_Hz: number; level_dB: number }[],
    },
    badges: { noScene: !s.scene.summary },
    mapInstanceId: x.mapInstanceId,
  }
}

export type AppProbe = ReturnType<typeof probeApp>
