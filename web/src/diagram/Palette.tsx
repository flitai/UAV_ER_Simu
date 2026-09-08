// 左栏组件库（09 §6.1、§6.3）：六类分组，只由组件目录驱动。
// 天线与接收机首期无组件，分组仍显示并标「本期无组件」——04 §8.1 规定的是六类，
// 隐藏空分组会让用户以为系统只支持四类。

import { useMemo, useState } from 'react'
import { byCategory, CATEGORY_COLOR, type Catalog, type ComponentSpec } from '../api/catalog.js'

export function Palette({ catalog, onAdd }: { catalog: Catalog | null; onAdd: (c: ComponentSpec) => void }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => (catalog ? byCategory(catalog) : []), [catalog])
  if (!catalog) return <div className="group placeholder">组件库不可用（引擎目录未就绪）</div>
  const kw = q.trim().toLowerCase()
  const hit = (c: ComponentSpec) =>
    !kw || c.type.toLowerCase().includes(kw) || c.display_name.toLowerCase().includes(kw)
  return (
    <div className="palette" data-palette>
      <label className="palette-search">
        组件库
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索…" data-palette-search />
      </label>
      {groups.map((g) => {
        const items = g.items.filter(hit)
        if (kw && items.length === 0) return null
        return (
          <div className="palette-group" key={g.key} data-palette-group={g.key}>
            <div className="palette-cat" style={{ borderLeftColor: CATEGORY_COLOR[g.key] }}>{g.label}</div>
            {g.items.length === 0
              ? <div className="palette-empty">本期无组件</div>
              : items.map((c) => (
                <button
                  key={c.type}
                  className="palette-item"
                  data-palette-item={c.type}
                  draggable
                  title={c.description ?? c.type}
                  onDragStart={(e) => { e.dataTransfer.setData('application/cuav-component', c.type); e.dataTransfer.effectAllowed = 'copy' }}
                  onClick={() => onAdd(c)}
                >
                  <span className="palette-dot" style={{ background: CATEGORY_COLOR[g.key] }} />
                  <span className="palette-name">{c.display_name}</span>
                  <span className="palette-type">{c.type}</span>
                </button>
              ))}
          </div>
        )
      })}
    </div>
  )
}
