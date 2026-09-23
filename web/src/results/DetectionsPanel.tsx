// 结果页「检测识别」页签的右栏：每个检测器一组摘要（C-3，数据来自 detections.index.json）。
// 中栏（时间线 + 检测列表 + 识别列表）自 C-9 起在 DetectionView.tsx；评价那两块在 EvaluationView.tsx。
// 界面只摆事实：数字、单位、站名，不写解释句（D-039）。

import { useSyncExternalStore } from 'react'
import { stateBadge } from '../shell/badges.js'
import { detectionStore, type DetectionState } from './detectionStore.js'

function useDetectionState(): DetectionState {
  return useSyncExternalStore(detectionStore.subscribe, detectionStore.get, detectionStore.get)
}

export function DetectionSummary() {
  const st = useDetectionState()
  const nodes = st.index ? Object.values(st.index.nodes) : []
  return (
    <div className="instrument" data-det-summary>
      <div className="group">
        <h2>检测</h2>
        {nodes.length === 0 && <div className="muted">{st.status === 'polling' ? '运行结束后给出摘要' : st.status === 'none' ? '无' : '—'}</div>}
        {nodes.map((n) => {
          const badge = stateBadge(n.state)
          return (
            <div key={n.node_id} className="det-node" data-det-node={n.node_id}>
              <div>
                <b>{n.site_id ?? n.node_id}</b> <span className="muted">{n.noise_mode === 'sliding' ? '滑动噪声估计' : '探针噪声估计'}</span>
                {n.state !== 'valid' && <span className={'badge result ' + badge.tone} data-det-node-state={n.state}>{badge.glyph} {badge.text}</span>}
              </div>
              <div className="muted">帧 {n.frames} · 命中 {n.hits} · 段 {n.segments}{n.overload_frames > 0 ? ` · 削波 ${n.overload_frames}` : ''}</div>
              <div className="muted">nfft {n.nfft} · pfa {n.pfa} · η {n.threshold.toFixed(3)} · 窗 {n.noise_window_frames} 帧 · 合并 {n.merge_gap_frames}{n.m_bins ? ` · M ${n.m_bins}` : ''}</div>
              {n.noise_stale_frames > 0 && <div className="muted">噪声估计陈旧 {n.noise_stale_frames} 帧</div>}
              {n.state !== 'valid' && n.notes.length > 0 && <div className="bad">{n.notes[0]}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
