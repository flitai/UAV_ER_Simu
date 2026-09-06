// 运行组（09 §3.2）：运行 / 停止、逻辑时间与实时因子；结束后同位置是静态读数（时间游标随 U-3）。

import { useAppState, useStore } from '../state/store.js'
import { runDiagram, stopTask } from './actions.js'
import { fmtFactor, fmtSeconds } from './format.js'

export function RunGroup() {
  const s = useAppState()
  const store = useStore()
  const live = s.task.runState === 'queued' || s.task.runState === 'running'
  const canRun = s.components.status === 'ok' && s.server.engineAvailable !== false && !!s.diagram.json && !live
  const why = s.components.status !== 'ok' ? '组件目录不可用（引擎未就绪）'
    : s.server.engineAvailable === false ? '引擎不可用'
    : !s.diagram.json ? (s.diagram.parseError ?? '框图为空') : ''
  const pct = s.task.duration_s > 0 ? Math.min(100, (s.task.t_s / s.task.duration_s) * 100) : 0
  return (
    <div className="run-group">
      {live
        ? <button type="button" className="btn stop" data-action="stop" onClick={() => void stopTask(store)}>■ 停止</button>
        : <button type="button" className="btn run" data-action="run" disabled={!canRun} title={why || '校验并运行（Ctrl+Enter）'} onClick={() => void runDiagram(store)}>⏵ 运行</button>}
      <div className="run-time" title="逻辑时间 / 总时长 × 实时因子（不承诺实时，04 §12.1）">
        <span className="t">t {fmtSeconds(s.task.t_s)}</span>
        <span className="sep">/</span>
        <span>{s.task.duration_s > 0 ? fmtSeconds(s.task.duration_s) : '—'}</span>
        <span className="rtf">{fmtFactor(s.task.realtimeFactor)}</span>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      </div>
    </div>
  )
}
