// 挑一段实测录音（D-056）。
//
// 框图里对实测数据的引用只写 data_id（D-037），但用户得有办法**知道有哪些**。
// 此前参数面板把它渲染成一个普通文本框，回放模式因此只能手敲标识
// （2026-09-09 用户实测：选了「实测片段回放」点运行，报「缺必填参数 data_id」而无处可选）。
//
// 服务端按机型分组抽样，不给全部 4714 条——挑片段挑的是机型不是某一片。列不全就把数目摆出来，
// 不假装列全了（铁律 15）。
//
// **只摆事实，不替用户下结论**（D-039、D-042b、D-043）：机型、视距、距离、样点数、验收集、
// 数据质量都照实写在条目上，但不写「这一段在验收集里，结论不能再当作独立验证」这类话——
// 用的人自己判断得了（用户 2026-09-09 指示）。数据层的标记不受影响，照旧随产物走（铁律 14）。

import { useEffect, useRef, useState } from 'react'
import { listDatasets, type DatasetRow } from '../api/client.js'
import { formatEng } from '../diagram/format.js'

/** 一行录音在下拉里怎么写。机型摆前面——那是挑片段时唯一真正在看的东西 */
export function rowText(r: DatasetRow): string {
  const bits = [r.class_name ?? r.batch]
  if (r.visibility) bits.push(r.visibility === 'LOS' ? '视距' : r.visibility === 'NLOS' ? '非视距' : r.visibility)
  if (r.distance_text) bits.push(r.distance_text)
  if (r.sample_count) bits.push(`${formatEng(r.sample_count)}样点`)
  if (r.holdout) bits.push('验收集')
  return `${bits.join(' · ')}　${r.data_id}`
}

/** 选中那一条的补充说明，放在下拉底下一行 */
function detailText(r: DatasetRow): string {
  const bits: string[] = []
  if (r.center_frequency_Hz) bits.push(`中心 ${formatEng(r.center_frequency_Hz)}Hz`)
  if (r.split) bits.push(r.split === 'test' ? '出版方测试集' : r.split === 'train' ? '出版方训练集' : r.split)
  if (r.quality && r.quality !== 'valid') bits.push(`数据质量 ${r.quality}`)
  return bits.join('　')
}

export function DataIdField(p: { value: string; onChange: (v: string | undefined) => void }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<DatasetRow[]>([])
  const [total, setTotal] = useState(0)
  const [matched, setMatched] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 框图里填着的那一条可能不在抽样里，单独查回来补进下拉，否则它会显示成空
  const [current, setCurrent] = useState<DatasetRow | null>(null)
  const live = useRef(0)

  useEffect(() => {
    const token = ++live.current
    const t = setTimeout(() => {
      listDatasets({ q })
        .then((d) => {
          if (live.current !== token) return          // 换过关键词了，这一批已经过期
          setList(d.items); setTotal(d.total); setMatched(d.matched); setTruncated(d.truncated); setErr(null)
        })
        .catch((e: Error) => { if (live.current === token) setErr(e.message) })
    }, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    if (!p.value) { setCurrent(null); return }
    if (list.some((r) => r.data_id === p.value)) { setCurrent(null); return }
    let alive = true
    listDatasets({ dataId: p.value })
      .then((d) => { if (alive) setCurrent(d.items[0] ?? null) })
      .catch(() => { if (alive) setCurrent(null) })
    return () => { alive = false }
  }, [p.value, list])

  const options = current ? [current, ...list] : list
  const known = options.some((r) => r.data_id === p.value)
  const picked = options.find((r) => r.data_id === p.value)

  return (
    <div className="data-pick" data-form="data-id">
      <input
        className="data-pick-q"
        data-field="data_id-filter"
        placeholder="筛选：机型、视距、标识…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <select
        className="data-pick-sel"
        data-field="data_id"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value || undefined)}
      >
        <option value="">（未选录音）</option>
        {/* 填着的值不在清单里也照样列出来，不静默丢掉用户已经填过的东西 */}
        {!known && p.value && <option value={p.value}>{p.value}（不在清单里）</option>}
        {options.map((r) => <option key={r.data_id} value={r.data_id}>{rowText(r)}</option>)}
      </select>
      <div className="data-pick-note" data-datasets-note>
        {err
          ? `数据清单取不到：${err}`
          : truncated
            ? `共 ${total} 段 · 匹配 ${matched} 段 · 列出 ${options.length} 段`
            : `共 ${total} 段 · 匹配 ${matched} 段`}
      </div>
      {picked && detailText(picked) && (
        <div className="data-pick-note" data-datasets-detail>{detailText(picked)}</div>
      )}
    </div>
  )
}
