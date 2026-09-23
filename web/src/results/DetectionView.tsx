// 结果页「检测识别」页签的中栏（C-9，10 报告 §5.7）：时间线三行 + 检测列表（突发 / 帧两种粒度）+ 识别列表。
// C-3 的摘要行与突发表原样留在这里（`data-det-*` 钩子不改名），C-9 加的是时间线、帧粒度与识别表。
// 点任何一行或一条条带，把时间轴与信号游标移到该时刻。界面只摆事实：数字、单位、站名，不写解释句（D-039）。

import { useEffect, useState, useSyncExternalStore } from 'react'
import { getDetections, type DetectionRow } from '../api/client.js'
import { fmtDb, fmtHz, fmtSeconds } from '../shell/format.js'
import { seekTo } from '../shell/timelineOps.js'
import { timeStore } from '../shell/timeStore.js'
import { useAppState, useStore } from '../state/store.js'
import { detectionStore, siteIdsOf, visibleSegments, type DetectionState } from './detectionStore.js'
import { DetectionTimeline } from './DetectionTimeline.js'
import { labelText } from './labels.js'
import { recKey, recognitionStore, type RecognitionState } from './recognitionStore.js'

/** 结论只摆事实（D-039）：匹配上了、几个模板分不清、不属于任何模板 */
const RESULT_TEXT: Record<string, string> = { known: '匹配', ambiguous: '歧义', unknown: '未知' }

/** 帧粒度一次最多画多少行：以时间游标为中心取窗。全部塞进 DOM 是几万个 <tr>，滚不动也读不完 */
const FRAME_WINDOW = 400

function useDetectionState(): DetectionState {
  return useSyncExternalStore(detectionStore.subscribe, detectionStore.get, detectionStore.get)
}

function useRecognitionState(): RecognitionState {
  return useSyncExternalStore(recognitionStore.subscribe, recognitionStore.get, recognitionStore.get)
}

/**
 * 帧粒度的行：不带 `hit` 过滤地取全部帧（突发表取的是 `hit=true`）。
 * 只在切到帧粒度时取，运行中不轮询——帧表是看完整判决过程用的，运行结束后才完整；
 * 终态到达时依赖项变化会自动再取一次。413 由 client 的既有重试按 `suggest.stride` 处理。
 */
function useFrameRows(taskId: string | null, site: string | null, runState: string | null, on: boolean) {
  const [st, setSt] = useState<{ rows: DetectionRow[]; stride: number; status: string; error: string | null }>(
    { rows: [], stride: 1, status: 'idle', error: null })
  useEffect(() => {
    if (!taskId || !on) { setSt({ rows: [], stride: 1, status: 'idle', error: null }); return }
    let alive = true
    setSt((p) => ({ ...p, status: 'loading' }))
    void (async () => {
      try {
        const r = await getDetections(taskId, site ? { site_id: site } : {})
        if (!alive) return
        if (r.status === 'ok') setSt({ rows: r.rows, stride: r.stride, status: 'ok', error: null })
        else if (r.status === 'none') setSt({ rows: [], stride: 1, status: 'none', error: null })
        else if (r.status === 'not_ready') setSt({ rows: [], stride: 1, status: 'not_ready', error: null })
        else setSt({ rows: [], stride: 1, status: 'error', error: r.message })
      } catch (e) {
        if (alive) setSt({ rows: [], stride: 1, status: 'error', error: String(e) })
      }
    })()
    return () => { alive = false }
  }, [taskId, site, runState, on])
  return st
}

export function DetectionView() {
  const s = useAppState()
  const store = useStore()
  const st = useDetectionState()
  const rec = useRecognitionState()
  const ts = useSyncExternalStore(timeStore.subscribe, timeStore.get, timeStore.get)
  const [grain, setGrain] = useState<'segment' | 'frame'>('segment')

  const segs = visibleSegments(st)
  const sites = siteIdsOf(st)
  // 表跟着站下拉走（「全部」就是全部），时间线只能画一站故跟焦点站走——差别写在 timeline3.ts 的头注里
  const frames = useFrameRows(s.task.id, st.siteFilter, s.task.runState, grain === 'frame')
  const recognized = rec.rows.filter((r) => r.result !== 'unknown').length
  const node = st.index ? (st.siteFilter
    ? Object.values(st.index.nodes).find((n) => n.site_id === st.siteFilter) ?? null
    : Object.values(st.index.nodes)[0] ?? null) : null
  const frameCount = st.index ? Object.values(st.index.nodes).filter((n) => !st.siteFilter || n.site_id === st.siteFilter).reduce((a, n) => a + n.frames, 0) : null
  const hits = st.index ? Object.values(st.index.nodes).filter((n) => !st.siteFilter || n.site_id === st.siteFilter).reduce((a, n) => a + n.hits, 0)
    : st.rows.filter((r) => !st.siteFilter || r.site_id === st.siteFilter).length
  const statusText = !s.task.id ? '无任务'
    : st.status === 'none' ? '本次任务没有检测器'
    : st.status === 'polling' ? '运行中，每 2 s 刷新'
    : st.status === 'final' ? '' : '读取中'

  // 帧表以时间游标为中心取窗：游标处那一行居中，前后各一半
  const shownT = ts.mode === 'replay' && ts.t !== null ? ts.t : s.task.t_s
  let from = 0
  if (frames.rows.length > FRAME_WINDOW) {
    let at = 0
    for (let i = 0; i < frames.rows.length; i++) { if (frames.rows[i].t_s <= shownT) at = i; else break }
    from = Math.min(Math.max(at - FRAME_WINDOW / 2, 0), frames.rows.length - FRAME_WINDOW)
  }
  const frameSlice = frames.rows.slice(from, from + FRAME_WINDOW)

  const recRows = st.siteFilter ? rec.rows.filter((r) => (r.site_id ?? null) === st.siteFilter) : rec.rows

  return (
    <div className="det-panel" data-det-panel data-det-status={st.status}>
      <DetectionTimeline />
      <div className="det-head">
        <span><b>{segs.length}</b> 段</span>
        <span>命中 <b>{hits}</b>{frameCount !== null ? ` / ${frameCount} 帧` : ' 帧'}</span>
        {node && <span>门限 <b>{node.threshold.toFixed(3)}</b></span>}
        {node && <span>频段 <b>{fmtHz(node.f_lo_Hz)} – {fmtHz(node.f_hi_Hz)}</b>{node.m_bins ? ` · M ${node.m_bins}` : ''}</span>}
        {node && <span>噪声窗 <b>{node.noise_window_frames}</b> 帧{node.noise_stale_frames > 0 ? `，陈旧 ${node.noise_stale_frames}` : ''}</span>}
        {rec.rows.length > 0 && <span data-rec-count>识别 <b>{recognized}</b> / {rec.rows.length}</span>}
        {st.stride > 1 && <span className="muted">已抽稀 1/{st.stride}</span>}
        <span className="spacer" />
        <span className="seg-toggle" data-det-grain={grain}>
          {(['segment', 'frame'] as const).map((g) => (
            <button key={g} type="button" className={grain === g ? 'on' : ''} data-action="det-grain" data-grain={g}
              onClick={() => setGrain(g)}>{g === 'segment' ? '突发' : '帧'}</button>
          ))}
        </span>
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

      {grain === 'segment' ? (
        <div className="site-table-wrap det-table-wrap">
          <table className="site-table det-table" data-det-table>
            <thead>
              <tr>
                <th>#</th>{sites.length > 0 && <th>站</th>}<th>起 s</th><th>止 s</th><th>时长 s</th><th>帧</th><th>峰值 Λ</th><th>峰值 dBm</th><th>信噪比 dB</th><th>削波</th><th>标签</th><th>后验</th><th>结论</th>
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
                  {(() => {
                    const r = rec.byKey[recKey(g.site_id, g.segment_id)]
                    return (
                      <>
                        <td className="name" data-det-label>{r?.label ?? ''}</td>
                        <td className="num">{r ? r.posterior.toFixed(2) : ''}</td>
                        <td className="name" data-det-result={r?.result ?? ''}>{r ? RESULT_TEXT[r.result] ?? r.result : ''}</td>
                      </>
                    )
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
          {segs.length === 0 && <div className="muted det-empty" data-det-empty>0 段{frameCount !== null ? ` · ${frameCount} 帧` : ''}</div>}
        </div>
      ) : (
        <>
        <div className="muted frame-note" data-frame-note>
          {frames.status === 'loading' ? '读取中'
            : frames.status === 'not_ready' ? '运行中，产品还没就绪'
            : frames.status === 'none' ? '本次任务没有检测器'
            : frames.error ? frames.error
            : `共 ${frames.rows.length} 行${frames.stride > 1 ? `（已抽稀 1/${frames.stride}）` : ''}${frames.rows.length > FRAME_WINDOW ? ` · 第 ${from + 1}–${from + frameSlice.length} 行（随时间游标移动）` : ''}`}
        </div>
        <div className="site-table-wrap det-table-wrap">
          <table className="site-table det-table" data-frame-table>
            <thead>
              <tr>
                <th>t s</th>{sites.length > 0 && <th>站</th>}<th>帧</th><th>频段</th><th>Λ</th><th>η</th><th>dBm</th><th>噪声 dBm</th><th>信噪比 dB</th><th>命中</th><th>段</th><th>削波</th>
              </tr>
            </thead>
            <tbody>
              {frameSlice.map((r, i) => (
                <tr key={`${r.node_id}|${r.frame_index}|${i}`} data-frame-row={`${r.node_id}|${r.frame_index}`}
                    className={r.hit ? 'on' : ''} onClick={() => seekTo(store, r.t_s, true)}>
                  <td className="num">{fmtSeconds(r.t_s)}</td>
                  {sites.length > 0 && <td className="name">{r.site_id ?? '—'}</td>}
                  <td className="num">{r.frame_index}</td>
                  <td className="num">{fmtHz(r.f_lo_Hz)} – {fmtHz(r.f_hi_Hz)}</td>
                  <td className="num">{r.statistic >= 100 ? r.statistic.toExponential(2) : r.statistic.toFixed(3)}</td>
                  <td className="num">{r.threshold.toFixed(3)}</td>
                  <td className="num">{typeof r.band_power_dBm === 'number' ? fmtDb(r.band_power_dBm, '') : '—'}</td>
                  <td className="num">{typeof r.noise_dBm === 'number' ? fmtDb(r.noise_dBm, '') : '—'}</td>
                  <td className="num">{r.snr_dB.toFixed(1)}</td>
                  <td className="num">{r.hit ? '●' : ''}</td>
                  <td className="num">{r.segment_id ?? ''}</td>
                  <td className="num">{r.overload ? '▲' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      <div className="site-table-wrap det-table-wrap">
        <div className="det-head"><span>识别</span><span className="muted">每个突发一行</span></div>
        <table className="site-table det-table" data-rec-table>
          <thead>
            <tr>
              <th>t s</th>{sites.length > 0 && <th>站</th>}<th>段</th><th>标签</th><th>后验</th><th>Top-3</th><th>证据</th><th>结论</th>
            </tr>
          </thead>
          <tbody>
            {recRows.map((r) => (
              <tr key={`${r.node_id}|${r.segment_id}`} data-rec-row={`${r.node_id}|${r.segment_id}`}
                  onClick={() => seekTo(store, r.t_s, true)}>
                <td className="num">{fmtSeconds(r.t_s)}</td>
                {sites.length > 0 && <td className="name">{r.site_id ?? '—'}</td>}
                <td className="num">{r.segment_id}</td>
                <td className="name">{labelText(r.label) || r.label}</td>
                <td className="num">{r.posterior.toFixed(2)}</td>
                <td className="name">{r.top_n.map((c) => `${labelText(c.label) || c.label} ${c.posterior.toFixed(2)}`).join(' · ') || '—'}</td>
                <td className="name">{r.evidence_quality}</td>
                <td className="name" data-rec-result={r.result}>{RESULT_TEXT[r.result] ?? r.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {recRows.length === 0 && <div className="muted det-empty" data-rec-empty>0 行</div>}
      </div>
    </div>
  )
}
