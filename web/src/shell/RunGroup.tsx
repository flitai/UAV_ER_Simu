// 运行组（09 §3.2）：运行 / 停止、逻辑时间与实时因子。场景页与结果页底部有全宽时间轴条（D-061），
// 那两页顶栏不再重复时间读数（D-062）；框图页与数据页没有时间轴，读数留在这里。

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
  const timelineShown = s.ui.view === 'scene' || s.ui.view === 'results'
  return (
    <div className="run-group">
      {live
        ? <button type="button" className="btn stop" data-action="stop" onClick={() => void stopTask(store)}>■ 停止</button>
        : <button type="button" className="btn run" data-action="run" disabled={!canRun} title={why || '校验并运行（Ctrl+Enter）'} onClick={() => void runDiagram(store)}>⏵ 运行</button>}
      {!timelineShown && <div className="run-time" title="仿真逻辑时间 / 总时长 × 实时倍率（离线仿真，不保证实时）">
        <span className="t">t {fmtSeconds(s.task.t_s)}</span>
        <span className="sep">/</span>
        <span>{s.task.duration_s > 0 ? fmtSeconds(s.task.duration_s) : '—'}</span>
        <span className="rtf">{fmtFactor(s.task.realtimeFactor)}</span>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      </div>}
    </div>
  )
}
