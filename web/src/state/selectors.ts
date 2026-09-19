// 纯派生函数：轴标文字、状态条文字、探针 app 子对象（09 §10）。

import { parse as parseDoc } from '../diagram/doc.js'
import { parseChain } from '../chain/compile.js'
import { SLOTS, TAP_ORDER, effectiveParams, slotState } from '../chain/model.js'
import { freqPlan, planChecks } from '../chain/plan.js'
import { isCatalog } from '../api/catalog.js'

import type { AppState, CalibrationSource, ProductIndex, WsState } from './types.js'
import type { SignalViewState } from '../signal/viewStore.js'
import { spectrumGeomOf } from '../signal/viewport.js'
import type { probeCards, probeSiteCards } from '../scene/cards/derive.js'
import type { probeDetections } from '../results/detectionStore.js'
import type { probeRecognitions } from '../results/recognitionStore.js'
import type { probeMetrics } from '../results/metricsStore.js'
import { probeTruth } from '../results/truthStore.js'
import { probeTimeline3 } from '../results/timeline3.js'
import { zones } from '../scene/editor/scenarioOps.js'
import { focusTargetId } from '../scene/focus.js'

export const SOURCE_LABEL: Record<CalibrationSource, string> = { measured: '实测', paper: '论文', assumed: '假定', model: '模型' }

/**
 * 纵轴文字。用户看到的只有 `dBm`（D-047 ④：来源徽标不给用户显示）；开发者模式带「标定：来源」。
 * 索引没有标定常数一律 `dBFS（未标定）`——包括写了 dBm 却没带 calibration 的索引（铁律 15，D-020）。
 */
export function scaleLabel(index: ProductIndex | null, dev: boolean): string | null {
  if (!index) return null
  if (index.scale === 'dBm' && index.calibration) {
    return dev ? `dBm · 标定：${SOURCE_LABEL[index.calibration.source] ?? index.calibration.source}` : 'dBm'
  }
  return 'dBFS（未标定）'
}

/**
 * 观测点产品的结果四态提示（09 §13.2「降级时图上叠一行原因」；铁律 15 不静默降级）。
 * `valid` 或没有索引时为 null；有原因就带上第一条，没有原因也要说出状态本身。
 */
export function productStateNote(index: ProductIndex | null): { text: string; tone: 'warn' | 'bad' | 'na' } | null {
  if (!index || index.state === 'valid') return null
  const label = index.state === 'degraded' ? '降级' : index.state === 'invalid' ? '无效' : '不适用'
  const tone = index.state === 'degraded' ? 'warn' : index.state === 'invalid' ? 'bad' : 'na'
  const reason = (index.state_reasons ?? []).find((r) => !!r)
  return { text: reason ? `${label}：${reason}` : label, tone }
}

export function timeBasis(s: AppState): { text: string; attr: string } {
  const t = s.task.dataRefs > 0 ? 'FileAcquisition' : 'LogicalSim'
  return { text: `WGS-84 · AGL · ${t}`, attr: `WGS-84 AGL ${t}` }
}

export function wsStatusText(ws: WsState): string {
  if (ws.status === 'connected') return `● 已连接 seq ${ws.lastSeq}`
  if (ws.status === 'reconnecting') return `● 重连中（第 ${ws.attempt} 次，${Math.round(ws.nextRetryMs / 1000)} s 后）`
  return '● 已断开'
}

export interface ProbeExtras {
  mapInstanceId: number
  rows: number
  cols: number
  peakBin: number | null
  /** 信号页外部 store 的快照（U-3）；信号页尚未挂载时为 null */
  signalView?: SignalViewState | null
  /** 开发者模式的长任务计数（PerformanceObserver longtask） */
  longTasks?: { count: number; maxMs: number } | null
  /** 任务列表（U-4，D-075）：只出计数与状态，行内容靠 DOM 断言。新键一律可选，否则既有调用点全红 */
  taskList?: { status: string; total: number; offset: number; shown: number; selected: string | null; running: number; error: string | null } | null
  /** 数据中心（U-4，D-075）：同上，只出计数、筛选与选中 */
  dataCenter?: {
    status: string; total: number; matched: number; listed: number; truncated: boolean
    q: string; batch: string | null; className: string | null; holdout: boolean | null
    selected: string | null; detailStatus: string; detailLevel: string | null; error: string | null
  } | null
  /** 态势快照（切片 ②）：实体位置与链路读数，供 e2e 与黄金航迹对拍 */
  entities: Array<{ id: string; t_s: number; lon: number; lat: number; alt_m: number; heading_deg: number; speed_mps: number; tx_on: boolean }>
  links: Array<{ id: string; t_s: number; los: boolean; distance_m: number; pathLoss_dB: number; doppler_Hz: number }>
  bearings: Array<{ id: string; t_s: number; bearing_deg: number; sigma_deg: number; quality: string; state: string; mixture: boolean }>
  positions: Array<{ id: string; t_s: number; method: string; lon: number; lat: number; cep_m: number; crossing_deg: number; sites: number }>
  /** 目标卡与站点卡的派生读数（切片 ⑧，D-061；13 报告 §3.4），由 scene/cards/derive.ts 算 */
  cards: ReturnType<typeof probeCards>
  siteCards: ReturnType<typeof probeSiteCards>
  /** 时间轴（V-3，D-061）：t 是引擎逻辑时间；source 说明画面这一帧来自 live / replay / preview */
  timeline: { t: number | null; mode: 'live' | 'replay'; playing: boolean; speed: number; markers: number; source: 'live' | 'replay' | 'preview' }
  /** 检测行与突发（C-3，D-063），由 results/detectionStore.ts 的 probeDetections 算 */
  detections?: ReturnType<typeof probeDetections>
  /** 识别行的摘要（C-4） */
  recognitions?: ReturnType<typeof probeRecognitions>
  /** 评价指标的摘要（C-5），由 results/metricsStore.ts 的 probeMetrics 算 */
  metrics?: ReturnType<typeof probeMetrics>
  /** 真值段的摘要（C-9），由 results/truthStore.ts 的 probeTruth 算 */
  truth?: ReturnType<typeof probeTruth>
  /** 检测识别页签的时间线三行（C-9），由 results/timeline3.ts 的 probeTimeline3 算 */
  timeline3?: ReturnType<typeof probeTimeline3>
  /** 建筑几何的懒加载状态（D3-6），由 scene/occlusion/store.ts 给 */
  occlusion?: { status: string; buildings: number | null; ms: number; note: string }
  /** 最近一次视距探测（D3-7），由 scene/losProbe.ts 给；没探测过时 status = 'idle'、其余为 null */
  losProbe?: {
    status: string
    site_id: string | null
    lon: number | null
    lat: number | null
    height_agl_m: number | null
    distance_m: number | null
    line_of_sight: boolean | null
    diffraction_dB: number | null
    intrusion_m: number | null
  }
}

function probeMarkers(s: AppState, v: SignalViewState | null | undefined): Array<{ id: string; freq_Hz: number | null; level_dB: number | null }> {
  return s.signal.markers.map((m) => {
    if (m.id === 'M1') return { id: 'M1', freq_Hz: v?.m1?.f ?? m.freq_Hz, level_dB: v?.m1?.v ?? null }
    return { id: m.id, freq_Hz: m.freq_Hz, level_dB: v?.m2Level ?? null }
  })
}

function sceneCount(s: AppState, key: 'sites' | 'emitters'): number {
  const v = s.scene.scenario.doc?.[key]
  return Array.isArray(v) ? v.length : 0
}

function waypointCount(s: AppState): number {
  const routes = s.scene.scenario.doc?.routes
  if (!Array.isArray(routes)) return 0
  let n = 0
  for (const r of routes as Array<Record<string, unknown>>) if (Array.isArray(r.waypoints)) n += r.waypoints.length
  return n
}

export function probeApp(s: AppState, x: ProbeExtras) {
  const index = s.signal.index
  const v = x.signalView ?? null
  const geom = index ? spectrumGeomOf(index) : null
  return {
    view: s.ui.view,
    resultsTab: s.ui.resultsTab,
    context: {
      projectId: s.context.projectId, experimentId: s.context.experimentId, scenarioId: s.context.scenarioId,
      diagramId: s.context.diagramId, taskId: s.context.taskId, seed: s.context.seed, mode: s.context.mode,
    },
    task: {
      runState: s.task.runState, result: s.task.result, t_s: s.task.t_s, duration_s: s.task.duration_s,
      realtimeFactor: s.task.realtimeFactor, resultProvisional: s.task.resultProvisional, lastSeq: s.task.lastSeq,
    },
    ws: { status: s.ws.status, lastSeq: s.ws.lastSeq, reconnects: s.ws.reconnects, dropped: s.ws.dropped },
    drawer: { open: s.ui.drawer.open, tab: s.ui.drawer.tab },
    unsaved: { scene: s.scene.dirty, diagram: s.diagram.dirty },
    undo: {
      scene: { depth: s.scene.undo.past.length, redo: s.scene.undo.future.length },
      diagram: { depth: s.diagram.undo.past.length, redo: s.diagram.undo.future.length },
    },
    // 框图画布（切片 ③，U-2）。取自已解析的文档，画布与源码两种编辑路径都走它。
    diagram: (() => {
      const j = s.diagram.json as { nodes?: unknown[]; edges?: unknown[]; observation_points?: unknown[] } | null
      const val = s.diagram.validation
      return {
        id: s.context.diagramId,
        nodes: j?.nodes?.length ?? 0,
        edges: j?.edges?.length ?? 0,
        taps: j?.observation_points?.length ?? 0,
        // 规范文本本身。端到端要核对「某个参数写进了哪个节点」这类事，光有计数不够；
        // `window.__cuav.diagramText()` 只在 `?dev=1` 下才有，而多数端到端不开开发者模式（D-058 加）。
        text: s.diagram.text,
        dirty: s.diagram.dirty,
        parseError: s.diagram.parseError,
        validation: val ? { ok: val.ok, errors: val.errors.length } : null,
      }
    })(),
    // 典型链路视图（切片 ④a，C-7）。链路状态是框图文档的投影，这里也从同一份文档解，
    // 不是第二份状态——探针读到的与画面看到的必然一致。
    chain: (() => {
      const r = parseDoc(s.diagram.text)
      const chain = r.ok ? parseChain(r.doc) : null
      if (!chain) return { template: null as string | null }
      const plan = freqPlan(chain, s.scene.scenario.doc)
      const checks = planChecks(chain, plan, s.scene.scenario.doc)
      const slots: Record<string, string> = {}
      for (const d of SLOTS) slots[d.id] = slotState(chain, d.id, isCatalog(s.components.catalog) ? s.components.catalog : null)
      return {
        template: 'chain-v1',
        mode: chain.mode,
        scenarioId: chain.scenario?.scenario_id ?? null,
        // 数组是新口径（D-053）；两个标量保留是为了让 slice4-smoke 之类的既有断言继续成立
        siteIds: chain.siteIds,
        emitterIds: chain.emitterIds,
        // 多站定位的方法（aoa / tdoa / aoa_tdoa）。它决定编译时插不插隐含的到达时间节点，
        // 所以要能从探针上看见
        locMethod: String(chain.slots.loc.params.method ?? 'aoa'),
        siteId: chain.siteIds[0] ?? null,
        emitterId: chain.emitterIds[0] ?? null,
        slots,
        // 逐实体的单独设置（D-054）：槽位 → 实体 → 偏离共用底值的那几个参数。
        // 注意它是**归约后**的形式：底值取众数，这里只留偏离者。要断言「谁和谁一样」
        // 得看下面的 effective，而不是这里——切片 ⑥ 的用例踩过这个坑。
        byEntity: Object.fromEntries(
          SLOTS.map((d) => [d.id, chain.slots[d.id].byEntity ?? null]).filter(([, v]) => v !== null),
        ),
        // 逐实体的**有效**参数（共用底值叠上覆盖）。这才是「这个站到底按什么参数跑」，
        // 与编译进框图的值一一对应
        effective: Object.fromEntries(
          SLOTS.filter((d) => (d.owner ?? 'site') !== 'shared').map((d) => {
            const ents = (d.owner ?? 'site') === 'emitter' ? chain.emitterIds : chain.siteIds
            return [d.id, Object.fromEntries(ents.map((e) => [e, effectiveParams(chain, d.id, e)]))]
          }),
        ),
        taps: TAP_ORDER.filter((t) => chain.taps[t]),
        plan: { fs_rf: plan.fs_rf, f_rx: plan.f_rx, fs_s4: plan.fs_s4, decim: plan.decim },
        checks: Object.fromEntries(checks.map((k) => [k.id, k.ok])),
      }
    })(),
    // 场景与态势（切片 ②）。实体与链路是高频量，存在 sceneStore 里，探针取当前快照。
    scene: {
      scenarioId: s.scene.scenario.id,
      scenarioSha256: s.scene.scenario.sha256,
      status: s.scene.scenario.status,
      dirty: s.scene.dirty,
      tool: s.scene.editor.tool,
      selection: s.scene.editor.selection,
      /** 焦点目标（D-062）：右栏焦点卡与地图全套叠加都跟它 */
      focus: focusTargetId(s),
      sites: sceneCount(s, 'sites'),
      emitters: sceneCount(s, 'emitters'),
      waypoints: waypointCount(s),
      zones: zones(s.scene.scenario.doc).map((z) => ({ id: String(z.id), kind: String(z.kind), radius_m: Number(z.radius_m) })),
    },
    // 建筑几何的懒加载（D3-6）。`status` 在没人要它之前必须是 `idle`——
    // 那 15.9 MB 只有真要算遮挡时才取，端到端据此验「懒加载确实懒住了」。
    occlusion: x.occlusion,
    losProbe: x.losProbe,
    entities: x.entities,
    links: x.links,
    // 逐项挑而不是整包展开——这里漏了新字段就在探针上看不见，切片 ⑥b 踩过一次
    bearings: x.bearings,
    positions: x.positions,
    cards: x.cards,
    siteCards: x.siteCards,
    timeline: x.timeline,
    signal: {
      opId: s.signal.opId,
      viewport: s.signal.viewport,
      rows: Math.max(index?.rows_available ?? 0, x.rows),
      cols: index?.row_len ?? x.cols,
      peakBin: x.peakBin,
      scaleLabel: scaleLabel(index, s.ui.devMode),
      calibration: s.signal.display.calibration,
      waterfallNewestRow: 'top' as const,
      markers: probeMarkers(s, v),
      mode: v?.mode ?? (s.signal.follow ? 'follow' : 'browse'),
      follow: s.signal.follow,
      cursor_t_s: s.signal.cursor_t_s,
      stat: s.signal.viewport.stat,
      trace: s.signal.display.trace,
      geom: geom ? { nfft: geom.nfft, bw: geom.bw, dt: geom.dt, center_Hz: index?.center_Hz ?? 0, t0_s: index?.t0_s ?? 0 } : null,
      lastFetch: v?.lastFetch
        ? {
            rows: v.lastFetch.spec.rows, cols: v.lastFetch.spec.cols, px: v.lastFetch.key.px, py: v.lastFetch.key.py,
            t0: v.lastFetch.spec.t0, t1: v.lastFetch.spec.t1, f0: v.lastFetch.spec.f0, f1: v.lastFetch.spec.f1,
            stat: v.lastFetch.key.stat, state: v.lastFetch.state, envRows: v.lastFetch.env?.rows ?? null,
          }
        : null,
      fetchStatus: v?.fetchStatus ?? 'idle',
      bounds: v?.bounds ?? { spectrum: null, waterfall: null },
      canvas: v ? { W: v.W, H: v.H, dpr: v.dpr } : null,
      drawnRows: v?.drawnRows ?? 0,
      hatchedRows: v?.hatchedRows ?? 0,
      liveFrames: v?.liveFrames ?? 0,
      liveRows: v?.liveRows ?? 0,
      shown: v?.shown ?? null,
      envelopeRows: s.signal.envelopeIndex?.rows_available ?? 0,
      overlayDetections: s.signal.display.overlayDetections,
    },
    // 检测结果（C-3）：命中行数、段数、最长段——e2e 据此断言「3 s 开机后检出」
    results: {
      detections: x.detections ?? null, recognitions: x.recognitions ?? null, metrics: x.metrics ?? null,
      truth: x.truth ?? null, timeline3: x.timeline3 ?? null,
    },
    // 任务列表（U-4）：与 results 并列而不是塞进它——results 里那几项是**本次运行的产物**，
    // 任务列表是别的任务的清单，不是产物
    taskList: x.taskList ?? null,
    dataCenter: x.dataCenter ?? null,
    perf: s.ui.devMode ? { longTasks: x.longTasks ?? null } : null,
    badges: { noScene: !s.scene.summary },
    mapInstanceId: x.mapInstanceId,
  }
}

export type AppProbe = ReturnType<typeof probeApp>
