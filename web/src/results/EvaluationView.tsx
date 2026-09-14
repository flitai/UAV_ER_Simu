// 结果页「评价」页签（C-9，10 报告 §5.7）：指标卡一排（四态徽标）+ 混淆矩阵热表 + ROC；
// 右栏是逐站摘要与本站的参数、质量、溯源。数据全来自 metrics 端点（一次运行一份，运行结束才有）。
//
// 三条口径：
//  ① 分母为零在文件里就是 null，界面写「—」不写 0（铁律 15）；
//  ② 指标按 D-028 语义，界面只给数，不标「原型阶段验证值」——那句限定写在文档与模型卡里（D-039 ③）；
//  ③ `quality.noise_stale_frames` 在 metrics.json 里恒 null（端口上拿不到），真值取 detections.index.json。

import { useSyncExternalStore } from 'react'
import type { MetricsSection } from '../api/client.js'
import { stateBadge } from '../shell/badges.js'
import { fmtDuration } from '../shell/format.js'
import { useAppState } from '../state/store.js'
import { ConfusionMatrix } from './ConfusionMatrix.js'
import { detectionStore, focusSite, siteIdsOf } from './detectionStore.js'
import { metricsStore, type MetricsState } from './metricsStore.js'
import { RocPlot } from './RocPlot.js'

function useMetricsState(): MetricsState {
  return useSyncExternalStore(metricsStore.subscribe, metricsStore.get, metricsStore.get)
}

/** 比值写成小数，缺的写「—」（分母为零在文件里就是 null，照实摆） */
export function fmtRatio(v: number | null | undefined, digits = 3): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—'
}

const TRUTH_TEXT: Record<string, string> = { scenario: '真值：场景', manifest: '真值：清单' }

/** 焦点站对应的那一节；没有站号（未绑站的单站任务）取第一节 */
function sectionOf(doc: MetricsState['doc'], site: string | null): MetricsSection | null {
  const sites = doc?.sites ?? []
  if (sites.length === 0) return null
  if (site) return sites.find((m) => m.site_id === site) ?? sites[0]
  return sites[0]
}

interface CardProps { k: string; v: string; sub?: string }
function Card({ k, v, sub }: CardProps) {
  return (
    <div className="metric-card" data-metric={k}>
      <div className="metric-k">{k}</div>
      <div className="metric-v mono">{v}</div>
      {sub && <div className="metric-sub muted">{sub}</div>}
    </div>
  )
}

export function EvaluationView() {
  const s = useAppState()
  const st = useMetricsState()
  const det = useSyncExternalStore(detectionStore.subscribe, detectionStore.get, detectionStore.get)
  const sites = siteIdsOf(det)
  const site = focusSite(det)
  const m = sectionOf(st.doc, site)

  if (!m) {
    return (
      <div className="eval-panel" data-eval-panel data-eval-status={st.status}>
        <div className="muted" data-eval-empty>
          {!s.task.id ? '无任务' : st.status === 'polling' ? '运行结束后生成' : st.status === 'none' ? '本次任务没有评价器' : '—'}
        </div>
      </div>
    )
  }

  const badge = stateBadge(m.state)
  const node = det.index ? Object.values(det.index.nodes).find((n) => (n.site_id ?? null) === (m.site_id ?? null))
    ?? Object.values(det.index.nodes)[0] ?? null : null
  const mBins = node?.m_bins ?? null

  return (
    <div className="eval-panel" data-eval-panel data-eval-status={st.status} data-eval-focus={m.site_id ?? m.node_id}>
      <div className="det-head">
        <span><b>{m.site_id ?? m.node_id}</b></span>
        <span className={'badge result ' + badge.tone} data-eval-state={m.state}>{badge.glyph} {badge.text}</span>
        <span className="muted">{TRUTH_TEXT[m.truth_source] ?? '无真值'}</span>
        <span className="spacer" />
        {sites.length > 1 && (
          <label className="field"><span className="k">站</span>
            <select value={det.siteFilter ?? ''} onChange={(e) => detectionStore.patch({ siteFilter: e.target.value || null })} data-field="eval-site">
              {sites.map((id) => <option key={id} value={id}>{id}</option>)}
            </select></label>
        )}
      </div>
      {m.reasons.length > 0 && <ul className="pp-notes bad" data-eval-reasons>{m.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}

      <div className="metric-row" data-metric-row>
        <Card k="Pd" v={fmtRatio(m.frames.pd)} sub={`tp ${m.frames.tp} / fn ${m.frames.fn}`} />
        <Card k="Pfa" v={fmtRatio(m.frames.pfa, 5)} sub={`fp ${m.frames.fp} / tn ${m.frames.tn}`} />
        <Card k="F1" v={fmtRatio(m.frames.f1)} sub={`查准 ${fmtRatio(m.frames.precision)}`} />
        <Card k="发现时延" v={fmtDuration(m.segments.detect_delay_s.mean)} sub={`最大 ${fmtDuration(m.segments.detect_delay_s.max)}`} />
        <Card k="识别准确率" v={fmtRatio(m.recognition.accuracy)} sub={`${m.recognition.evaluated} 段`} />
      </div>

      <div className="eval-blocks">
        <div className="eval-block">
          <h3>突发级</h3>
          <div className="muted">
            真值段 {m.segments.truth} · 检出 {m.segments.matched}（{fmtRatio(m.segments.pd_segment)}） · 虚警段 {m.segments.false_segments}
            {m.segments.truth_out_of_band > 0 ? ` · 频段外 ${m.segments.truth_out_of_band}` : ''}
          </div>
          <h3>ROC</h3>
          <RocPlot points={m.roc.points} workingPoint={m.roc.working_point} mBins={mBins} dev={s.ui.devMode} />
        </div>
        <div className="eval-block">
          <h3>混淆矩阵</h3>
          <div className="muted">
            未知 {fmtRatio(m.recognition.unknown_rate)} · 歧义 {fmtRatio(m.recognition.ambiguous_rate)}
            {m.recognition.unmatched > 0 ? ` · 未匹配 ${m.recognition.unmatched}` : ''}
          </div>
          <ConfusionMatrix labels={m.recognition.labels} confusion={m.recognition.confusion} perClass={m.recognition.per_class} />
        </div>
      </div>
    </div>
  )
}

/** 右栏上半：逐站一行的摘要（C-5 的那张卡，点一行换焦点站） */
export function EvaluationSummary() {
  const st = useMetricsState()
  const det = useSyncExternalStore(detectionStore.subscribe, detectionStore.get, detectionStore.get)
  const sites = st.doc?.sites ?? []
  const focus = focusSite(det)
  return (
    <div className="group" data-metrics data-metrics-status={st.status}>
      <h2>评价</h2>
      {sites.length === 0 && <div className="muted">{st.status === 'polling' ? '运行结束后给出' : st.status === 'none' ? '无' : '—'}</div>}
      {sites.map((m) => (
        <div key={m.node_id} className={'det-node' + (m.site_id && m.site_id === focus ? ' on' : '')} data-eval-site={m.site_id ?? m.node_id}
             onClick={() => { if (m.site_id) detectionStore.patch({ siteFilter: m.site_id }) }}>
          <div><b>{m.site_id ?? m.node_id}</b> <span className="muted">{TRUTH_TEXT[m.truth_source] ?? '无真值'}</span></div>
          <div className="muted">Pd {fmtRatio(m.frames.pd)} · Pfa {fmtRatio(m.frames.pfa, 4)} · F1 {fmtRatio(m.frames.f1)}</div>
          <div className="muted">突发 {m.segments.matched} / {m.segments.truth} · 虚警段 {m.segments.false_segments} · 识别准确率 {fmtRatio(m.recognition.accuracy)}</div>
          {m.state !== 'valid' && <div className="bad">{m.state}{m.reasons.length ? `：${m.reasons[0]}` : ''}</div>}
        </div>
      ))}
    </div>
  )
}

/** 右栏下半：焦点站这一节的参数、质量与溯源（溯源只在 `?dev=1`，D-039） */
export function EvaluationAside() {
  const s = useAppState()
  const st = useMetricsState()
  const det = useSyncExternalStore(detectionStore.subscribe, detectionStore.get, detectionStore.get)
  const m = sectionOf(st.doc, focusSite(det))
  if (!m) return null
  const node = det.index ? Object.values(det.index.nodes).find((n) => (n.site_id ?? null) === (m.site_id ?? null)) ?? null : null
  const p = m.params as Record<string, unknown>
  return (
    <div className="group" data-eval-aside>
      <h2>口径</h2>
      <div className="form-row pp-line"><span className="form-label">nfft</span><span className="form-value pp-ro">{String(p['nfft'] ?? '—')}</span></div>
      <div className="form-row pp-line"><span className="form-label">匹配重叠</span><span className="form-value pp-ro">{String(p['match_overlap'] ?? '—')}</span></div>
      <div className="form-row pp-line"><span className="form-label">ROC 取点</span><span className="form-value pp-ro">{String(p['roc_points'] ?? '—')}</span></div>
      <div className="form-row pp-line"><span className="form-label">帧</span><span className="form-value pp-ro">{m.frames.total}</span></div>
      <div className="form-row pp-line"><span className="form-label">真值行</span><span className="form-value pp-ro">{m.quality.truth_rows}</span></div>
      <div className="form-row pp-line"><span className="form-label">削顶帧</span><span className="form-value pp-ro">{m.quality.overload_frames}</span></div>
      {/* 陈旧帧在 metrics.json 里恒 null，取检测摘要那一份 */}
      <div className="form-row pp-line"><span className="form-label">噪声陈旧帧</span><span className="form-value pp-ro">{node ? node.noise_stale_frames : '—'}</span></div>
      {s.ui.devMode && (
        <div data-dev>
          <h2>溯源</h2>
          {Object.entries((m as unknown as { trace?: Record<string, unknown> }).trace ?? {}).map(([k, v]) => (
            <div key={k} className="form-row pp-line"><span className="form-label">{k}</span><span className="form-value pp-ro">{String(v)}</span></div>
          ))}
        </div>
      )}
    </div>
  )
}
