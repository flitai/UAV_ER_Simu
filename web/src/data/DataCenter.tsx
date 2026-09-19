// 数据中心（09 §7.3）：独立页面 #/data，顶栏直达、Alt+4。U-4（D-075）把它从一行占位改成三栏。
//
// 左 = 筛选（批次 / 机型 / 视距 / 划分 / 验收集，各带**全量**计数），中 = 列表，右 = 选中片段的详情。
// 与场景页同一条分层（D-062）：左栏是「怎么筛的」，右栏是「选中的这条是什么」。
//
// **只列索引，不给下载、不显示任何文件路径**（铁律 7、04 §8.6、D-037）。

import { useSyncExternalStore } from 'react'
import { ColumnLayout } from '../shell/ColumnLayout.js'
import { DatasetDetailPanel } from './DatasetDetail.js'
import { DatasetList } from './DatasetList.js'
import { datasetStore, setFilters, useDatasetList, type DatasetCenterState } from './datasetStore.js'

function useDatasets(): DatasetCenterState {
  return useSyncExternalStore(datasetStore.subscribe, datasetStore.get, datasetStore.get)
}

const VIS_LABEL: Record<string, string> = { LOS: '视距', NLOS: '非视距' }
const SPLIT_LABEL: Record<string, string> = { train: '训练集', test: '测试集' }

/** 一组分面：一行一个取值加计数，点一下筛上、再点一下取消。 */
function Facet(p: {
  title: string; field: string; counts: Record<string, number> | undefined
  value: string | null; label?: Record<string, string>; onPick: (v: string | null) => void
}) {
  const entries = Object.entries(p.counts ?? {}).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  return (
    <div className="group ds-facet" data-dataset-facet={p.field}>
      <div className="pp-title">{p.title}</div>
      {entries.map(([k, n]) => (
        <button key={k} type="button" className={`ds-facet-row${p.value === k ? ' on' : ''}`}
          data-field={`ds-${p.field}`} data-value={k}
          onClick={() => p.onPick(p.value === k ? null : k)}>
          <span className="ds-facet-name">{p.label?.[k] ?? k}</span><span className="ds-facet-n">{n}</span>
        </button>
      ))}
    </div>
  )
}

export function DataCenter() {
  const st = useDatasets()
  useDatasetList(true)
  const f = st.filters
  return (
    <div className="data-center" data-data-center>
      <ColumnLayout
        left={<>
          <div className="group">
            <h2>数据中心</h2>
            <label className="form-row pp-line"><span className="form-label">搜索</span>
              <span className="form-value"><input className="form-input" data-field="ds-q" value={f.q}
                placeholder="标识 / 机型 / 距离"
                onChange={(e) => setFilters({ q: e.target.value })} /></span>
            </label>
            <button type="button" className="ds-clear" data-action="ds-clear"
              disabled={!f.q && !f.batch && !f.className && f.holdout === undefined}
              onClick={() => setFilters({ q: '', batch: null, className: null, holdout: undefined })}>清空筛选</button>
          </div>
          <Facet title="批次" field="batch" counts={st.facets.batch} value={f.batch} onPick={(v) => setFilters({ batch: v })} />
          <Facet title="机型" field="class" counts={st.facets.class_name} value={f.className} onPick={(v) => setFilters({ className: v })} />
          <div className="group ds-facet" data-dataset-facet="holdout">
            <div className="pp-title">验收集</div>
            {([['true', '是'], ['false', '否']] as const).map(([k, text]) => (
              <button key={k} type="button" className={`ds-facet-row${String(f.holdout) === k ? ' on' : ''}`}
                data-field="ds-holdout" data-value={k}
                onClick={() => setFilters({ holdout: String(f.holdout) === k ? undefined : k === 'true' })}>
                <span className="ds-facet-name">{text}</span><span className="ds-facet-n">{st.facets.holdout?.[k] ?? 0}</span>
              </button>
            ))}
          </div>
          {/* 视距与划分只有一批数据有，靠关键词筛就够，不再各占一组按钮 */}
          <div className="group ds-facet" data-dataset-facet="other">
            <div className="pp-title">其它</div>
            <div className="muted ds-note">
              视距 {fmtCounts(st.facets.visibility, VIS_LABEL)}；划分 {fmtCounts(st.facets.split, SPLIT_LABEL)}
            </div>
          </div>
        </>}
        center={<DatasetList />}
        right={<DatasetDetailPanel />}
      />
    </div>
  )
}

function fmtCounts(counts: Record<string, number> | undefined, label: Record<string, string>): string {
  const e = Object.entries(counts ?? {})
  return e.length === 0 ? '—' : e.map(([k, n]) => `${label[k] ?? k} ${n}`).join(' · ')
}
