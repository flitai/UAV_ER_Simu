// 链上一个环节的卡片（10 号报告 §5.2）。
//
// 卡片只显示与只转发，不解释规则：显示什么参数由槽位表的 summary 决定，
// 参数长什么样由目录的 ParamSpec 决定，能不能选变体由目录里有没有那个组件决定。

import type { Catalog } from '../api/catalog.js'
import { CATEGORY_COLOR, findComponent } from '../api/catalog.js'
import { formatEng } from '../diagram/format.js'
import type { ParamValue } from '../diagram/doc.js'
import {
  SLOT_BY_ID, unavailableReason, variantOf,
  type ChainState, type SlotId, type SlotState,
} from './model.js'

export interface SlotCardProps {
  chain: ChainState
  id: SlotId
  catalog: Catalog | null
  state: SlotState
  selected: boolean
  /** 缺哪些必填参数 */
  missing: string[]
  /** 引擎报错落到本槽位时的报文 */
  error: string | null
  onSelect: (id: SlotId) => void
  onVariant: (id: SlotId, variant: number) => void
  onBypass: (id: SlotId, bypass: boolean) => void
}

const STATE_TEXT: Record<SlotState, string> = {
  active: '',
  bypass: '旁路',
  not_applicable: '回放数据已含',
  unavailable: '未实现',
}

function summaryText(chain: ChainState, id: SlotId, cat: Catalog | null): string[] {
  const v = variantOf(chain, id)
  const spec = cat ? findComponent(cat, v.type) : null
  const out: string[] = []
  for (const name of v.summary) {
    const ps = spec?.params.find((p) => p.name === name)
    const raw: ParamValue | undefined = chain.slots[id].params[name] ?? (ps?.default as ParamValue | undefined)
    if (raw === undefined || raw === null) continue
    const text = typeof raw === 'number' ? formatEng(raw) : String(raw)
    out.push(`${name}  ${text}${ps?.unit ? ' ' + ps.unit : ''}`)
  }
  return out
}

export function SlotCard(p: SlotCardProps) {
  const def = SLOT_BY_ID[p.id]
  const v = variantOf(p.chain, p.id)
  const spec = p.catalog ? findComponent(p.catalog, v.type) : null
  const dim = p.state === 'not_applicable' || p.state === 'unavailable' || p.state === 'bypass'
  const badge = p.error ? '✕' : p.missing.length ? '待填' : p.state === 'active' ? '✓' : STATE_TEXT[p.state]
  const color = spec ? CATEGORY_COLOR[spec.category] : '#94a3b8'

  return (
    <div
      className={`slot-card${dim ? ' dim' : ''}${p.selected ? ' on' : ''}${p.error ? ' bad' : ''}`}
      data-slot={p.id}
      data-slot-state={p.state}
      role="button"
      tabIndex={0}
      title={def.hint}
      onClick={() => p.onSelect(p.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect(p.id) } }}
    >
      <div className="slot-head" style={{ borderTopColor: color }}>
        <span className="slot-name">{def.label}</span>
        <span className={`slot-badge${p.error ? ' bad' : p.missing.length ? ' warn' : ''}`} data-slot-badge>{badge}</span>
      </div>

      {def.variants.length > 1 && p.state !== 'not_applicable' && (
        <select
          className="slot-variant"
          data-slot-variant={p.id}
          value={p.chain.slots[p.id].variant}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => p.onVariant(p.id, Number(e.target.value))}
        >
          {def.variants.map((x, i) => <option key={x.type} value={i}>{x.label}</option>)}
        </select>
      )}

      {p.state === 'unavailable' && (
        <div className="slot-note" data-slot-note>{unavailableReason(v.type)}</div>
      )}
      {p.state === 'not_applicable' && (
        <div className="slot-note" data-slot-note>回放数据已含该环节，参数不可编辑</div>
      )}
      {p.state === 'bypass' && <div className="slot-note" data-slot-note>已旁路，信号直通</div>}

      {p.state === 'active' && (
        <div className="slot-body">
          {summaryText(p.chain, p.id, p.catalog).slice(0, 3).map((t) => (
            <div className="slot-param" key={t}>{t}</div>
          ))}
        </div>
      )}

      {def.bypassable && p.state !== 'not_applicable' && p.state !== 'unavailable' && (
        <label className="slot-bypass" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            data-slot-bypass={p.id}
            checked={p.chain.slots[p.id].bypass}
            onChange={(e) => p.onBypass(p.id, e.target.checked)}
          />
          旁路
        </label>
      )}

      {p.error && <div className="slot-error" data-slot-error>{p.error}</div>}
    </div>
  )
}
