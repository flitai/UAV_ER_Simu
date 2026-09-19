// 结果页「任务」页签的中栏（09 §7.1，U-4 / D-075）：一页任务、选中看摘要、采用与取消两个动作。
//
// 行是服务端分页给的（941 个任务一页 100 条约 220 KB），页脚照实写共有多少、这是第几到第几
// ——列不全就说清，不假装列全（D-056 ②、D-068 ③ 同一条口径）。

import { useSyncExternalStore } from 'react'
import { resultBadge, runStateGlyph } from '../shell/badges.js'
import { useAppState, useStore } from '../state/store.js'
import { adoptTask } from '../shell/actions.js'
import { PAGE_SIZE, cancelRow, loadPage, taskListStore, type TaskListState } from './taskListStore.js'
import { canCancel, pageNote, taskRow } from './taskRows.js'

function useTaskListState(): TaskListState {
  return useSyncExternalStore(taskListStore.subscribe, taskListStore.get, taskListStore.get)
}

export function TaskList() {
  const st = useTaskListState()
  const s = useAppState()
  const store = useStore()
  const rows = st.tasks.map((r) => ({ rec: r, row: taskRow(r) }))
  const page = Math.floor(st.offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(st.total / PAGE_SIZE))

  return (
    <div className="task-panel" data-task-panel data-task-status={st.status}>
      <div className="det-head">
        <span data-task-note>{pageNote(st.total, st.offset, st.tasks.length)}</span>
        {st.error && <span className="bad" data-task-error>{st.error}</span>}
        <span className="spacer" />
        <span>第 {page} / {pages} 页</span>
        <button type="button" data-action="tasks-prev" disabled={st.offset <= 0}
          onClick={() => { void loadPage(Math.max(0, st.offset - PAGE_SIZE)) }}>上一页</button>
        <button type="button" data-action="tasks-next" disabled={st.offset + st.tasks.length >= st.total}
          onClick={() => { void loadPage(st.offset + PAGE_SIZE) }}>下一页</button>
      </div>
      <div className="site-table-wrap det-table-wrap">
        <table className="site-table det-table" data-task-table>
          <thead>
            <tr><th>时刻</th><th>实验</th><th>状态</th><th>场景</th><th>墙钟</th><th>评价</th><th>数据</th><th /></tr>
          </thead>
          <tbody>
            {rows.map(({ rec, row }) => {
              const rb = resultBadge(rec.run_state, rec.result)
              const rg = runStateGlyph(rec.run_state)
              const isCurrent = rec.task_id === s.task.id
              return (
                <tr key={row.id} data-task-row={row.id} data-task-current={isCurrent ? '1' : undefined}
                  className={(row.id === st.selected ? 'sel' : '') + (rec.result === 'degraded' ? ' degraded' : '')}
                  onClick={() => taskListStore.patch({ selected: row.id })}>
                  <td className="name">{row.when}</td>
                  <td className="name">{row.name}</td>
                  <td className="name">
                    <span className="badge run" data-run-state={rec.run_state} title={rg.label}>{rg.glyph} {rg.label}</span>{' '}
                    <span className={`badge result ${rb.tone}${rb.hollow ? ' hollow' : ''}`} data-result={rec.result}>{rb.glyph} {rb.text}{rb.suffix}</span>
                  </td>
                  <td className="name">{row.scenarioId}</td>
                  <td className="num">{row.wall}</td>
                  <td className="num">{row.metrics}</td>
                  {/* 用过验收集片段：只标事实两个字，不写解释句（D-056） */}
                  <td className="name">{row.holdout ? '验收集' : ''}</td>
                  <td className="name">
                    {!isCurrent && (
                      <button type="button" data-action="adopt-task" data-task-id={row.id}
                        onClick={(e) => { e.stopPropagation(); void adoptTask(store, rec, () => true) }}>采用</button>
                    )}
                    {canCancel(rec) && (
                      <button type="button" data-action="cancel-task" data-task-id={row.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm(`取消任务 ${row.id}？`)) void cancelRow(row.id)
                        }}>取消</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {st.tasks.length === 0 && (
          <div className="muted det-empty" data-task-empty>
            {st.status === 'loading' ? '读取中' : st.total === 0 ? '还没有任务：在框图页点「运行」' : '本页没有任务'}
          </div>
        )}
      </div>
      {/* 采用会连场景一起换（D-061 ⑨）；这是既有行为，说在这里免得当成毛病 */}
      <div className="muted task-foot">「采用」把结果页、态势图层与场景切到该任务；{s.ui.devMode && <span data-dev="task-hint">开发者模式下摘要栏另出哈希与引擎版本；</span>}点行看右栏摘要。
        <button type="button" className="link" data-action="tasks-reload" onClick={() => { void loadPage(st.offset) }}>刷新</button>
      </div>
    </div>
  )
}
