// 评测数据集的典型链路生成器（试样集步骤 3，D-092；14 号报告 §8.3）。
//
// 输入是一份「链路规格」（`cuav-eval-chain/1`），由 scripts/gen_eval_dataset.py 按格子写出：
// 场景文件、运行时长与种子、少数几个槽位的参数、开哪些观测点与原始 IQ，以及一张频率计划的放行表。
// 这里按白名单建链路状态，走与界面同一条编译路径（compile → serialize），再做两道核对：
//   1. 往返：serialize(compile(parseChain(doc))) 必须与原文逐字节相同——不能是只有生成器认得的框图；
//   2. 频率计划：没通过的检查项必须**恰好**等于规格里的放行表 `plan_allow`。放行表多一项、少一项都报错，
//      免得某一格悄悄越过了界面会拦的配置，也免得放行表在配置改好之后烂在那里。
// 放行是有意的：例如只交 S4 的跳频遥控段，跳频点本来就有一部分在 S4 通带外（用户 2026-10-04 定），
// 界面的「滤波器过渡带足够」会照实标红。放行的缘由写在格子文件里。

import type { Catalog } from '../../api/catalog.js'
import { parse as parseDoc, serialize } from '../../diagram/doc.js'
import type { SceneSummaryLite, ScenarioDoc } from '../../state/types.js'
import { compile, parseChain } from '../compile.js'
import { emptyChain, TAP_ORDER, type ChainState, type SlotId, type TapId } from '../model.js'
import { freqPlan, planChecks } from '../plan.js'

/** 规格里允许改的槽位：接收机前端、ADC、DDC、传播信道（含代理到 ScenarioSource 的传播参数）、检测器 */
export const EVAL_SLOTS: readonly SlotId[] = ['rx_fe', 'adc', 'ddc', 'ch', 'det']
const SPEC_KEYS = new Set(['schema_version', 'diagram_id', 'name', 'scenario', 'site_ids', 'run', 'slots', 'taps', 'iq',
  'plan_allow'])

export interface EvalChainSpec {
  schema_version: 'cuav-eval-chain/1'
  diagram_id: string
  name: string
  /** 场景文件，仓库相对路径 */
  scenario: string
  /** 参与计算的站；缺省取场景里全部的站 */
  site_ids?: string[]
  run: { duration_s: number; seed: number }
  slots: Partial<Record<string, Record<string, number | string | boolean>>>
  /** 开哪些观测点（谱与包络） */
  taps: string[]
  /** 其中哪些另写原始 IQ（只能是 S3–S5） */
  iq: string[]
  /** 允许不通过的频率计划检查项 */
  plan_allow?: string[]
}

export interface EvalChainResult {
  text: string
  failing: string[]
  details: Record<string, string>
}

export class EvalChainError extends Error {}

/** 按规格编译一条典型链路；规格不合法、往返不逐字节相同或频率计划与放行表对不上都抛 EvalChainError */
export function buildEvalChain(spec: EvalChainSpec, scenario: ScenarioDoc, scenarioSha: string, cat: Catalog,
  scene: SceneSummaryLite | null): EvalChainResult {
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) throw new EvalChainError(`规格里有不认识的键 ${k}`)
  if (spec.schema_version !== 'cuav-eval-chain/1') throw new EvalChainError(`规格版本应为 cuav-eval-chain/1`)
  const c: ChainState = emptyChain('synthetic', spec.diagram_id)
  c.name = spec.name
  c.scenario = { scenario_id: String(scenario.scenario_id), sha256: scenarioSha }
  const sites = ((scenario.sites ?? []) as Array<{ id: string }>).map((s) => String(s.id))
  c.siteIds = spec.site_ids ?? sites
  c.emitterIds = ((scenario.emitters ?? []) as Array<{ id: string }>).map((e) => String(e.id))
  c.run = { duration_s: spec.run.duration_s, seed: spec.run.seed }
  for (const [slot, params] of Object.entries(spec.slots)) {
    if (!(EVAL_SLOTS as readonly string[]).includes(slot)) throw new EvalChainError(`规格不能改槽位 ${slot}`)
    const id = slot as SlotId
    c.slots[id] = { ...c.slots[id], params: { ...c.slots[id].params, ...(params ?? {}) } }
    if (id === 'ddc') c.slots[id].bypass = false
  }
  for (const t of [...spec.taps, ...spec.iq]) {
    if (!(TAP_ORDER as readonly string[]).includes(t)) throw new EvalChainError(`没有观测点 ${t}`)
  }
  for (const t of TAP_ORDER) {
    c.taps[t] = spec.taps.includes(t)
    c.tapIq[t] = spec.iq.includes(t)
  }
  for (const t of spec.iq) {
    if (!['s3', 's4', 's5'].includes(t)) throw new EvalChainError(`原始 IQ 只能开在 S3–S5，规格写了 ${t}`)
    if (!spec.taps.includes(t)) throw new EvalChainError(`观测点 ${t} 开了原始 IQ 却没开观测点本身`)
  }

  const text = serialize(compile(c, cat, scenario).doc, cat)
  const r = parseDoc(text)
  if (!r.ok) throw new EvalChainError(`编译出的框图解析失败：${r.error}`)
  const back = parseChain(r.doc)
  if (!back) throw new EvalChainError('编译出的框图解不回典型链路')
  if (serialize(compile(back, cat, scenario).doc, cat) !== text) {
    throw new EvalChainError('往返不逐字节相同：compile(parseChain(doc)) 与原文不同')
  }

  const checks = planChecks(c, freqPlan(c, scenario, cat), scenario, cat, scene)
  const failing = checks.filter((x) => !x.ok).map((x) => x.id).sort()
  const details = Object.fromEntries(checks.filter((x) => !x.ok).map((x) => [x.id, x.detail]))
  const allow = [...(spec.plan_allow ?? [])].sort()
  if (failing.join(',') !== allow.join(',')) {
    const extra = failing.filter((x) => !allow.includes(x))
    const stale = allow.filter((x) => !failing.includes(x))
    throw new EvalChainError(
      (extra.length ? `频率计划没通过且不在放行表里：${extra.map((x) => `${x}（${details[x]}）`).join('；')}。` : '')
      + (stale.length ? `放行表里的这些项其实通过了，删掉它们：${stale.join('、')}。` : ''))
  }
  return { text, failing, details }
}

/** 观测区域清单 → 频率计划的「E3 有观测区域建筑几何」要的那几项（只在 E3 时用得到） */
export function sceneSummaryFromManifest(manifest: Record<string, unknown>): SceneSummaryLite {
  const aoi = (manifest.aoi ?? {}) as Record<string, unknown>
  const b = (manifest.buildings_summary ?? {}) as Record<string, unknown>
  return {
    id: String(aoi.id ?? ''), name: String(aoi.name ?? aoi.id ?? ''),
    bbox: [0, 0, 0, 0], center: [0, 0], extentKm: [0, 0],
    buildings: { features: Number(b.features ?? 0), srcPct: {}, heightQ50: null, heightMax: null },
    basemapId: '', basemapUrl: '',
  } as SceneSummaryLite
}

export type { TapId }
