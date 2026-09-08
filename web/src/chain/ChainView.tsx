// 典型链路视图（06 备忘录 §9G C-7；10 号报告 §5；决策 D-051）。
//
// 框图页的主形态：一条固定的九环节链，用户只选变体、改参数、勾观测点，不增删节点、不连线。
// 自由画布降为高级模式，从工具条「展开为自由画布」单向进入（`#/diagram/canvas`）。
//
// **本视图不持有第二份状态**：链路状态由 `parseChain()` 从 `s.diagram.text` 解出，
// 改完由 `compile()` 编译回框图再 `diagram/setDoc`。撤销重做与脏标记因此沿用 U-2 的那一套。

import { useCallback, useMemo, useState } from 'react'
import { ColumnLayout } from '../shell/ColumnLayout.js'
import { useAppState, useDispatch, useStore } from '../state/store.js'
import { saveDiagram } from '../shell/actions.js'
import { isCatalog, findComponent, type Catalog, type ParamSpec } from '../api/catalog.js'
import { parse as parseDoc, serialize, type ParamValue } from '../diagram/doc.js'
import { Field, range } from '../diagram/ParamPanel.js'
import { formatEng } from '../diagram/format.js'
import { emitters as sceneEmitters, sites as sceneSites } from '../scene/editor/scenarioOps.js'
import { compile, parseChain, switchMode } from './compile.js'
import {
  MODE_LABEL, SLOTS, SLOT_BY_ID, TAP_ANCHOR, TAP_ORDER,
  emptyChain, missingParams, slotState, variantOf,
  type ChainMode, type ChainState, type SlotId, type TapId,
} from './model.js'
import { freqPlan, planChecks } from './plan.js'
import { SlotCard } from './SlotCard.js'

const MODES: ChainMode[] = ['synthetic', 'replay', 'mixed']

export function ChainView() {
  const s = useAppState()
  const dispatch = useDispatch()
  const store = useStore()
  const [selected, setSelected] = useState<SlotId>('tx')
  const catalog = isCatalog(s.components.catalog) ? s.components.catalog : null
  const scenarioDoc = s.scene.scenario.doc

  const parsed = useMemo(() => {
    const r = parseDoc(s.diagram.text)
    return r.ok ? parseChain(r.doc) : null
  }, [s.diagram.text])

  const commit = useCallback((next: ChainState, label: string) => {
    const { doc } = compile(next, catalog, scenarioDoc)
    dispatch({ type: 'diagram/setDoc', text: serialize(doc, catalog), label })
  }, [catalog, scenarioDoc, dispatch])

  // 当前框图不是本模板生成的：给一条出路，不硬解（10 报告 §5.5）
  if (!parsed) {
    return (
      <div className="chain-view" data-chain="foreign">
        <div className="group placeholder" data-chain-foreign>
          <p>当前框图不是典型链路（可能在自由画布里改过，或是示例框图）。</p>
          <p>
            <button type="button" data-action="chain-new" onClick={() => commit(newChain('synthetic'), '新建典型链路')}>
              新建典型链路
            </button>
            {' '}
            <a href="#/diagram/canvas" data-action="open-canvas">在自由画布打开</a>
          </p>
        </div>
      </div>
    )
  }
  const chain = parsed
  const plan = freqPlan(chain, scenarioDoc)
  const checks = planChecks(chain, plan)
  const derivable = plan.fs_rf > 0 ? undefined : ([] as readonly string[])

  // 引擎报错按节点 id 反查槽位（节点 id 固定，10 报告 §5.4）
  const { nodeSlot } = compile(chain, catalog, scenarioDoc)
  const errBySlot = new Map<string, string>()
  for (const e of s.diagram.validation?.errors ?? []) {
    const slot = e.node_id ? nodeSlot[e.node_id] : undefined
    errBySlot.set(slot ?? '__setup', `[${e.code}] ${e.message}`)
  }

  const setSlotParam = (id: SlotId, name: string, v: ParamValue | undefined) => {
    const params = { ...chain.slots[id].params }
    if (v === undefined) delete params[name]
    else params[name] = v
    commit({ ...chain, slots: { ...chain.slots, [id]: { ...chain.slots[id], params } } }, `改 ${name}`)
  }

  const sites = sceneSites(scenarioDoc)
  const emitters = sceneEmitters(scenarioDoc)

  return (
    <div className="chain-view" data-chain="ready">
      <ColumnLayout
        left={
          <ExperimentSetup
            chain={chain} checks={checks} plan={plan}
            scenarios={s.scene.scenario.list.map((x: { scenario_id: string }) => x.scenario_id)}
            currentScenario={s.scene.scenario.id}
            sceneSha={s.scene.scenario.sha256}
            sites={sites.map((x) => String(x.id))}
            emitters={emitters.map((x) => String(x.id))}
            error={errBySlot.get('__setup') ?? null}
            onChange={commit}
          />
        }
        right={
          <SlotPanel
            chain={chain} id={selected} catalog={catalog}
            derivable={derivable}
            onParam={(n, v) => setSlotParam(selected, n, v)}
          />
        }
        center={
        <div className="chain-main">
          <div className="chain-bar">
            <span className="chain-mode">{MODE_LABEL[chain.mode]}链路</span>
            <span className="chain-id" data-chain-id>{chain.diagram_id}{s.diagram.dirty ? ' •' : ''}</span>
            <span className="spacer" />
            <button type="button" data-action="chain-save" title="保存到服务端（Ctrl+S）"
              onClick={() => void saveDiagram(store)}>保存</button>
            <a href="#/diagram/canvas" data-action="open-canvas" title="展开后不能折回典型链路">展开为自由画布</a>
          </div>

          <div className="chain-strip" data-chain-strip>
            {SLOTS.map((def, i) => {
              const st = slotState(chain, def.id, catalog)
              return (
                <div className="chain-cell" key={def.id}>
                  {i > 0 && <span className="chain-arrow" aria-hidden>→</span>}
                  <SlotCard
                    chain={chain} id={def.id} catalog={catalog} state={st}
                    selected={selected === def.id}
                    missing={st === 'active' ? missingParams(chain, def.id, catalog, derivable) : []}
                    error={errBySlot.get(def.id) ?? null}
                    onSelect={setSelected}
                    onVariant={(id, variant) =>
                      commit({ ...chain, slots: { ...chain.slots, [id]: { ...chain.slots[id], variant } } }, '换变体')}
                    onBypass={(id, bypass) =>
                      commit({ ...chain, slots: { ...chain.slots, [id]: { ...chain.slots[id], bypass } } }, bypass ? '旁路' : '启用')}
                  />
                </div>
              )
            })}
          </div>

          <TapRow chain={chain} catalog={catalog} onToggle={(t, on) =>
            commit({ ...chain, taps: { ...chain.taps, [t]: on } }, on ? `打开 ${t}` : `关掉 ${t}`)} />

          {(s.diagram.validation?.errors.length ?? 0) > 0 && (
            <ul className="chain-errors" data-chain-errors>
              {s.diagram.validation!.errors.map((e: { code: string; node_id: string; message: string }, i: number) => (
                <li key={i}><code>{e.code}</code> {e.node_id ? <b>{e.node_id}</b> : null} {e.message}</li>
              ))}
            </ul>
          )}
        </div>
        }
      />
    </div>
  )
}

function newChain(mode: ChainMode): ChainState {
  return switchMode(emptyChain(mode, `chain-${mode}`), mode)
}

// ------------------------------------------------------------------ 左栏

interface SetupProps {
  chain: ChainState
  checks: ReturnType<typeof planChecks>
  plan: ReturnType<typeof freqPlan>
  scenarios: string[]
  currentScenario: string | null
  sceneSha: string
  sites: string[]
  emitters: string[]
  error: string | null
  onChange: (next: ChainState, label: string) => void
}

function ExperimentSetup(p: SetupProps) {
  const c = p.chain
  return (
    <div className="chain-setup" data-form="chain-setup">
      <div className="group">
        <div className="pp-title">试验设置</div>
        <div className="pp-row"><span>模式</span>
          <select data-field="mode" value={c.mode}
            onChange={(e) => p.onChange(switchMode(c, e.target.value as ChainMode), '换模式')}>
            {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </div>
        {c.mode !== 'replay' && (
          <>
            <div className="pp-row"><span>场景</span>
              <select data-field="scenario" value={c.scenario?.scenario_id ?? ''}
                onChange={(e) => {
                  const id = e.target.value
                  // sha256 取当前载入场景的落盘字节哈希；换场景时先由外层载入再回填（09 §6.8）
                  const sha = id === p.currentScenario ? p.sceneSha : ''
                  p.onChange({ ...c, scenario: id ? { scenario_id: id, sha256: sha } : null }, '选场景')
                }}>
                <option value="">（未选）</option>
                {p.scenarios.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="pp-row"><span>站点</span>
              <select data-field="site" value={c.siteId ?? ''}
                onChange={(e) => p.onChange({ ...c, siteId: e.target.value || null }, '选站点')}>
                <option value="">（未选）</option>
                {p.sites.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="pp-row"><span>目标</span>
              <select data-field="emitter" value={c.emitterId ?? ''}
                onChange={(e) => p.onChange({ ...c, emitterId: e.target.value || null }, '选目标')}>
                <option value="">（未选）</option>
                {p.emitters.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
          </>
        )}
        <label className="pp-row"><span>时长 s</span>
          <input data-field="duration_s" defaultValue={String(c.run.duration_s)}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v > 0) p.onChange({ ...c, run: { ...c.run, duration_s: v } }, '改时长')
            }} />
        </label>
        <label className="pp-row"><span>种子</span>
          <input data-field="seed" defaultValue={String(c.run.seed)}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (Number.isInteger(v) && v >= 0) p.onChange({ ...c, run: { ...c.run, seed: v } }, '改种子')
            }} />
        </label>
        {p.error && <div className="pp-warn" data-setup-error>{p.error}</div>}
      </div>

      <div className="group" data-freq-plan>
        <div className="pp-title">频率计划</div>
        <div className="pp-row"><span>宽带采样率</span><code>{formatEng(p.plan.fs_rf)}Hz</code></div>
        <div className="pp-row"><span>观测中心</span><code>{formatEng(p.plan.f_rx)}Hz</code></div>
        <div className="pp-row"><span>S4 采样率</span><code>{formatEng(p.plan.fs_s4)}Hz</code></div>
        <ul className="plan-checks">
          {p.checks.map((k) => (
            <li key={k.id} data-check={k.id} data-ok={k.ok ? '1' : '0'}>
              <span className={k.ok ? 'ok' : 'bad'}>{k.ok ? '✓' : '✕'}</span> {k.label}
              <div className="plan-detail">{k.detail}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 右栏

function SlotPanel(p: {
  chain: ChainState
  id: SlotId
  catalog: Catalog | null
  derivable: readonly string[] | undefined
  onParam: (name: string, v: ParamValue | undefined) => void
}) {
  const def = SLOT_BY_ID[p.id]
  const v = variantOf(p.chain, p.id)
  const st = slotState(p.chain, p.id, p.catalog)
  const spec = p.catalog ? findComponent(p.catalog, v.type) : null
  if (!spec) return <div className="group placeholder">{def.label}：{v.type} 尚未实现</div>
  if (st === 'not_applicable') return <div className="group placeholder">{def.label}：回放数据已含，参数不可编辑</div>

  const fixed = v.fixed ?? {}
  const derivedNames = new Set(
    (p.derivable === undefined ? DERIVED_OF(p.id) : DERIVED_OF(p.id).filter((n) => p.derivable!.includes(n))),
  )
  const pending = missingParams(p.chain, p.id, p.catalog, p.derivable)

  return (
    <div className="param-panel" data-form="slot">
      <div className="group">
        <div className="pp-title">{def.label} · {spec.display_name}</div>
        <div className="pp-row"><span>环节</span><span className="dim">{def.hint}</span></div>
        <div className="pp-row"><span>组件</span><code>{v.type}</code></div>
        {pending.length > 0 && <div className="pp-warn" data-pending>待填：{pending.join('、')}</div>}
      </div>
      <div className="group">
        {(spec.params as ParamSpec[]).filter((ps) => !ps.internal).map((ps) => {
          if (ps.name in fixed) {
            return (
              <div className="pp-row" key={ps.name} data-param-fixed={ps.name}>
                <span>{ps.name}</span>
                <span className="dim">{String(fixed[ps.name])}（模板固定）</span>
              </div>
            )
          }
          if (derivedNames.has(ps.name)) {
            return (
              <div className="pp-row" key={ps.name} data-param-derived={ps.name}>
                <span>{ps.name}</span>
                <span className="dim">由频率计划派生</span>
              </div>
            )
          }
          return (
            <label className="pp-row" key={ps.name}>
              <span title={ps.description}>{ps.name}{ps.unit ? ` (${ps.unit})` : ''}</span>
              <Field ps={ps} value={p.chain.slots[p.id].params[ps.name]} onChange={(x) => p.onParam(ps.name, x)} />
              <em className="pp-range">{range(ps)}</em>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function DERIVED_OF(id: SlotId): string[] {
  // 与 model.ts 的 DERIVED_PARAMS 同源，这里只读不改
  const map: Partial<Record<SlotId, string[]>> = {
    tx: ['sample_rate_Hz', 'total_samples', 'center_frequency_Hz'],
    det: ['band_lo_Hz', 'band_hi_Hz'],
    ch: ['frequency_Hz'],
  }
  return map[id] ?? []
}

// ------------------------------------------------------------------ 观测点行

function TapRow(p: { chain: ChainState; catalog: Catalog | null; onToggle: (t: TapId, on: boolean) => void }) {
  const { tapAt } = compile(p.chain, p.catalog, null)
  return (
    <div className="tap-row" data-tap-row>
      {TAP_ORDER.map((t) => {
        const at = tapAt[t]
        return (
          <label key={t} className={`tap${at ? '' : ' dim'}`} data-tap={t} title={TAP_ANCHOR[t].label}>
            <input
              type="checkbox"
              data-tap-toggle={t}
              disabled={!at}
              checked={!!p.chain.taps[t] && !!at}
              onChange={(e) => p.onToggle(t, e.target.checked)}
            />
            {t.toUpperCase()}
          </label>
        )
      })}
      <span className="tap-hint dim">勾选的观测点会产出频谱与包络</span>
    </div>
  )
}
