// 链上一个环节的卡片（10 号报告 §5.2）。
//
// 卡片只显示与只转发，不解释规则：显示什么参数由槽位表的 summary 决定，
// 参数长什么样由目录的 ParamSpec 决定，能不能选变体由目录里有没有那个组件决定。

import type { Catalog } from '../api/catalog.js'
import { CATEGORY_COLOR, findComponent } from '../api/catalog.js'
import { formatEng } from '../diagram/format.js'
import type { ParamValue } from '../diagram/doc.js'
import {
  SLOT_BY_ID, effectiveParams, fromSceneOf, ownerEntity, proxyOf, unavailableReason, variantOf,
  type ChainState, type SlotId, type SlotState,
} from './model.js'
import { propView } from './effects.js'
import { readField } from '../scene/editor/deviceFields.js'
import { paramLabel } from './paramLabels.js'

type Obj = Record<string, unknown>

/** 挂在卡片里的子环节（C-4）：一行一个，点它选中的是那个槽位 */
export interface SlotMember {
  id: SlotId
  label: string
  state: SlotState
  selected: boolean
  error: string | null
  missing: string[]
}

export interface SlotCardProps {
  chain: ChainState
  id: SlotId
  catalog: Catalog | null
  state: SlotState
  selected: boolean
  members?: SlotMember[]
  /** 缺哪些必填参数（按当前链路的实体算） */
  missing: string[]
  /** 当前链路（D-064）：中栏下拉选中的无人机与侦测站；卡片摘要显示这一条链的参数 */
  focusEmitter: string
  focusSite: string
  focusEntity: Obj | undefined
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
  unavailable: '',   // 不标「未实现」（用户 2026-09-13）：卡片说明里写它本期旁路即可
}

function summaryText(
  chain: ChainState, id: SlotId, cat: Catalog | null, emitterId: string, siteId: string, entity: Obj | undefined,
): Array<{ k: string; v: string }> {
  const v = variantOf(chain, id)
  const spec = cat ? findComponent(cat, v.type) : null
  // 当前链路的有效参数（共用底值 + 该实体的单独设置，D-054）；由场景带出的从场景实体读（D-064）
  const eff = effectiveParams(chain, id, ownerEntity(id, emitterId, siteId))
  const scene = new Map(fromSceneOf(id).map((f) => [f.name, f]))
  const out: Array<{ k: string; v: string }> = []
  for (const name of v.summary) {
    const ps = spec?.params.find((p) => p.name === name)
    const sf = scene.get(name)
    const fromScene = sf ? readField(entity, sf.rel) : undefined
    // 模板固定的值优先：它才是编译进框图的那个，用户状态与目录缺省都不算数（D-063 的 noise_mode 就靠这一行）
    const raw: ParamValue | undefined = v.fixed?.[name]
      ?? (typeof fromScene === 'number' ? fromScene : undefined)
      ?? eff[name] ?? (ps?.default as ParamValue | undefined)
    if (raw === undefined || raw === null) continue
    const text = typeof raw === 'number' ? formatEng(raw) : String(raw)
    // 标签用与右栏同一张中文短名表，值带单位（2026-09-13 与参数面板一并改版）。
    // 工程词头与单位连写：formatEng 给 "2.44 G"，直接接 Hz 就是 "2.44 GHz"（与左栏频率计划同一写法）；没有词头时补一个空格
    const withUnit = !ps?.unit ? text : text.includes(' ') ? text + ps.unit : `${text} ${ps.unit}`
    out.push({ k: paramLabel({ name }), v: withUnit })
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
        {/* 不标 ×N（D-064）：框图显示的是中栏下拉选中的那一条链；展开成几份是编译的事，不是用户要看的 */}
        <span className={`slot-badge${p.error ? ' bad' : p.missing.length ? ' warn' : ''}`} data-slot-badge>{badge}</span>
      </div>

      {/* 变体由模式决定的环节（辐射源）不给下拉：试验设置栏的「模式」已经是那个开关，
          再放一个只会多一个操作入口、把逻辑弄复杂（D-057）。名字仍写出来，只是不可点。 */}
      {def.variantFrom === 'mode' && p.state !== 'not_applicable' && (
        <div className="slot-variant-fixed" data-slot-variant-fixed={p.id}>{v.label}</div>
      )}

      {def.variantFrom !== 'mode' && def.variants.length > 1 && p.state !== 'not_applicable' && (
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

      {/* 传播信道：卡片上只列这一档包含哪几项效应，逐项开关在右栏（D-058，用户拍板第 ① 条）。
          清单由当前配置直接派生，不读引擎输出——它显示的是用户自己的选择。 */}
      {proxyOf(p.id) && p.state === 'active' && (() => {
        const v = propView(p.chain.slots[p.id].params)
        return (
          <div className="slot-effects" data-slot-effects={v.terms.join(',')}>{v.text}</div>
        )
      })()}

      {p.state === 'active' && (
        <div className="slot-body">
          {summaryText(p.chain, p.id, p.catalog, p.focusEmitter, p.focusSite, p.focusEntity).slice(0, 3).map((t) => (
            <div className="slot-param" key={t.k}><span className="k">{t.k}</span><span className="v">{t.v}</span></div>
          ))}
        </div>
      )}

      {/* 子环节（C-4）：检测识别评价一张卡、三个环节——检测在卡片正文，特征提取与模板识别各占一行 */}
      {p.members && p.members.length > 0 && (
        <div className="slot-members" data-slot-members>
          {p.members.map((m) => (
            <div key={m.id}
              className={`slot-member${m.selected ? ' on' : ''}${m.error ? ' bad' : ''}${m.state !== 'active' ? ' dim' : ''}`}
              data-slot-sub={m.id} data-slot-sub-state={m.state}
              role="button" tabIndex={0}
              title={SLOT_BY_ID[m.id].hint}
              onClick={(e) => { e.stopPropagation(); p.onSelect(m.id) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); p.onSelect(m.id) } }}
            >
              <span className="k">{m.label}</span>
              <span className={`v${m.error ? ' bad' : m.missing.length ? ' warn' : ''}`}>
                {m.error ? '✕' : m.missing.length ? '待填' : m.state === 'active' ? '✓' : (STATE_TEXT[m.state] || unavailableReason(variantOf(p.chain, m.id).type))}
              </span>
              {/* 可旁路的子环节要有自己的勾选框（C-10）：旁路开关此前只画在卡片上，
                  于是挂在卡片里的接收滤波一旦缺省旁路，界面上就没有任何地方能把它打开。 */}
              {SLOT_BY_ID[m.id].bypassable && m.state !== 'not_applicable' && m.state !== 'unavailable' && (
                <label className="slot-bypass sub" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    data-slot-bypass={m.id}
                    checked={p.chain.slots[m.id].bypass}
                    onChange={(e) => p.onBypass(m.id, e.target.checked)}
                  />
                  旁路
                </label>
              )}
            </div>
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
