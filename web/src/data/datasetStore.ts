// 数据中心的外部小 store（U-4，D-075）：一份列表 + 选中那条的详情。
//
// 取数的两条防线抄自 DataIdField（D-056）：250 ms 去抖（打字别每个键都发一次请求）、
// `live` 令牌防竞态（后发的先到会把先发的结果盖掉）。

import { useEffect } from 'react'
import { getDataset, listDatasets, type DatasetDetail, type DatasetRow } from '../api/client.js'

export const LIST_LIMIT = 2000
const DEBOUNCE_MS = 250

export interface DatasetFilters {
  q: string
  batch: string | null
  className: string | null
  holdout: boolean | undefined
}

export interface DatasetCenterState {
  filters: DatasetFilters
  items: DatasetRow[]
  total: number
  matched: number
  truncated: boolean
  facets: Record<string, Record<string, number>>
  status: 'idle' | 'loading' | 'ok' | 'error'
  error: string | null
  selected: string | null
  detail: DatasetDetail | null
  detailStatus: 'idle' | 'loading' | 'ok' | 'missing' | 'error'
}

const initial = (): DatasetCenterState => ({
  filters: { q: '', batch: null, className: null, holdout: undefined },
  items: [], total: 0, matched: 0, truncated: false, facets: {},
  status: 'idle', error: null, selected: null, detail: null, detailStatus: 'idle',
})

let state: DatasetCenterState = initial()
const subs = new Set<() => void>()
let listToken = 0
let detailToken = 0

export const datasetStore = {
  get: (): DatasetCenterState => state,
  patch(p: Partial<DatasetCenterState>): void {
    let changed = false
    for (const k of Object.keys(p) as Array<keyof DatasetCenterState>) if (!Object.is(state[k], p[k])) { changed = true; break }
    if (!changed) return
    state = { ...state, ...p }
    for (const f of subs) f()
  },
  reset(): void { state = initial(); for (const f of subs) f() },
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f) } },
}

/** 探针：只出计数、筛选与选中，行内容靠 DOM 断言。 */
export function probeDataCenter(st: DatasetCenterState) {
  return {
    status: st.status,
    total: st.total,
    matched: st.matched,
    listed: st.items.length,
    truncated: st.truncated,
    q: st.filters.q,
    batch: st.filters.batch,
    className: st.filters.className,
    holdout: st.filters.holdout ?? null,
    selected: st.selected,
    detailStatus: st.detailStatus,
    detailLevel: st.detail?.detail_level ?? null,
    error: st.error,
  }
}

export function setFilters(p: Partial<DatasetFilters>): void {
  datasetStore.patch({ filters: { ...datasetStore.get().filters, ...p } })
}

async function fetchList(f: DatasetFilters): Promise<void> {
  const token = ++listToken
  datasetStore.patch({ status: 'loading' })
  try {
    const r = await listDatasets({
      q: f.q || undefined, batch: f.batch ?? undefined, className: f.className ?? undefined,
      holdout: f.holdout, limit: LIST_LIMIT,
    })
    if (token !== listToken) return
    datasetStore.patch({ items: r.items, total: r.total, matched: r.matched, truncated: r.truncated, facets: r.facets, status: 'ok', error: null })
  } catch (e) {
    if (token !== listToken) return
    datasetStore.patch({ status: 'error', error: String(e) })
  }
}

export function selectDataset(dataId: string | null): void {
  datasetStore.patch({ selected: dataId, detail: null, detailStatus: dataId ? 'loading' : 'idle' })
  if (!dataId) return
  const token = ++detailToken
  void getDataset(dataId).then((d) => {
    if (token !== detailToken) return
    // 索引里没有这条：如实说没有，不拿列表里那一行的摘要冒充详情
    datasetStore.patch(d ? { detail: d, detailStatus: 'ok' } : { detail: null, detailStatus: 'missing' })
  }).catch((e) => {
    if (token !== detailToken) return
    datasetStore.patch({ detailStatus: 'error', error: String(e) })
  })
}

/** 驱动：页面在时按筛选取一次，筛选变了去抖 250 ms 再取。数据中心离开即卸载，所以不必自己清。 */
export function useDatasetList(active: boolean): void {
  const f = datasetStore.get().filters
  const key = `${f.q} ${f.batch ?? ''} ${f.className ?? ''} ${String(f.holdout)}`
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => { void fetchList(datasetStore.get().filters) }, DEBOUNCE_MS)
    return () => { clearTimeout(t) }
  }, [active, key])
}
