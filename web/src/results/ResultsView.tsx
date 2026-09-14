// 结果视图（09 §7.1，10 报告 §5.7）：信号 / 检测识别 / 评价 / 任务四页签。
// 信号页是 U-3（频谱、瀑布、包络）；检测识别页自 C-9 起是时间线三行 + 检测列表（突发 / 帧）+ 识别列表；
// 评价页是 C-9 新增的指标卡、混淆矩阵与 ROC；任务页留 U-4。

import { ColumnLayout } from '../shell/ColumnLayout.js'
import { fmtFactor } from '../shell/format.js'
import { InstrumentPanel } from '../signal/InstrumentPanel.js'
import { SignalView } from '../signal/SignalView.js'
import { useAppState, useDispatch } from '../state/store.js'
import { tapLabel } from '../chain/model.js'
import type { ResultsTab } from '../state/types.js'
import { DetectionSummary } from './DetectionsPanel.js'
import { DetectionView } from './DetectionView.js'
import { EvaluationAside, EvaluationSummary, EvaluationView } from './EvaluationView.js'
import { useDetections } from './detectionStore.js'
import { useRecognitions } from './recognitionStore.js'
import { useMetrics } from './metricsStore.js'
import { useTruth } from './truthStore.js'

const TABS: Array<{ id: ResultsTab; label: string }> = [
  { id: 'signal', label: '信号' }, { id: 'detections', label: '检测识别' },
  { id: 'evaluation', label: '评价' }, { id: 'tasks', label: '任务' },
]

export function ResultsView() {
  const s = useAppState()
  const dispatch = useDispatch()
  // 检测行只在结果页可见时取（信号页的叠加与检测页签共用），运行中每 2 s 一次，终态取最后一次加索引
  useDetections(s.task.id, s.task.runState, s.ui.view === 'results')
  // 识别行与检测段同节拍（C-4）：突发表按站与段号把标签接在检测段后面
  useRecognitions(s.task.id, s.task.runState, s.ui.view === 'results')
  // 评价指标整文件（C-5）：运行结束才有，运行中 409 等下一轮
  useMetrics(s.task.id, s.task.runState, s.ui.view === 'results')
  // 真值段（C-5 的产物）：检测识别页签时间线的第一行（C-9）
  useTruth(s.task.id, s.task.runState, s.ui.view === 'results')
  return (
    <ColumnLayout
      left={<>
        {/* 左栏只放面包屑里没有的任务事实（2026-09-13 用户指出编号 / 徽标 / 实验名与顶栏重复、观测点列表与中栏页签重复）：
            观测点切换只在中栏页签（左栏收起也能切，2026-09-08）；一个事实一处（D-062 原则） */}
        <div className="group" data-task-facts>
          <h2>任务</h2>
          {!s.task.id && <div className="muted">无任务</div>}
          {s.task.id && (
            <>
              <div className="form-row pp-line"><span className="form-label">种子</span><span className="form-value pp-ro">{s.context.seed ?? '—'}</span></div>
              <div className="form-row pp-line"><span className="form-label">时长</span><span className="form-value pp-ro">{s.task.duration_s > 0 ? `${s.task.duration_s} s` : '—'}</span></div>
              <div className="form-row pp-line"><span className="form-label">实时因子</span><span className="form-value pp-ro">{fmtFactor(s.task.realtimeFactor)}</span></div>
              <div className="form-row pp-line"><span className="form-label">观测点</span><span className="form-value pp-ro">{s.task.observationPoints.length}</span></div>
              {/* 引擎备注：结果有效时只是各节点的说明（噪声底、末尾丢样点……），折叠；降级 / 无效时原因要一眼看到 */}
              {s.task.reasons.length > 0 && (
                s.task.result === 'valid'
                  ? (
                    <details className="form-details" data-task-reasons>
                      <summary>引擎备注 {s.task.reasons.length} 条</summary>
                      <ul className="pp-notes">{s.task.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                    </details>
                  )
                  : <ul className="pp-notes bad" data-task-reasons>{s.task.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              )}
            </>
          )}
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
          {s.ui.resultsTab === 'detections' && <DetectionView />}
          {s.ui.resultsTab === 'evaluation' && <EvaluationView />}
          {s.ui.resultsTab === 'tasks' && <div className="placeholder">任务列表（U-4 启用）</div>}
        </div>
      }
      right={
        s.ui.resultsTab === 'signal' ? <InstrumentPanel />
          : s.ui.resultsTab === 'detections' ? <DetectionSummary />
          : s.ui.resultsTab === 'evaluation' ? <><EvaluationSummary /><EvaluationAside /></>
          : <div className="group placeholder">（U-4 启用）</div>
      }
    />
  )
}
