// 结果页「检测识别」页签（C-3 最小集，10 报告 §5.7）：摘要行 + 突发列表；点一行把时间轴与信号游标移到该突发。
// 帧粒度列表、三行时间线条带、识别标签留 C-9。界面只摆事实：数字、单位、站名，不写解释句（D-039）。

import { useSyncExternalStore } from 'react'
import { fmtDb, fmtHz, fmtSeconds } from '../shell/format.js'
import { seekTo } from '../shell/timelineOps.js'
import { useAppState, useStore } from '../state/store.js'
import { detectionStore, visibleSegments, type DetectionState } from './detectionStore.js'

function useDetectionState(): DetectionState {
  return useSyncExternalStore(detectionStore.subscribe, detectionStore.get, detectionStore.get)
}

function siteIdsOf(st: DetectionState): string[] {
  const ids = new Set<string>()
  if (st.index) for (const n of Object.values(st.index.nodes)) if (n.site_id) ids.add(n.site_id)
  for (const g of st.segments) if (g.site_id) ids.add(g.site_id)
  return [...ids].sort()
}

/** 中栏：摘要一行 + 突发表 */
export function DetectionsPanel() {
  const s = useAppState()
  const store = useStore()
  const st = useDetectionState()
  const segs = visibleSegments(st)
  const sites = siteIdsOf(st)
  const node = st.index ? (st.siteFilter
    ? Object.values(st.index.nodes).find((n) => n.site_id === st.siteFilter) ?? null
    : Object.values(st.index.nodes)[0] ?? null) : null
  const frames = st.index ? Object.values(st.index.nodes).filter((n) => !st.siteFilter || n.site_id === st.siteFilter).reduce((a, n) => a + n.frames, 0) : null
  const hits = st.index ? Object.values(st.index.nodes).filter((n) => !st.siteFilter || n.site_id === st.siteFilter).reduce((a, n) => a + n.hits, 0)
    : st.rows.filter((r) => !st.siteFilter || r.site_id === st.siteFilter).length
  const statusText = !s.task.id ? '无任务'
    : st.status === 'none' ? '本次任务没有检测器'
    : st.status === 'polling' ? '运行中，每 2 s 刷新'
    : st.status === 'final' ? '' : '读取中'
  return (
    <div className="det-panel" data-det-panel data-det-status={st.status}>
      <div className="det-head">
        <span><b>{segs.length}</b> 段</span>
        <span>命中 <b>{hits}</b>{frames !== null ? ` / ${frames} 帧` : ' 帧'}</span>
        {node && <span>门限 <b>{node.threshold.toFixed(3)}</b></span>}
        {node && <span>频段 <b>{fmtHz(node.f_lo_Hz)} – {fmtHz(node.f_hi_Hz)}</b></span>}
        {node && <span>噪声窗 <b>{node.noise_window_frames}</b> 帧{node.noise_stale_frames > 0 ? `，陈旧 ${node.noise_stale_frames}` : ''}</span>}
        {st.stride > 1 && <span className="muted">已抽稀 1/{st.stride}</span>}
        <span className="spacer" />
        {sites.length > 1 && (
          <label className="field"><span className="k">站</span>
            <select value={st.siteFilter ?? ''} onChange={(e) => detectionStore.patch({ siteFilter: e.target.value || null })} data-field="det-site">
              <option value="">全部</option>
              {sites.map((id) => <option key={id} value={id}>{id}</option>)}
            </select></label>
        )}
        {statusText && <span className="muted" data-det-note>{statusText}</span>}
        {st.error && <span className="bad" data-det-error>{st.error}</span>}
      </div>
      <div className="site-table-wrap det-table-wrap">
        <table className="site-table det-table" data-det-table>
          <thead>
            <tr>
              <th>#</th>{sites.length > 0 && <th>站</th>}<th>起 s</th><th>止 s</th><th>时长 s</th><th>帧</th><th>峰值 Λ</th><th>峰值 dBm</th><th>信噪比 dB</th><th>削顶</th>
            </tr>
          </thead>
          <tbody>
            {segs.map((g, i) => (
              <tr key={g.key} data-det-row={g.key} className={g.overload ? 'degraded' : ''} onClick={() => seekTo(store, g.t_start, true)}>
                <td className="name">{i + 1}</td>
                {sites.length > 0 && <td className="name">{g.site_id ?? '—'}</td>}
                <td className="num">{fmtSeconds(g.t_start)}</td>
                <td className="num">{fmtSeconds(g.t_end)}</td>
                <td className="num">{(g.t_end - g.t_start).toFixed(3)}</td>
                <td className="num">{g.frames}</td>
                <td className="num">{g.peak_statistic >= 100 ? g.peak_statistic.toExponential(2) : g.peak_statistic.toFixed(2)}</td>
                <td className="num">{g.peak_band_power_dBm === null ? '—' : fmtDb(g.peak_band_power_dBm, '')}</td>
                <td className="num">{g.peak_snr_dB.toFixed(1)}</td>
                <td className="num">{g.overload ? '▲' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {segs.length === 0 && <div className="muted det-empty" data-det-empty>0 段{frames !== null ? ` · ${frames} 帧` : ''}</div>}
      </div>
    </div>
  )
}

/** 右栏：检测器摘要（每个检测器一组），数据来自 detections.index.json */
export function DetectionSummary() {
  const st = useDetectionState()
  const nodes = st.index ? Object.values(st.index.nodes) : []
  return (
    <div className="instrument" data-det-summary>
      <div className="group">
        <h2>检测</h2>
        {nodes.length === 0 && <div className="muted">{st.status === 'polling' ? '运行结束后给出摘要' : st.status === 'none' ? '无' : '—'}</div>}
        {nodes.map((n) => (
          <div key={n.node_id} className="det-node" data-det-node={n.node_id}>
            <div><b>{n.site_id ?? n.node_id}</b> <span className="muted">{n.noise_mode === 'sliding' ? '滑动噪声估计' : '探针噪声估计'}</span></div>
            <div className="muted">帧 {n.frames} · 命中 {n.hits} · 段 {n.segments}{n.overload_frames > 0 ? ` · 削顶 ${n.overload_frames}` : ''}</div>
            <div className="muted">nfft {n.nfft} · pfa {n.pfa} · η {n.threshold.toFixed(3)} · 窗 {n.noise_window_frames} 帧 · 合并 {n.merge_gap_frames}</div>
            {n.noise_stale_frames > 0 && <div className="muted">噪声估计陈旧 {n.noise_stale_frames} 帧</div>}
            {n.state !== 'valid' && <div className="bad">{n.state}{n.notes.length ? `：${n.notes[0]}` : ''}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
