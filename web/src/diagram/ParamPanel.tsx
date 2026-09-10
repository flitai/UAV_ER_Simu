// 右栏参数面板（09 §6.6）：控件、单位、范围、说明全部由目录的 ParamSpec 生成。
// 四条约定：internal 不出现（D-037）；互斥参数并排共用单选（界面上构造不出 param_conflict）；
// 约束即时校验（提交时引擎再校验一次，这里只是便利）；清空即回缺省，框图不写该键。

import { useMemo } from 'react'
import { DataIdField } from '../data/DataIdField.js'
import type { Catalog, ComponentSpec, ParamSpec } from '../api/catalog.js'
import { findComponent } from '../api/catalog.js'
import { formatEng, parseEng } from './format.js'
import { missingRequired, type DiagramNode, type ObservationPoint, type ParamValue } from './doc.js'

export interface ParamPanelProps {
  catalog: Catalog | null
  node: DiagramNode | null
  tap: ObservationPoint | null
  scenarios: Array<{ id: string; loaded: boolean; entities: string[]; sites: string[] }>
  onParam: (name: string, v: ParamValue | undefined) => void
  onField: (patch: Partial<DiagramNode>) => void
  onTap: (patch: Partial<ObservationPoint>) => void
  devMode: boolean
}

/** 互斥参数分组：目录 excludes[] 声明的两个并成一组，其余各自一组。 */
export function groupParams(spec: ComponentSpec): ParamSpec[][] {
  const visible = spec.params.filter((p) => !p.internal)
  const done = new Set<string>()
  const out: ParamSpec[][] = []
  for (const p of visible) {
    if (done.has(p.name)) continue
    const mates = (p.excludes ?? []).map((n) => visible.find((q) => q.name === n)).filter(Boolean) as ParamSpec[]
    const back = visible.filter((q) => q.excludes?.includes(p.name))
    const group = [p, ...mates, ...back.filter((b) => !mates.includes(b))]
    group.forEach((g) => done.add(g.name))
    out.push(group)
  }
  return out
}

export function Field({ ps, value, onChange }: { ps: ParamSpec; value: ParamValue | undefined; onChange: (v: ParamValue | undefined) => void }) {
  const isDefault = value === undefined
  const shown = value !== undefined ? value : (ps.default ?? '')
  // 实测数据的标识不是随便一个字符串：它必须是索引里真有的那一条。
  // 渲染成普通文本框等于要用户背标识（2026-09-09 用户实测），换成挑单（D-056）。
  // 放在 Field 里而不是各视图各写一份，典型链路与自由画布因此拿到的是同一个控件。
  if (ps.name === 'data_id') {
    return <DataIdField value={typeof shown === 'string' ? shown : ''} onChange={onChange} />
  }
  if (ps.type === 'bool') {
    return (
      <select className={isDefault ? 'dim' : ''} data-field={ps.name} value={String(shown)}
        onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">是</option><option value="false">否</option>
      </select>
    )
  }
  if (ps.type === 'enum') {
    return (
      <select className={isDefault ? 'dim' : ''} data-field={ps.name} value={String(shown)}
        onChange={(e) => onChange(e.target.value)}>
        {(ps.enum ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (ps.type === 'number') {
    const bad = typeof value === 'number' && ((ps.min !== undefined && value < ps.min) || (ps.max !== undefined && value > ps.max))
    return (
      <input
        className={`${isDefault ? 'dim' : ''}${bad ? ' bad' : ''}`} data-field={ps.name}
        defaultValue={typeof shown === 'number' ? formatEng(shown).replace(' ', '') : String(shown)}
        onBlur={(e) => {
          const t = e.target.value.trim()
          if (t === '') return onChange(undefined)
          const v = parseEng(t)
          if (v === null) { e.target.classList.add('bad'); return }
          e.target.classList.remove('bad')
          onChange(v)
        }}
      />
    )
  }
  return (
    <input className={isDefault ? 'dim' : ''} data-field={ps.name} defaultValue={String(shown)}
      onBlur={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
  )
}

export function range(ps: ParamSpec): string {
  const lo = ps.min !== undefined ? formatEng(ps.min) : null
  const hi = ps.max !== undefined ? formatEng(ps.max) : null
  if (lo !== null && hi !== null) return `${lo} … ${hi}`
  if (lo !== null) return `≥ ${lo}`
  if (hi !== null) return `≤ ${hi}`
  return ''
}

export function ParamPanel(p: ParamPanelProps) {
  const spec = p.catalog && p.node ? findComponent(p.catalog, p.node.type) : null
  const groups = useMemo(() => (spec ? groupParams(spec) : []), [spec])

  if (p.tap) return <TapPanel tap={p.tap} onTap={p.onTap} />
  if (!p.node) return <div className="group placeholder">在左栏或画布上选一个节点</div>
  if (!spec) return <div className="group placeholder">目录里没有组件 {p.node.type}</div>

  const pending = missingRequired(spec, p.node.params)
  const bound = p.node.scene_binding
  const sc = p.scenarios.find((s) => s.id === bound?.scenario_id)

  return (
    <div className="param-panel" data-form="node">
      <div className="group">
        <div className="pp-title">{spec.display_name}</div>
        <label className="pp-row"><span>标识</span><input data-field="id" defaultValue={p.node.id}
          onBlur={(e) => p.onField({ id: e.target.value.trim() || p.node!.id })} /></label>
        <label className="pp-row"><span>显示名</span><input data-field="label" defaultValue={p.node.label ?? ''}
          onBlur={(e) => p.onField({ label: e.target.value || undefined })} /></label>
        <div className="pp-row"><span>类型</span><code>{p.node.type}</code></div>
        {pending.length > 0 && <div className="pp-warn" data-pending>待填：{pending.join('、')}</div>}
      </div>

      {spec.scene_bindable && (
        <div className="group" data-bind>
          <div className="pp-title">场景绑定</div>
          <label className="pp-row"><span>场景</span>
            <select data-field="scenario_id" value={bound?.scenario_id ?? ''}
              onChange={(e) => p.onField({ scene_binding: e.target.value ? { scenario_id: e.target.value } : undefined })}>
              <option value="">未绑定</option>
              {p.scenarios.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
            </select>
          </label>
          {bound && (
            <label className="pp-row"><span>{spec.type === 'ScenarioSource' ? '站点' : '实体'}</span>
              <select data-field="entity" value={bound.entity_id ?? bound.site_id ?? ''}
                onChange={(e) => {
                  const v = e.target.value || undefined
                  p.onField({ scene_binding: spec.type === 'ScenarioSource'
                    ? { scenario_id: bound.scenario_id, site_id: v }
                    : { scenario_id: bound.scenario_id, entity_id: v } })
                }}>
                <option value="">未选择</option>
                {(spec.type === 'ScenarioSource' ? sc?.sites ?? [] : sc?.entities ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
          )}
          {!bound && <div className="pp-warn">未绑定场景对象</div>}
          {bound && sc && !sc.loaded && <div className="pp-warn">该场景未载入，先到场景视图打开它才能选实体</div>}
        </div>
      )}

      <div className="group">
        <div className="pp-title">参数</div>
        {groups.map((g, i) => {
          if (g.length === 1) {
            const ps = g[0]!
            return (
              <label className="pp-row" key={ps.name} title={ps.description}>
                <span title={`${ps.name}${ps.description ? ' — ' + ps.description : ''}`}>{ps.name}</span>
                <Field ps={ps} value={p.node!.params[ps.name]} onChange={(v) => p.onParam(ps.name, v)} />
                <em className="pp-unit">{ps.unit}</em>
                {range(ps) && <em className="pp-range">{range(ps)}</em>}
              </label>
            )
          }
          // 互斥组：共用一个单选，只能填其中一个（09 §6.6 第 2 条）
          const active = g.find((ps) => p.node!.params[ps.name] !== undefined) ?? g[0]!
          return (
            <div className="pp-excl" key={`x${i}`} data-exclusive={g.map((x) => x.name).join(',')}>
              {g.map((ps) => (
                <label className="pp-row" key={ps.name} title={ps.description}>
                  <input type="radio" name={`excl-${i}`} checked={active.name === ps.name}
                    onChange={() => { for (const o of g) if (o.name !== ps.name) p.onParam(o.name, undefined) }} />
                  <span title={`${ps.name}${ps.description ? ' — ' + ps.description : ''}`}>{ps.name}</span>
                  <Field ps={ps} value={p.node!.params[ps.name]}
                    onChange={(v) => { for (const o of g) if (o.name !== ps.name) p.onParam(o.name, undefined); p.onParam(ps.name, v) }} />
                  <em className="pp-unit">{ps.unit}</em>
                </label>
              ))}
            </div>
          )
        })}
      </div>

      {p.devMode && (
        <div className="group" data-dev="trace">
          <div className="pp-title">溯源（开发者模式）</div>
          <div className="pp-row"><span>model_id</span><code>{spec.model_id}</code></div>
          <div className="pp-row"><span>M / E</span><code>{spec.model_layer} / {spec.model_level}</code></div>
          <div className="pp-row"><span>版本</span><code>{spec.version}</code></div>
          <div className="pp-row"><span>实现</span><code>{spec.implementation ?? '—'}</code></div>
        </div>
      )}
    </div>
  )
}

const PRODUCTS: Array<{ k: string; label: string; disabled?: string }> = [
  { k: 'spectrum', label: '频谱' },
  { k: 'envelope', label: '包络' },
  { k: 'iq', label: 'IQ', disabled: '本版本未实现' },
]

function TapPanel({ tap, onTap }: { tap: ObservationPoint; onTap: (p: Partial<ObservationPoint>) => void }) {
  return (
    <div className="param-panel" data-form="tap">
      <div className="group">
        <div className="pp-title">观测点</div>
        <label className="pp-row"><span>标识</span><input data-field="op_id" defaultValue={tap.id}
          onBlur={(e) => onTap({ id: e.target.value.trim() || tap.id })} /></label>
        <label className="pp-row"><span>显示名</span><input data-field="op_label" defaultValue={tap.label ?? ''}
          onBlur={(e) => onTap({ label: e.target.value || undefined })} /></label>
        <div className="pp-row"><span>挂在</span><code>{tap.node}.{tap.port}</code></div>
      </div>
      <div className="group">
        <div className="pp-title">产品</div>
        {PRODUCTS.map((pr) => (
          <label className="pp-row" key={pr.k} title={pr.disabled}>
            <input type="checkbox" data-product={pr.k} disabled={!!pr.disabled}
              checked={tap.products.includes(pr.k)}
              onChange={(e) => onTap({ products: e.target.checked ? [...tap.products, pr.k] : tap.products.filter((x) => x !== pr.k) })} />
            <span>{pr.label}</span>
            {pr.disabled && <em className="pp-range">{pr.disabled}</em>}
          </label>
        ))}
      </div>
    </div>
  )
}
