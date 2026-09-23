// 数据中心右栏：选中片段的详情（U-4，D-075）。
//
// 两档（`detail_level`）：批索引入 git，任何机器都有 `index` 档；采样率、片长、八项质检与
// 溯源要逐产物清单，那些不入 git。**缺的写「—」，并把「这是 index 档」说出来**——
// 不说的话看的人会以为那些字段本来就不存在（D3-4「缺数据时明说，不当作通过」的同一条）。

import { useSyncExternalStore } from 'react'
import { stateBadge } from '../shell/badges.js'
import { useAppState, useStore } from '../state/store.js'
import { sendDataIdToChain } from '../shell/actions.js'
import { detailRows, truthRows } from './datasetRows.js'
import { datasetStore, type DatasetCenterState } from './datasetStore.js'

function useDatasets(): DatasetCenterState {
  return useSyncExternalStore(datasetStore.subscribe, datasetStore.get, datasetStore.get)
}

export function DatasetDetailPanel() {
  const st = useDatasets()
  const s = useAppState()
  const store = useStore()
  if (!st.selected) {
    return <div className="group" data-dataset-detail><h2>片段详情</h2><div className="muted">在列表中选择片段</div></div>
  }
  if (st.detailStatus !== 'ok' || !st.detail) {
    const text = st.detailStatus === 'loading' ? '读取中' : st.detailStatus === 'missing' ? '索引中无此片段' : (st.error ?? '取不到')
    return <div className="group" data-dataset-detail data-detail-status={st.detailStatus}><h2>片段详情</h2><div className="muted">{text}</div></div>
  }
  const d = st.detail
  const rows = detailRows(d, s.ui.devMode)
  const truth = truthRows(d)
  const b = stateBadge(String((d.manifest?.quality as Record<string, unknown> | undefined)?.status ?? d.index.quality ?? 'not_applicable'))
  const plan = sendDataIdToChain(store, d.data_id, { dryRun: true })

  return (
    <div className="group" data-dataset-detail data-detail-level={d.detail_level} data-detail-status="ok">
      <h2>片段详情</h2>
      <div className="form-row pp-line">
        <span className="form-label">{d.data_id}</span>
        <span className="form-value pp-ro">
          <span className={`badge result ${b.tone}`}>{b.glyph} {b.text}</span>
          {d.holdout && <span className="badge note" data-holdout>验收集</span>}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="form-row pp-line" data-detail-row={r.key} {...(r.dev ? { 'data-dev': 'dataset-quality' } : {})}>
          <span className="form-label">{r.label}</span><span className="form-value pp-ro">{r.value}</span>
        </div>
      ))}
      {truth.length > 0 && (
        <>
          <div className="pp-title">真值</div>
          {truth.map((r) => (
            <div key={r.key} className="form-row pp-line" data-truth-row={r.key}>
              <span className="form-label">{r.label}</span><span className="form-value pp-ro">{r.value}</span>
            </div>
          ))}
        </>
      )}
      {d.detail_level === 'index' && (
        <div className="muted ds-note">本机无逐产物清单，采样率、片长与质检明细不可用。</div>
      )}
      <div className="ds-actions">
        <button type="button" data-action="use-for-replay" disabled={!plan.ok} title={plan.note}
          onClick={() => { sendDataIdToChain(store, d.data_id) }}>{plan.label}</button>
        <div className="muted ds-note" data-replay-note>{plan.note}</div>
      </div>
    </div>
  )
}
