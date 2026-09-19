// 结果页「任务」页签的右栏（09 §7.1，U-4 / D-075）：选中那一行的摘要。
//
// 两条口径写在 taskRows.summaryRows 里（那里能单测）：选中的就是当前任务时不重复左栏
// 已有的四项（D-062）；框图哈希、场景哈希、引擎版本、退出码只在 ?dev=1（D-039、09 §9）。

import { useSyncExternalStore } from 'react'
import { resultBadge, stateBadge } from '../shell/badges.js'
import { useAppState } from '../state/store.js'
import { taskListStore, type TaskListState } from './taskListStore.js'
import { summaryRows } from './taskRows.js'

function useTaskListState(): TaskListState {
  return useSyncExternalStore(taskListStore.subscribe, taskListStore.get, taskListStore.get)
}

export function TaskSummary() {
  const st = useTaskListState()
  const s = useAppState()
  const rec = st.tasks.find((t) => t.task_id === st.selected) ?? null
  if (!rec) {
    return <div className="group" data-task-summary><h2>任务摘要</h2><div className="muted">点左边的一行看它的摘要</div></div>
  }
  const isCurrent = rec.task_id === s.task.id
  const rb = resultBadge(rec.run_state, rec.result)
  const rows = summaryRows(rec, isCurrent, s.ui.devMode)
  const metrics = rec.metrics_summary ?? []
  return (
    <div className="group" data-task-summary data-task-summary-id={rec.task_id}>
      <h2>任务摘要</h2>
      <div className="form-row pp-line">
        <span className="form-label">{rec.task_id}</span>
        <span className="form-value pp-ro">
          <span className={`badge result ${rb.tone}${rb.hollow ? ' hollow' : ''}`} data-result={rec.result}>{rb.glyph} {rb.text}{rb.suffix}</span>
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="form-row pp-line" data-summary-row={r.key} {...(r.dev ? { 'data-dev': 'task-trace' } : {})}>
          <span className="form-label">{r.label}</span><span className="form-value pp-ro">{r.value}</span>
        </div>
      ))}
      {rec.data_refs.length > 0 && (
        <div className="form-row pp-line" data-summary-row="data">
          <span className="form-label">实测数据</span>
          <span className="form-value pp-ro">{rec.data_refs.map((d) => `${d.data_id}${d.holdout ? '（验收集）' : ''}`).join('、')}</span>
        </div>
      )}
      {metrics.length > 0 && (
        <table className="site-table" data-task-metrics>
          <thead><tr><th>站</th><th>Pd</th><th>Pfa</th><th>F1</th><th>识别</th><th /></tr></thead>
          <tbody>
            {metrics.map((m) => {
              const b = stateBadge(m.state)
              return (
                <tr key={m.node_id}>
                  <td className="name">{m.site_id ?? m.node_id}</td>
                  {/* 分母为零时 metrics.json 里就是 null，照写「—」不当成 0（铁律 15，同 C-9 的 ROC） */}
                  <td className="num">{fmt(m.pd)}</td><td className="num">{fmt(m.pfa)}</td>
                  <td className="num">{fmt(m.f1)}</td><td className="num">{fmt(m.accuracy)}</td>
                  <td className="name"><span className={`badge result ${b.tone}`}>{b.glyph}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {rec.warnings.length > 0 && <ul className="pp-notes" data-task-warnings>{rec.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {rec.error && <div className="pp-notes bad" data-task-error-detail>{rec.error.code}：{rec.error.message}</div>}
      {rec.reasons.length > 0 && (
        rec.result === 'valid'
          ? <details className="form-details" data-task-summary-reasons><summary>引擎备注 {rec.reasons.length} 条</summary>
              <ul className="pp-notes">{rec.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></details>
          : <ul className="pp-notes bad" data-task-summary-reasons>{rec.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      )}
    </div>
  )
}

function fmt(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(3)
}
