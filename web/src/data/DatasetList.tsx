// 数据中心中栏：片段列表（U-4，D-075）。
//
// 四态徽标照显（铁律 15 不静默降级），**原因句不显示**——公开数据集的原因句写的是
// 「采样率取自论文」「标定常数为估算值」，正是 D-042b 要挡的「解释数据来源与估算」。
// 它们在 `?dev=1` 的详情里（用户 2026-09-19 拍板）。验收集只写两个字（D-056）。

import { useSyncExternalStore } from 'react'
import { stateBadge } from '../shell/badges.js'
import { datasetCells, datasetsNote } from './datasetRows.js'
import { datasetStore, selectDataset, type DatasetCenterState } from './datasetStore.js'

function useDatasets(): DatasetCenterState {
  return useSyncExternalStore(datasetStore.subscribe, datasetStore.get, datasetStore.get)
}

export function DatasetList() {
  const st = useDatasets()
  return (
    <div className="ds-panel" data-dataset-panel data-dataset-status={st.status}>
      <div className="det-head">
        <span data-datasets-note>{datasetsNote(st.total, st.matched, st.items.length, st.truncated, st.error)}</span>
      </div>
      <div className="site-table-wrap det-table-wrap">
        <table className="site-table det-table" data-dataset-table>
          <thead>
            <tr><th>标识</th><th>机型</th><th>批次</th><th>视距</th><th>距离</th><th>中心频率</th><th>样点数</th><th>质量</th><th>验收集</th></tr>
          </thead>
          <tbody>
            {st.items.map((r) => {
              const c = datasetCells(r)
              const b = stateBadge(c.quality)
              return (
                <tr key={c.data_id} data-dataset-row={c.data_id} className={c.data_id === st.selected ? 'sel' : ''}
                  onClick={() => selectDataset(c.data_id)}>
                  <td className="name">{c.data_id}</td>
                  <td className="name">{c.className}</td>
                  <td className="name">{c.batch}</td>
                  <td className="name">{c.visibility}</td>
                  <td className="num">{c.distance}</td>
                  <td className="num">{c.center}</td>
                  <td className="num">{c.samples}</td>
                  <td className="name"><span className={`badge result ${b.tone}`} data-quality={c.quality}>{b.glyph} {b.text}</span></td>
                  <td className="name">{c.holdout ? '验收集' : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {st.items.length === 0 && (
          <div className="muted det-empty" data-dataset-empty>
            {st.status === 'loading' ? '读取中' : st.total === 0 ? '本机无实测数据索引' : '没有匹配的片段'}
          </div>
        )}
      </div>
    </div>
  )
}
