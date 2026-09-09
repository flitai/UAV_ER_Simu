// 结果视图（09 §7.1）：信号 / 检测 / 任务三页签。切片 ① 有信号页签（U-3 频谱、瀑布、包络）；检测与任务页签留 U-4。

import { ColumnLayout } from '../shell/ColumnLayout.js'
import { resultBadge, runStateGlyph } from '../shell/badges.js'
import { InstrumentPanel } from '../signal/InstrumentPanel.js'
import { SignalView } from '../signal/SignalView.js'
import { useAppState, useDispatch } from '../state/store.js'
import { tapLabel } from '../chain/model.js'
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
                  <b>{tapLabel(o.op_id)}</b> <span className="muted">{o.node}.{o.port} · {o.products.join(' / ')}</span>
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
          {/* 观测点切换也放在中栏顶上：左栏可以收起，收起后就只剩这一处能换观测点
              ——原来只在左栏，收着栏的人会以为勾了观测点没生效（2026-09-08 用户反馈）。 */}
          {s.ui.resultsTab === 'signal' && s.task.observationPoints.length > 0 && (
            <div className="op-tabs" role="tablist" data-op-tabs>
              {s.task.observationPoints.map((o) => (
                <button key={o.op_id} type="button" role="tab" data-op-tab={o.op_id}
                  className={o.op_id === s.signal.opId ? 'on' : ''}
                  title={`${o.node}.${o.port} · ${o.products.join(' / ')}`}
                  onClick={() => dispatch({ type: 'signal/selectOp', opId: o.op_id })}>{tapLabel(o.op_id)}</button>
              ))}
            </div>
          )}
          {s.ui.resultsTab === 'signal' && <SignalView />}
          {s.ui.resultsTab === 'detections' && <div className="placeholder">检测（U-4 启用）</div>}
          {s.ui.resultsTab === 'tasks' && <div className="placeholder">任务列表（U-4 启用）</div>}
        </div>
      }
      right={s.ui.resultsTab === 'signal' ? <InstrumentPanel /> : <div className="group placeholder">（U-4 启用）</div>}
    />
  )
}
