// 结果视图（09 §7.1）：信号 / 检测 / 任务三页签。切片 ① 只有信号页签的页头（U-3 画频谱与瀑布）。

import { ColumnLayout } from '../shell/ColumnLayout.js'
import { resultBadge, runStateGlyph } from '../shell/badges.js'
import { SignalPlaceholder } from '../signal/SignalPlaceholder.js'
import { useAppState, useDispatch } from '../state/store.js'
import type { ResultsTab } from '../state/types.js'

const TABS: Array<{ id: ResultsTab; label: string }> = [{ id: 'signal', label: '信号' }, { id: 'detections', label: '检测' }, { id: 'tasks', label: '任务' }]

export function ResultsView() {
  const s = useAppState()
  const dispatch = useDispatch()
  const rg = runStateGlyph(s.task.runState)
  const rb = resultBadge(s.task.runState, s.task.result)
  return (
    <ColumnLayout
      left={<>
        <div className="group">
          <h2>任务</h2>
          <div className="task-line"><span className="task-id">{s.task.id ?? '无任务'}</span> <span className="badge run">{rg.glyph}</span> <span className={`badge result ${rb.tone}${rb.hollow ? ' hollow' : ''}`}>{rb.glyph} {rb.text}{rb.suffix}</span></div>
          {s.task.name && <div className="muted">{s.task.name}</div>}
        </div>
        <div className="group">
          <h2>观测点</h2>
          {s.task.observationPoints.length === 0 && <div className="muted">无</div>}
          <ul className="op-list">
            {s.task.observationPoints.map((o) => (
              <li key={o.op_id} className={o.op_id === s.signal.opId ? 'on' : ''}>
                <button type="button" onClick={() => dispatch({ type: 'signal/selectOp', opId: o.op_id })}>
                  <b>{o.op_id}</b> <span className="muted">{o.node}.{o.port} · {o.products.join(' / ')}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </>}
      center={
        <div className="results">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" data-results-tab={t.id} className={s.ui.resultsTab === t.id ? 'on' : ''}
                onClick={() => dispatch({ type: 'ui/resultsTab', tab: t.id })}>{t.label}</button>
            ))}
          </div>
          {s.ui.resultsTab === 'signal' && <SignalPlaceholder />}
          {s.ui.resultsTab === 'detections' && <div className="placeholder">检测（U-4 启用）</div>}
          {s.ui.resultsTab === 'tasks' && <div className="placeholder">任务列表（U-4 启用）</div>}
        </div>
      }
      right={<div className="group placeholder">仪表与视窗控制（U-3）</div>}
    />
  )
}
