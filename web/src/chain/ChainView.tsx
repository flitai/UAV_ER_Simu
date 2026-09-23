// 典型链路视图（06 备忘录 §9G C-7；10 号报告 §5；决策 D-051）。
//
// 框图页**唯一**的形态：一条固定的十一环节链，用户只改参数、勾观测点，不增删节点、不连线。
// 自由画布连同它的入口已由 D-060 删掉（用户 2026-09-10：「自由画布不重要，用户操作起来也很难控制，
// 有点华而不实」）——先把一条完整的信号级仿真流程跑通，想清楚了再加也不迟。
// 解不成典型链路的框图落到本文件的「不是典型链路」分支，原文只读摆出来，不替用户丢东西。
//
// **本视图不持有第二份状态**：链路状态由 `parseChain()` 从 `s.diagram.text` 解出，
// 改完由 `compile()` 编译回框图再 `diagram/setDoc`。撤销重做与脏标记因此沿用 U-2 的那一套。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ColumnLayout } from '../shell/ColumnLayout.js'
import { useAppState, useDispatch, useStore } from '../state/store.js'
import { saveDiagram, saveScenario } from '../shell/actions.js'
import { isReadonlyScenario } from '../scene/readonly.js'
import { isCatalog, findComponent, type Catalog, type ParamSpec } from '../api/catalog.js'
import { parse as parseDoc, serialize, type ParamValue } from '../diagram/doc.js'
import { Field, range } from '../diagram/Field.js'
import { DataIdField } from '../data/DataIdField.js'
import { getDataset } from '../api/client.js'
import { formatEng } from '../diagram/format.js'
import { fmtHz } from '../shell/format.js'
import { emitters as sceneEmitters, setPath, sites as sceneSites, type Obj } from '../scene/editor/scenarioOps.js'
import { fieldsFor, modelOf, readField, type DeviceKind } from '../scene/editor/deviceFields.js'
import { paramLabel, paramTitle } from './paramLabels.js'
import { DeviceRow } from '../scene/ObjectForm.js'
import type { ScenarioDoc } from '../state/types.js'
import { compile, parseChain, switchMode } from './compile.js'
import {
  INST_SEP,
  MODE_LABEL, SLOTS, SLOT_BY_ID, TAP_ANCHOR, TAP_ORDER, GRID_SLOTS,
  DERIVED_PARAMS,
  emptyChain, fromSceneOf, groupMembers, missingParams, ownerOf, paramScope, proxyOf, retiredNote, slotState,
  splitProxy, variantOf, writeParam,
  type ChainMode, type ChainState, type ParamScope, type SlotId, type TapId,
} from './model.js'
import { propConflict, propView, visiblePropParams } from './effects.js'
import { freqPlan, planChecks } from './plan.js'
import { SlotCard } from './SlotCard.js'
import { valueLabel } from './enumLabels.js'

const MODES: ChainMode[] = ['synthetic', 'replay', 'mixed']

/** 链条每行几张卡片。改这个数就改了版式，`snakePos` 与 CSS 的列数要一起改。 */
export const CHAIN_COLS = 4

/**
 * 蛇形排布：第 0 行从左往右，第 1 行从右往左，如此往复（2026-09-09 用户指定）。
 *
 * 这样一行读到头，下一张卡片就在**正下方**——第 0 行末尾在第 4 列，第 1 行开头也在第 4 列，
 * 视线不必从行尾甩回行首。返回值里的 `next` 说的是「本张卡片与下一张之间的连接件朝哪边」：
 * 行内向右 / 向左，行末向下，最后一张没有。
 */
export function snakePos(i: number, total: number, cols = CHAIN_COLS): {
  row: number; col: number; next: 'right' | 'left' | 'down' | null
} {
  const row = Math.floor(i / cols)
  const inRow = i % cols
  const ltr = row % 2 === 0
  const col = ltr ? inRow + 1 : cols - inRow
  if (i === total - 1) return { row, col, next: null }
  return { row, col, next: inRow === cols - 1 ? 'down' : (ltr ? 'right' : 'left') }
}

/**
 * 把「载入的场景」与「链路引用的场景」同步好（D-053 §5.1）：缺省全选站点与目标、回填场景哈希。
 *
 * 单独抽成 hook 而不是写在组件里，是为了让它能在 `if (!parsed) return` **之前**被调用——
 * hook 的调用顺序每次渲染都必须一样（React error #300）。`chain` 为 null 时它什么也不做。
 */
function useSceneSync(
  chain: ChainState | null,
  s: ReturnType<typeof useAppState>,
  catalog: Catalog | null,
  scenarioDoc: ScenarioDoc | null,
  dispatch: ReturnType<typeof useDispatch>,
): void {
  const siteIdList = sceneSites(scenarioDoc).map((x) => String(x.id))
  const emitterIdList = sceneEmitters(scenarioDoc).map((x) => String(x.id))
  // 判据必须同时看 id **与载入状态**：`scene/scenarioLoading` 会立刻把 scene.scenario.id 改成
  // 新场景，而 doc 要等请求回来才换。只看 id 的话，在 loading 那一帧闸门就放行了，
  // 效应会拿旧场景的站源列表把选择填上；旧场景的 id 恰好在新场景里也存在时
  // （golden-01 的 site-1 / uav-1 在 golden-03 里都有），之后就再也不会重填——
  // 切到三站场景只勾中一个站。这是切片 ⑥b 实测撞到的。
  const sceneLoaded = s.scene.scenario.status === 'ok' && !!s.scene.scenario.id
  const sceneInSync = !!chain && !!chain.scenario
    && chain.scenario.scenario_id === s.scene.scenario.id
    && s.scene.scenario.status === 'ok'
  // 非回放模式却没有场景引用时，认下当前载入的这份。
  // 「全合成而没有场景」是个跑不起来的状态——`SceneEmitterSource` 要靠场景绑定拿内部参数，
  // 没有绑定引擎直接拒。它最容易在「切到实测回放再切回来」之后出现：进回放模式会把
  // `scenario` 置空（防线二、三：回放数据与场景无关），切回来却没人把它填回去，
  // 界面上只剩「无人机（先选场景）」（2026-09-09 用户实测撞到）。
  const needAdopt = !!chain && chain.mode !== 'replay' && !chain.scenario && sceneLoaded
  // 场景在场景页换了（2026-09-13 用户定：场景页是唯一入口，框图跟着走）：链路引用换过去，
  // 站点与目标按新场景缺省全选——旧的选择属于上一份场景，留着只会选中不存在的实体。
  const sceneChanged = !!chain && chain.mode !== 'replay' && sceneLoaded
    && !!chain.scenario && chain.scenario.scenario_id !== s.scene.scenario.id
  const needPick = !!chain && chain.mode !== 'replay' && sceneInSync
    && ((siteIdList.length > 0 && chain.siteIds.length === 0)
      || (emitterIdList.length > 0 && chain.emitterIds.length === 0))
  // 换场景那一刻 sha256 还不知道（文件没读回来），先留空；载入完成后回填。
  // 不回填的话框图的 scenario_ref.sha256 永远是空串，提交时校验通不过。
  const needSha = !!chain && chain.mode !== 'replay' && sceneInSync
    && !!chain.scenario && chain.scenario.sha256 !== s.scene.scenario.sha256
    && !!s.scene.scenario.sha256
  const needSync = needPick || needSha || needAdopt || sceneChanged
  useEffect(() => {
    if (!needSync || !chain) return
    const follow = needAdopt || sceneChanged
    const scenario = follow
      ? { scenario_id: s.scene.scenario.id!, sha256: s.scene.scenario.sha256 }
      : (chain.scenario ? { ...chain.scenario, sha256: s.scene.scenario.sha256 } : null)
    const next: ChainState = {
      ...chain,
      scenario,
      siteIds: sceneChanged || !chain.siteIds.length ? siteIdList : chain.siteIds,
      emitterIds: sceneChanged || !chain.emitterIds.length ? emitterIdList : chain.emitterIds,
    }
    const { doc } = compile(next, catalog, scenarioDoc)
    dispatch({ type: 'diagram/setDoc', text: serialize(doc, catalog),
               label: sceneChanged ? '跟随场景页切换场景' : '按载入的场景补齐站点、目标与哈希' })
  }, [needSync, needAdopt, sceneChanged, siteIdList.join(','), emitterIdList.join(','), s.scene.scenario.sha256, s.scene.scenario.id])
}

/**
 * 场景改完自动存（D-054，用户 2026-09-09 拍板「改完就自动存场景」）。
 *
 * 去抖 800 毫秒：服务端每次 PUT 都要起一次 `cuav_run --scenario-track` 做语义校验，
 * 每敲一个数字发一次等于排队起子进程。防重入在 `saveScenario` 里。
 * 保存失败**不清 dirty**，下一次改动会再试。
 */
const AUTOSAVE_MS = 800

function useScenarioAutosave(store: ReturnType<typeof useStore>, dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => {
      // 基准场景只读（用户 2026-09-19）：**改动不会保存，这件事必须说出来**。
      // 框图页上改的天线增益、噪声系数、采样率都长在场景文件里（D-054 ⑤），
      // 所以这条规则在这一页同样生效；默默不存等于把用户的输入丢了（铁律 15）。
      // 提示只出一条——同一句话不叠（reducer 的 toast 去重）。
      if (isReadonlyScenario(store.getState())) {
        store.dispatch({
          type: 'ui/toast', kind: 'warn', sticky: true,
          text: '基准场景为只读，该改动未保存；如需保留，请在场景页另存为新标识后修改',
        })
        return
      }
      void saveScenario(store)
    }, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [dirty, store])
}

/**
 * 配置焦点：现在配的是哪一架无人机、哪一个站（D-054）。
 *
 * **不进 `ChainState`**：它是视图状态，写进框图会污染文档并破坏往返。
 * 候选只在**参与运行的**实体里选；参与者变了而当前焦点已不在其中，回退到第一个——
 * 留着一个失效的 id 会让面板显示空白，用户以为参数丢了。
 */
function useFocus(list: readonly string[]): [string, (v: string) => void] {
  const [pick, setPick] = useState('')
  const cur = list.includes(pick) ? pick : (list[0] ?? '')
  return [cur, setPick]
}

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

  // **这个 hook 必须在早退之前调用**：React 要求每次渲染的 hook 顺序一致，
  // 放在 `if (!parsed) return` 之后的话，框图一旦解不开（比如编译出了新的隐含节点而反解还没跟上）
  // 就会少调一个 hook，整棵界面树当场崩（Minified React error #300）。
  // 切片 ⑥c 实测撞到过一次：`toa` 隐含节点加上去而 `parseChain` 忘了跳过它。
  useSceneSync(parsed, s, catalog, scenarioDoc, dispatch)
  useScenarioAutosave(store, s.scene.dirty)

  // 配置焦点（D-054）。候选只在参与运行的实体里选，所以要先拿到解出来的链路；
  // 但 hook 不能放在早退之后，故用空数组兜底——解不开时它本来就没有意义。
  const [focusEmitter, setFocusEmitter] = useFocus(parsed?.emitterIds ?? [])
  const [focusSite, setFocusSite] = useFocus(parsed?.siteIds ?? [])
  // 当前链路上、某个槽位归属的那个实体（D-064）：卡片摘要与「待填」都按它算
  const focusEntityOf = (id: SlotId): { id: string; entity: Obj | undefined } => {
    const owner = ownerOf(id)
    if (owner === 'shared') return { id: '', entity: undefined }
    const fid = owner === 'emitter' ? focusEmitter : focusSite
    const list = owner === 'site' ? sceneSites(scenarioDoc) : sceneEmitters(scenarioDoc)
    return { id: fid, entity: list.find((x) => String(x.id) === fid) as Obj | undefined }
  }

  // 当前框图不是本模板生成的：给一条出路，不硬解（10 报告 §5.5）
  if (!parsed) {
    // 解不开的原因如果是「用了已撤掉的变体」，照实说出来（D-059）。
    // 只说「不是典型链路」，用户会以为自己的框图坏了——它没坏，是这个页面不再提供那个零件。
    const r0 = parseDoc(s.diagram.text)
    const retired = r0.ok
      ? retiredNote((r0.doc.nodes as Array<{ type: string }>).map((n) => n.type))
      : null
    return (
      <div className="chain-view" data-chain="foreign">
        <div className="group placeholder" data-chain-foreign>
          {retired
            ? <p data-chain-retired>{retired}</p>
            : <p>当前框图不是典型链路结构，无法按环节解析。</p>}
          <p>
            <button type="button" data-action="chain-new" onClick={() => commit(newChain('synthetic'), '新建典型链路')}>
              新建典型链路
            </button>
            <span className="dim"> 将替换当前框图</span>
          </p>
          {/* 原文只读地摆在这里（D-060）。自由画布删掉之后这是唯一能看见它的地方——
              「新建典型链路」是**换掉**这份文档，不先让人看一眼、拷出去，就等于替他丢了东西
              （铁律 15）。只读是有意的：可编辑的原始 JSON 框跟画布一样难以控制，
              而这里要的只是一条不丢数据的退路。 */}
          <p className="dim">当前框图原文（只读）：</p>
          <pre className="chain-foreign-src" data-chain-foreign-src>{s.diagram.text}</pre>
        </div>
      </div>
    )
  }
  const chain = parsed
  const plan = freqPlan(chain, scenarioDoc, catalog)
  const checks = planChecks(chain, plan, scenarioDoc, catalog, s.scene.summary)
  const derivable = plan.fs_rf > 0 ? undefined : ([] as readonly string[])

  // 引擎报错按节点 id 反查槽位（节点 id 固定，10 报告 §5.4）；
  // `tapAt` 说每个观测点这一版有没有落点——信道化旁路时 s5 就没有，圆点画灰的
  const { nodeSlot, tapAt } = compile(chain, catalog, scenarioDoc)
  const errBySlot = new Map<string, string>()
  // 传播参数声明在 `ScenarioSource` 上、编译进隐含节点 `scn`，但用户是在「传播信道」卡片上改的，
  // 报错落到「试验设置」那一格他会找不到（D-058，12 §5.4）。`nodeSlot` 区分不了同一节点上的两类参数，
  // 因此按报文里出现的参数名反查代理集合——命中即改挂 `ch`，命不中照旧。
  const proxySlots = SLOTS.filter((d) => !!d.proxy)
  for (const e of s.diagram.validation?.errors ?? []) {
    let slot = e.node_id ? nodeSlot[e.node_id] : undefined
    if (slot === 'scn') {
      const hit = proxySlots.find((d) => d.proxy!.params.some((n) => e.message.includes(n)))
      if (hit) slot = hit.id
    }
    errBySlot.set(slot ?? '__setup', `[${e.code}] ${e.message}`)
  }

  /** 改一个槽位参数（D-054）：按范围写共用底值、同型号的每个实体、或只写当前实体。 */
  const setSlotParam = (
    id: SlotId, name: string, v: ParamValue | undefined, scope: ParamScope, targets: readonly string[],
  ) => {
    const next = writeParam(chain, id, name, v, scope, targets)
    const label = scope === 'shared' ? `改 ${name}` : `改 ${name}（${targets.join('、')}）`
    commit({ ...chain, slots: { ...chain.slots, [id]: next } }, label)
  }

  /**
   * 改一个**场景里的**设备参数（D-054）。写的是场景文档不是框图——这些字段的真理源在
   * 场景文件，框图只是它的投影，改完由 `useScenarioAutosave` 存盘、`useSceneSync` 回填哈希。
   */
  const setSceneField = (path: string, v: unknown) => {
    if (!scenarioDoc) return
    dispatch({ type: 'scene/edit', doc: setPath(scenarioDoc, path, v) })
  }

  const sites = sceneSites(scenarioDoc)
  const emitters = sceneEmitters(scenarioDoc)
  const siteIdList = sites.map((x) => String(x.id))
  const emitterIdList = emitters.map((x) => String(x.id))


  // 勾选观测点只改框图，不会动已经跑完的任务——产品要下次运行才有。
  // 不提示的话，勾完切到结果页看不到新观测点，会以为勾选没生效（2026-09-08 用户反馈）。
  const wantTaps = TAP_ORDER.filter((t) => chain.taps[t] && tapAt[t])
  const ranTaps = s.task.observationPoints.map((o: { op_id: string }) => o.op_id)
  // 多站下产品目录名带实例后缀（`s1__site-2`，D-053 §2.6）。比较的是「勾了哪几个观测点」，
  // 所以先去掉后缀再去重——不去的话每个实例化的 id 都落在 TAP_ORDER 之外被整批丢掉，
  // 结果是「跑完就一直提示不一致」。
  const ranBases = [...new Set(ranTaps
    .map((x: string) => { const i = x.indexOf(INST_SEP); return i < 0 ? x : x.slice(0, i) })
    .filter((x: string) => (TAP_ORDER as readonly string[]).includes(x)))]
  ranBases.sort((a, b) => TAP_ORDER.indexOf(a as TapId) - TAP_ORDER.indexOf(b as TapId))
  const tapsStale = !!s.task.id && wantTaps.join(',') !== ranBases.join(',')

  return (
    <div className="chain-view" data-chain="ready">
      <ColumnLayout
        left={
          <ExperimentSetup
            chain={chain} checks={checks} plan={plan}
            currentScenario={s.scene.scenario.id}
            sites={siteIdList}
            emitters={emitterIdList}
            error={errBySlot.get('__setup') ?? null}
            scenarioReadonly={isReadonlyScenario(s)}
            onChange={commit}
          />
        }
        right={
          <SlotPanel
            chain={chain} id={selected} catalog={catalog}
            derivable={derivable}
            scenario={scenarioDoc}
            focusEmitter={focusEmitter} focusSite={focusSite}
            onParam={(n, v, scope, targets) => setSlotParam(selected, n, v, scope, targets)}
            onSceneField={setSceneField}
          />
        }
        center={
        <div className="chain-main">
          <div className="chain-bar">
            <span className="chain-mode">{MODE_LABEL[chain.mode]}链路</span>
            <span className="chain-id" data-chain-id>{chain.diagram_id}{s.diagram.dirty ? ' •' : ''}</span>
            {tapsStale && (
              <span className="chain-stale" data-chain-taps-stale>
                观测点与当前任务不一致（现在是 {ranBases.length ? ranBases.join('、').toUpperCase() : '无'}），重新运行后生效
              </span>
            )}
            <span className="spacer" />
            <button type="button" data-action="chain-save" title="保存到服务端（Ctrl+S）"
              onClick={() => void saveDiagram(store)}>保存</button>
          </div>

          {/* 配置焦点（D-054）：选中哪一架无人机、哪一个站，右栏就配谁的设备参数。
              这一行与上面那行分开——上面是文档级操作（存盘、换形态），这里是配置焦点，
              混在一行里两种语义会打架。传播信道与多站定位不随它变，面板上会写明。 */}
          {chain.mode !== 'replay' && (
            <div className="chain-entity-bar" data-chain-entity-bar>
              <span className="chain-entity-lead" title="选择要查看与编辑的那一条链路；参与计算的实例在左栏勾选">当前链路</span>
              <EntityPick label="无人机" kind="emitter" doc={scenarioDoc}
                ids={chain.emitterIds} value={focusEmitter} onChange={setFocusEmitter} />
              <EntityPick label="侦测站" kind="site" doc={scenarioDoc}
                ids={chain.siteIds} value={focusSite} onChange={setFocusSite} />
              <span className="spacer" />
              <span className="chain-scene-state" data-scene-save-state={s.scene.dirty ? 'dirty' : 'saved'}>
                {s.scene.dirty ? '场景改动保存中…' : '场景已保存'}
              </span>
            </div>
          )}

          {/* 链条块撑满工具条以下的高度并纵向居中：链条只有一行卡片，靠顶排会在 2K 屏上
              留一大片空白（2026-09-08 用户反馈）。错误列表留在块外，出错时不推动链条位置。 */}
          <div className="chain-body">
          <div className="chain-strip" data-chain-strip>
            {GRID_SLOTS.map((def, i) => {
              const st = slotState(chain, def.id, catalog)
              const p = snakePos(i, GRID_SLOTS.length)
              const missingOf = (id: SlotId, state: typeof st): string[] => state === 'active'
                ? missingParams(chain, id, catalog, derivable,
                    (f) => typeof readField(focusEntityOf(id).entity, f.rel) === 'number', focusEntityOf(id).id)
                : []
              // 挂在这张卡片里的子环节（C-4）：只在宿主启用时画，各自有状态、待填与报错
              const members = st === 'active' ? groupMembers(def.id).map((m) => {
                const ms = slotState(chain, m.id, catalog)
                return { id: m.id, label: m.label, state: ms, selected: selected === m.id,
                  error: errBySlot.get(m.id) ?? null, missing: missingOf(m.id, ms) }
              }) : []
              return (
                <div className="chain-cell" key={def.id}
                     style={{ gridColumn: p.col, gridRow: p.row + 1 }}
                     data-chain-pos={`${p.row + 1}:${p.col}`}>
                  <SlotCard
                    chain={chain} id={def.id} catalog={catalog} state={st}
                    selected={selected === def.id || members.some((m) => m.selected)}
                    members={members}
                    focusEmitter={focusEmitter} focusSite={focusSite} focusEntity={focusEntityOf(def.id).entity}
                    missing={missingOf(def.id, st)}
                    error={errBySlot.get(def.id) ?? null}
                    onSelect={setSelected}
                    onVariant={(id, variant) =>
                      commit({ ...chain, slots: { ...chain.slots, [id]: { ...chain.slots[id], variant } } }, '换变体')}
                    onBypass={(id, bypass) =>
                      commit({ ...chain, slots: { ...chain.slots, [id]: { ...chain.slots[id], bypass } } }, bypass ? '旁路' : '启用')}
                    onLevel={(level) => setSlotParam(def.id, 'prop_level', level, 'shared', [])}
                  />
                  {p.next === 'right' && <span className="chain-conn to-right" aria-hidden>→</span>}
                  {p.next === 'left' && <span className="chain-conn to-left" aria-hidden>←</span>}
                  {p.next === 'down' && <span className="chain-turn" data-chain-turn aria-hidden>↓</span>}
                </div>
              )
            })}
          </div>

          <TapRow chain={chain} tapAt={tapAt} onToggle={(t, on) =>
            commit({ ...chain, taps: { ...chain.taps, [t]: on } }, on ? `打开 ${t}` : `关掉 ${t}`)} />
          </div>

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
  currentScenario: string | null
  sites: string[]
  emitters: string[]
  error: string | null
  /** 当前场景是基准场景（只读）：设备参数改了也存不下去，得说出来 */
  scenarioReadonly: boolean
  onChange: (next: ChainState, label: string) => void
}

/**
 * 站点 / 目标的多选（D-053 §5.1）。用复选框而不是多选列表：
 * 场景里的站与源都只有个位数，一眼看全比按住 Ctrl 点更省事，端到端也好定位
 * （`[data-field="site:<id>"]`）。
 */
function MultiPick(p: {
  label: string
  kind: 'site' | 'emitter'
  all: readonly string[]
  picked: readonly string[]
  onChange: (v: string[]) => void
}) {
  const toggle = (id: string): void => {
    const has = p.picked.includes(id)
    p.onChange(has ? p.picked.filter((x) => x !== id) : [...p.all].filter((x) => x === id || p.picked.includes(x)))
  }
  return (
    <div className="form-row pp-line">
      <span className="form-label">{p.label}{p.picked.length > 1 ? ` ×${p.picked.length}` : ''}</span>
      <div className="form-value pp-checks" data-multi={p.kind}>
        {p.all.length === 0 && <span className="muted">（先选场景）</span>}
        {p.all.map((x) => (
          <label key={x} className="pp-check">
            <input type="checkbox" data-field={`${p.kind}:${x}`}
              checked={p.picked.includes(x)} onChange={() => toggle(x)} />
            {x}
          </label>
        ))}
      </div>
    </div>
  )
}

/**
 * 背景片段挑单 + 一行相容性事实（U-4 顺带补，D-075）。
 *
 * `AddMixer` 要求两路的采样率与中心频率一致（`models/adc-ddc/README.md` §8.3），对不上就拒绝相加。
 * 引擎的报错很准，但它发生在**提交之后**——会留下一个失败任务。这里在提交前把两边的数摆出来。
 *
 * **只摆事实**：写清背景是多少、站点是多少，不替用户判断该改哪一头（D-039）。
 * 逐产物清单不在本机时采样率读不到，那就照说读不到，不猜（铁律 15）。
 */
function BackgroundPick(p: { value: string | null; fsRf: number; fRx: number; onChange: (v: string | null) => void }) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (!p.value) { setNote(null); return }
    let alive = true
    void getDataset(p.value).then((d) => {
      if (!alive) return
      if (!d) { setNote({ ok: false, text: '该标识不在数据索引中' }); return }
      const sampling = (d.manifest?.sampling ?? {}) as Record<string, unknown>
      const freq = (d.manifest?.frequency ?? {}) as Record<string, unknown>
      const fs = typeof sampling.sample_rate_Hz === 'number' ? sampling.sample_rate_Hz : null
      const raw = freq.center_frequency_Hz ?? d.index.center_frequency_Hz
      const fc = typeof raw === 'number' ? raw : null
      if (fs === null) { setNote({ ok: true, text: '本机无该片段的逐产物清单，采样率一致性由引擎在运行时校验' }); return }
      // 只点出**真正对不上的那一项**：两边都写出来的话，2.4410 GHz 与 2.4400 GHz 在粗一点的
      // 格式下会印成同一个数，那句话读起来自相矛盾（第一版就是这样）
      const bad: string[] = []
      if (fs !== p.fsRf) bad.push(`采样率 ${fmtHz(fs)} ≠ 站点 ${fmtHz(p.fsRf)}`)
      if (fc !== p.fRx) bad.push(`中心频率 ${fmtHz(fc ?? 0)} ≠ 站点 ${fmtHz(p.fRx)}`)
      setNote(bad.length === 0
        ? { ok: true, text: `与站点一致：${fmtHz(fs)} / ${fmtHz(fc ?? 0)}` }
        : { ok: false, text: `${bad.join('，')}——两路必须一致，否则相加会被拒` })
    }).catch(() => { if (alive) setNote(null) })
    return () => { alive = false }
  }, [p.value, p.fsRf, p.fRx])
  return (
    <>
      <DataIdField value={p.value ?? ''} onChange={(v) => p.onChange(v ?? null)} />
      {note && <div className={note.ok ? 'data-pick-note' : 'pp-warn'} data-background-note data-ok={note.ok ? '1' : '0'}>{note.text}</div>}
    </>
  )
}

function ExperimentSetup(p: SetupProps) {
  const c = p.chain
  return (
    <div className="chain-setup" data-form="chain-setup">
      <div className="group">
        <div className="pp-title">试验设置</div>
        <label className="form-row pp-line"><span className="form-label">模式</span>
          <span className="form-value"><select className="form-input" data-field="mode" value={c.mode}
            onChange={(e) => p.onChange(switchMode(c, e.target.value as ChainMode), '换模式')}>
            {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select></span>
        </label>
        {c.mode !== 'replay' && p.scenarioReadonly && (
          <div className="muted ds-note" data-chain-scenario-readonly>
            基准场景为只读：本页的设备参数（天线增益、噪声系数、采样率）存放在场景文件中，改动不会被保存。
            如需保留，请在场景页另存为新标识。
          </div>
        )}
        {c.mode !== 'replay' && (
          <>
            {/* 场景在场景页选（2026-09-13 用户定）：这里只写当前跟着的是哪一份，不给第二个入口（D-057 同理） */}
            <div className="form-row pp-line" title="在场景页左栏切换场景；框图跟随场景页当前载入的场景">
              <span className="form-label">场景</span>
              <span className="form-value pp-ro" data-chain-scenario>{c.scenario?.scenario_id ?? p.currentScenario ?? '（未选）'}</span>
            </div>
            {/* 站点与目标都是多选（D-053）：K 个站各跑一条接收链，N 个源在接收天线后叠加。
                至少各选一个——一个都不选就没有链路可算，此时提交按钮由频率计划检查拦住。 */}
            <MultiPick label="站点" kind="site" all={p.sites} picked={c.siteIds}
              onChange={(v) => p.onChange({ ...c, siteIds: v }, '选站点')} />
            <MultiPick label="目标" kind="emitter" all={p.emitters} picked={c.emitterIds}
              onChange={(v) => p.onChange({ ...c, emitterIds: v }, '选目标')} />
          </>
        )}
        {/* 背景片段（混合增强）。此前**没有任何界面入口**：格式、编译、评价器都接好了，
            `plan.ts` 的「标度与单位一致」也在检查它，就是没处填——于是混合增强这条链
            只有 `_gen.ts` 夹具跑得起来，界面上提交不了（2026-09-19 核实，U-4 顺带补，D-075）。
            用的是辐射源那边同一个挑单组件，一个口径一处。 */}
        {c.mode === 'mixed' && (
          <div className="form-row pp-line" data-form="background-data">
            <span className="form-label">背景片段</span>
            <span className="form-value">
              <BackgroundPick value={c.backgroundDataId} fsRf={p.plan.fs_rf} fRx={p.plan.f_rx}
                onChange={(v) => p.onChange({ ...c, backgroundDataId: v }, '选背景片段')} />
            </span>
          </div>
        )}
        <label className="form-row pp-line"><span className="form-label">时长</span>
          <span className="form-value"><input className="form-input" data-field="duration_s" defaultValue={String(c.run.duration_s)}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v > 0 && v !== c.run.duration_s) p.onChange({ ...c, run: { ...c.run, duration_s: v } }, '改时长')
            }} /><span className="form-unit">s</span></span>
        </label>
        <label className="form-row pp-line"><span className="form-label">种子</span>
          <span className="form-value"><input className="form-input" data-field="seed" defaultValue={String(c.run.seed)}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (Number.isInteger(v) && v >= 0 && v !== c.run.seed) p.onChange({ ...c, run: { ...c.run, seed: v } }, '改种子')
            }} /></span>
        </label>
        {p.error && <div className="pp-warn" data-setup-error>{p.error}</div>}
      </div>

      <div className="group" data-freq-plan>
        <div className="pp-title">频率计划</div>
        <div className="form-row pp-line"><span className="form-label">宽带采样率</span><span className="form-value pp-ro">{formatEng(p.plan.fs_rf)}Hz</span></div>
        <div className="form-row pp-line"><span className="form-label">观测中心</span><span className="form-value pp-ro">{formatEng(p.plan.f_rx)}Hz</span></div>
        <div className="form-row pp-line"><span className="form-label">S4 采样率</span><span className="form-value pp-ro">{formatEng(p.plan.fs_s4)}Hz</span></div>
        {/* 每条检查一行；通过的把依据收进悬停提示，不通过才把原因写在行下——八句话一次铺开是堆砌（2026-09-13 用户实测） */}
        <ul className="plan-checks">
          {p.checks.map((k) => (
            <li key={k.id} data-check={k.id} data-ok={k.ok ? '1' : '0'} data-detail={k.detail} title={k.detail}>
              <span className={k.ok ? 'ok' : 'bad'}>{k.ok ? '✓' : '✕'}</span> {k.label}
              {!k.ok && <div className="plan-detail">{k.detail}</div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * 实体选择框（D-054）。候选只列**参与运行的**实体——左栏的多选决定谁参与，这里决定配谁。
 * 条目写「id · 名称 · 型号」：光有 id 在三站三源的场景里认不出是哪一台。
 */
function EntityPick(p: {
  label: string
  kind: DeviceKind
  doc: ScenarioDoc | null
  ids: readonly string[]
  value: string
  onChange: (v: string) => void
}) {
  const all = (p.kind === 'site' ? sceneSites(p.doc) : sceneEmitters(p.doc))
  const byId = new Map(all.map((x) => [String(x.id), x]))
  const text = (id: string): string => {
    const o = byId.get(id)
    if (!o) return id
    const name = typeof o.name === 'string' && o.name ? o.name : ''
    return [id, name, modelOf(p.kind, o)].filter(Boolean).join(' · ')
  }
  return (
    <label className="chain-entity">
      <span>{p.label}</span>
      <select data-field={`focus-${p.kind}`} value={p.value}
        onChange={(e) => p.onChange(e.target.value)}>
        {p.ids.length === 0 && <option value="">（先选场景）</option>}
        {p.ids.map((x) => <option key={x} value={x}>{text(x)}</option>)}
      </select>
    </label>
  )
}

/** 在组件条目里找一个参数的描述（模板固定值查中文名时用）。 */
function specOf(spec: { params: unknown[] } | null, name: string): ParamSpec | undefined {
  return (spec?.params as ParamSpec[] | undefined)?.find((x) => x.name === name)
}

// ------------------------------------------------------------------ 右栏

/** 派生参数从哪里来（只读显示的那一行说明）。评价器的三项各有来处（C-5），其余槽位由频率计划派生。 */
function derivedNote(slot: SlotId, param: string): string {
  if (slot === 'feat') return '与检测器相同'
  if (slot === 'eval') {
    if (param === 'nfft') return '与检测器相同'
    if (param === 'truth_source') return '由信号源模式决定'
    if (param === 'data_id') return '随信号源（回放）或背景片段（混合）带出'
  }
  return '由频率计划派生'
}

function SlotPanel(p: {
  chain: ChainState
  id: SlotId
  catalog: Catalog | null
  derivable: readonly string[] | undefined
  scenario: ScenarioDoc | null
  focusEmitter: string
  focusSite: string
  onParam: (name: string, v: ParamValue | undefined, scope: ParamScope, targets: readonly string[]) => void
  onSceneField: (path: string, v: unknown) => void
}) {
  /**
   * 用户选的设置范围（D-054）。**必须记在这里**：范围本身是从「各实体的值一不一致」派生的，
   * 只改下拉不改值，重编译后立刻被归约打回「共用」，用户就永远选不动它。
   * 记下来的是**意图**，下一次改值时按它写。键带槽位与实体，切走再切回来不会串。
   * hook 要在早退之前声明，否则解不开的槽位少调一个 hook，整棵树当场崩（React error #300）。
   */
  const [scopePick, setScopePick] = useState<Record<string, ParamScope>>({})

  const def = SLOT_BY_ID[p.id]
  const v = variantOf(p.chain, p.id)
  const st = slotState(p.chain, p.id, p.catalog)
  const spec = p.catalog ? findComponent(p.catalog, v.type) : null
  if (!spec) return <div className="group placeholder">{def.label}：{v.type} 尚未实现</div>
  if (st === 'not_applicable') return <div className="group placeholder">{def.label}：回放数据已含，参数不可编辑</div>

  // 这个槽位的参数归谁（D-054）：无人机侧、侦测站侧，还是全图共用
  const owner = ownerOf(p.id)
  const kind: DeviceKind | null = owner === 'shared' ? null : owner
  const focus = owner === 'emitter' ? p.focusEmitter : owner === 'site' ? p.focusSite : ''
  const participants = owner === 'emitter' ? p.chain.emitterIds
    : owner === 'site' ? p.chain.siteIds : []
  const list = kind === 'site' ? sceneSites(p.scenario) : kind === 'emitter' ? sceneEmitters(p.scenario) : []
  const byId = new Map(list.map((x) => [String(x.id), x as Obj]))
  const entity = focus ? byId.get(focus) : undefined
  const model = kind ? modelOf(kind, entity) : ''
  const sameModel = kind
    ? participants.filter((e) => modelOf(kind, byId.get(e)) === model)
    : []
  const index = focus ? list.findIndex((x) => String(x.id) === focus) : -1

  const fixed = v.fixed ?? {}
  const derived = DERIVED_PARAMS[p.id] ?? []
  const derivedNames = new Set(
    p.derivable === undefined ? derived : derived.filter((n) => p.derivable!.includes(n)),
  )
  // 由场景带出的参数：面板上给出**可编辑**的场景字段，改动写场景不写框图
  const fromScene = fromSceneOf(p.id)
  const sceneNames = new Map(fromScene.map((f) => [f.name, f]))
  const sceneHas = (f: { rel: string }) => typeof readField(entity, f.rel) === 'number'
  const pending = missingParams(p.chain, p.id, p.catalog, p.derivable, sceneHas, focus)

  const scopeKey = (name: string) => `${p.id}:${focus}:${name}`
  const scopeOf = (name: string): ParamScope => {
    if (!kind) return 'shared'
    const picked = scopePick[scopeKey(name)]
    if (picked) return picked
    return paramScope(p.chain, p.id, name, participants, (e) => modelOf(kind, byId.get(e)))
  }

  return (
    <div className="param-panel" data-form="slot">
      <div className="group">
        <div className="pp-title" title={`${def.hint} · ${v.type}`}>{def.label} · {spec.display_name}</div>
        {/* 归属只写一行（D-054）：谁的参数、什么型号；环节与组件名收进标题的悬停提示 */}
        <div className="pp-sub" data-slot-owner={owner}>
          {owner === 'shared'
            ? '全图共用'
            : `${owner === 'emitter' ? '无人机' : '侦测站'} ${focus || '（未选）'}${model ? ` · 型号 ${model}` : ''}`}
        </div>
        {pending.length > 0 && <div className="pp-warn" data-pending>待填：{pending.map((n) => paramLabel({ name: n })).join('、')}</div>}
      </div>

      {/* 场景里的设备参数（D-054）：真理源在场景文件，这里改即改场景，随后自动保存 */}
      {kind && entity && index >= 0 && (
        <div className="group" data-form="entity-device">
          <div className="pp-title">设备参数 · 来自场景</div>
          {fieldsFor(kind, entity).map((f) => (
            <DeviceRow key={f.key} field={f} entity={entity} kind={kind} index={index}
              onCommit={p.onSceneField} />
          ))}
        </div>
      )}

      {/* 传播效应（D-058）：参数声明在 `ScenarioSource` 上、编译进隐含节点 `scn`，
          但用户要在这张卡片上配。按当前档位决定显隐——十五行一次全摆出来找不到东西。 */}
      <PropagationGroup slot={p.id} chain={p.chain} catalog={p.catalog} onParam={p.onParam} />

      <div className="group">
        <div className="pp-title">模型参数</div>
        {/* 模板固定的参数合成一行：它们不给改，逐行摆出来只是占地方 */}
        {Object.keys(fixed).length > 0 && (
          <div className="pp-sub">
            模板固定：
            {Object.entries(fixed).map(([k, val], i) => (
              <span key={k} data-param-fixed={k}>{i > 0 ? '、' : ''}{paramLabel({ name: k })} = {valueLabel(specOf(spec, k), val)}</span>
            ))}
          </div>
        )}
        {(spec.params as ParamSpec[]).filter((ps) => !ps.internal && !(ps.name in fixed)).map((ps) => {
          const title = paramTitle(ps, range(ps))
          if (derivedNames.has(ps.name)) {
            return (
              <PRow key={ps.name} label={paramLabel(ps)} title={title} attrs={{ 'data-param-derived': ps.name }}>
                <span className="pp-note">{derivedNote(p.id, ps.name)}</span>
              </PRow>
            )
          }
          const sf = sceneNames.get(ps.name)
          if (sf) {
            // 由场景逐实体带出：值在上面那组里改，这里只说明来源，免得两处都能改却不同步
            const val = readField(entity, sf.rel)
            return (
              <PRow key={ps.name} label={paramLabel(ps)} title={title} attrs={{ 'data-param-from-scene': ps.name }}
                unit={typeof val === 'number' ? ps.unit : undefined} tag={typeof val === 'number' ? '来自场景' : '来自场景 · 未设置'}>
                {typeof val === 'number' && <span className="pp-ro">{val}</span>}
              </PRow>
            )
          }
          const scope = scopeOf(ps.name)
          const cur = focus
            ? (p.chain.slots[p.id].byEntity?.[focus]?.[ps.name] ?? p.chain.slots[p.id].params[ps.name])
            : p.chain.slots[p.id].params[ps.name]
          const targets = scope === 'entity' ? (focus ? [focus] : []) : sameModel
          return (
            <PRow key={ps.name} label={paramLabel(ps)} title={title} unit={ps.unit} htmlFor={ps.name}>
              <Field ps={ps} value={cur} onChange={(x) => p.onParam(ps.name, x, scope, targets)} />
              {kind && participants.length > 1 && (
                <select className="pp-scope" data-param-scope={ps.name} value={scope}
                  title="改这一项影响谁"
                  onChange={(e) => {
                    const next = e.target.value as ParamScope
                    setScopePick((m) => ({ ...m, [scopeKey(ps.name)]: next }))
                    // 收回「共用」要当场生效：把覆盖清掉，三个站立刻回到一套参数。
                    // 另外两档只记意图——此刻各实体的值还一样，写下去会被归约原样打回。
                    if (next === 'shared') p.onParam(ps.name, cur, 'shared', [])
                  }}>
                  <option value="shared">共用</option>
                  <option value="model">同型号</option>
                  <option value="entity">单独</option>
                </select>
              )}
            </PRow>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 参数面板的一行：与场景对象表单同一套网格（`.form-row`：标签列固定宽、控件占满、单位跟在后面）。
 * 标签只放中文短名，英文标识、说明与范围在悬停提示里——直接铺出来又长又乱（2026-09-13 用户实测）。
 */
function PRow(p: {
  label: string
  title?: string
  unit?: string
  tag?: string
  htmlFor?: string
  attrs?: Record<string, string>
  children?: ReactNode
}) {
  return (
    <label className="form-row pp-line" {...(p.attrs ?? {})}>
      <span className="form-label" title={p.title}>{p.label}</span>
      <span className="form-value pp-value">
        {p.children}
        {p.unit && <span className="form-unit">{p.unit}</span>}
        {p.tag && <span className="pp-tag">{p.tag}</span>}
      </span>
    </label>
  )
}

/**
 * 传播效应分组（D-058，12 §5.2）。它渲染的是**别的组件的 `ParamSpec`**——
 * 参数只声明一次（在真正用它的 `ScenarioSource` 上），这里只负责显示与转发。
 *
 * `ch` 的 `owner` 是 `shared`，所以一律按共用底值写（`scope = 'shared'`），
 * 不给「同型号 / 单独」三档：传播信道全图一份，用户 2026-09-09 明确要求它不随实体选择变化。
 */
function PropagationGroup(p: {
  slot: SlotId
  chain: ChainState
  catalog: Catalog | null
  onParam: (name: string, v: ParamValue | undefined, scope: ParamScope, targets: readonly string[]) => void
}) {
  const px = proxyOf(p.slot)
  if (!px) return null
  const host = p.catalog ? findComponent(p.catalog, px.type) : null
  if (!host) {
    return (
      <div className="group placeholder" data-form="propagation">
        传播效应：目录里没有 {px.type}，重启应用服务即可刷新目录
      </div>
    )
  }
  const cur = splitProxy(p.slot, p.chain.slots[p.slot].params).proxy
  const view = propView(p.chain.slots[p.slot].params)
  const show = new Set(visiblePropParams(view))
  const conflict = propConflict(view)
  const rows = (host.params as ParamSpec[])
    .filter((ps) => !ps.internal && show.has(ps.name) && ps.name !== 'prop_level')

  return (
    <div className="group" data-form="propagation">
      <div className="pp-title">传播效应 · 全图共用</div>
      <div className="pp-sub" data-prop-summary={view.terms.join(',')}>本档包含：{view.text}</div>
      {conflict && <div className="pp-warn" data-prop-conflict>{conflict}</div>}

      {/* **档位不在这儿**：它自 2026-09-18 起在卡片上（用户指示）。`visiblePropParams` 仍然
          含 prop_level——那张表同时决定「编译时把哪些参数写给 scn 节点」（compile.ts），
          去掉它整条传播配置就不会被写进框图了。这里只是不重复渲染它。 */}
      {rows.length === 0 ? (
        <div className="pp-line dim">
          {view.level === 'E1'
            ? 'E1 档只计自由空间路径损耗、多普勒频移与传播时延，无逐项开关；档位在传播信道卡片上选择。'
            : '该档位无可调的逐项开关。'}
        </div>
      ) : rows.map((ps) => (
        <PRow key={ps.name} label={paramLabel(ps)} title={paramTitle(ps, range(ps))} unit={ps.unit}>
          <Field ps={ps} value={cur[ps.name]} onChange={(x) => p.onParam(ps.name, x, 'shared', [])} />
        </PRow>
      ))}
    </div>
  )
}


// ------------------------------------------------------------------ 观测点行

/**
 * 观测点一行（10 报告 §5.1）。勾上即在链上那条边取信号，产出频谱与包络。
 *
 * **写全名不只写编号**：只写 `S0…S5` 谁也不知道那是什么，名称原来只在 `title` 悬停提示里
 * ——等于没写（2026-09-08 用户反馈）。六个全名在 2K 基线下一行放得下。
 * 所在环节旁路或未实现时（如信道化未实现时的 S5）置灰禁用，不隐藏。
 */
function TapRow(p: {
  chain: ChainState
  tapAt: Partial<Record<TapId, unknown>>
  onToggle: (t: TapId, on: boolean) => void
}) {
  return (
    <div className="tap-row" data-tap-row>
      <span className="tap-lead dim">观测点</span>
      {TAP_ORDER.map((t) => {
        const at = !!p.tapAt[t]
        return (
          <label key={t} className={`tap${at ? '' : ' dim'}`} data-tap={t}
            title={at ? '在该环节输出处取样，下次运行输出频谱与包络' : '该观测点无对应节点：所在环节已旁路或尚未实现'}>
            <input
              type="checkbox"
              data-tap-toggle={t}
              disabled={!at}
              checked={!!p.chain.taps[t] && at}
              onChange={(e) => p.onToggle(t, e.target.checked)}
            />
            {TAP_ANCHOR[t].label}
          </label>
        )
      })}
      <span className="tap-hint dim">勾选的观测点在下次运行时输出频谱与包络，结果页按观测点分列</span>
    </div>
  )
}
