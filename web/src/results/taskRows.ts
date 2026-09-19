// 任务列表的纯函数（U-4，D-075）：一条记录 → 一行、一份摘要、页脚那句话。
//
// 放在 .tsx 外面是为了能单测：列表的口径（哪几项进行、哪几项只在摘要、哪几项只在 ?dev=1）
// 是这一步里最容易走样的东西，写成函数才钉得住。

import { fmtDuration, fmtFactor, fmtInstant } from '../shell/format.js'
import type { TaskRecord } from '../state/types.js'

export interface TaskRow {
  id: string
  /** 创建时刻，本地时区 */
  when: string
  name: string
  runState: TaskRecord['run_state']
  result: TaskRecord['result']
  scenarioId: string
  /** 墙钟 + 实时因子，合成一列 */
  wall: string
  /** 评价摘要：一站时写读数，多站时只写站数（一行放不下 K 站，细节在摘要栏） */
  metrics: string
  /** 用过验收集片段。只标事实两个字，不写解释句（D-056） */
  holdout: boolean
}

export function taskRow(rec: TaskRecord, opts: { timeZone?: string } = {}): TaskRow {
  const m = rec.metrics_summary ?? []
  return {
    id: rec.task_id,
    when: fmtInstant(rec.created_utc, opts),
    name: rec.name,
    runState: rec.run_state,
    result: rec.result,
    scenarioId: rec.scenario_id ?? '—',
    wall: rec.wall_s === undefined ? '—' : `${fmtDuration(rec.wall_s)} ${fmtFactor(rec.realtime_factor ?? null)}`,
    metrics: metricsText(m),
    holdout: (rec.data_refs ?? []).some((d) => d.holdout),
  }
}

function num(v: number | null | undefined, digits = 3): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits)
}

function metricsText(m: NonNullable<TaskRecord['metrics_summary']>): string {
  if (m.length === 0) return '—'
  if (m.length > 1) return `${m.length} 站`
  return `Pd ${num(m[0].pd)} · 识别 ${num(m[0].accuracy, 2)}`
}

/**
 * 页脚那句话。一页取不完时要说清共有多少、这是第几到第几——
 * 不说清就等于假装列全了（D-056 ②、D-068 ③ 同一条口径）。
 */
export function pageNote(total: number, offset: number, shown: number): string {
  if (total === 0) return '共 0 个任务'
  if (shown >= total) return `共 ${total} 个任务`
  return `共 ${total} 个任务 · 第 ${offset + 1}–${offset + shown} 个`
}

/** 运行中或排队中才谈得上取消（已结束的服务端回 409）。 */
export function canCancel(rec: TaskRecord): boolean {
  return rec.run_state === 'queued' || rec.run_state === 'running'
}

export interface SummaryRow { key: string; label: string; value: string; dev?: boolean }

/**
 * 右栏摘要（09 §7.1 的「任务」行）。两条口径：
 *
 * - **选中的就是当前任务时，种子 / 时长 / 实时因子 / 观测点数不再出现**——结果页左栏
 *   `data-task-facts` 已经写着它们了，一个事实屏上只出现一次（D-062）。
 * - **框图哈希、场景哈希、引擎版本只在 `?dev=1`**。09 §7.1 把它们列进了任务摘要，
 *   但 09 §9 自己又把这四项归到「仅开发者模式」的溯源面板里；按 D-039「界面不展示溯源」取后者。
 */
export function summaryRows(rec: TaskRecord, isCurrent: boolean, dev: boolean): SummaryRow[] {
  const out: SummaryRow[] = []
  const add = (key: string, label: string, value: string, devOnly = false) => {
    if (devOnly && !dev) return
    out.push({ key, label, value, ...(devOnly ? { dev: true } : {}) })
  }
  add('name', '实验', rec.name)
  add('scenario', '场景', rec.scenario_id ?? '—')
  add('diagram', '框图', rec.diagram_id)
  if (!isCurrent) add('seed', '种子', rec.seed === null ? '—' : `${rec.seed}${rec.seed_source ? `（${rec.seed_source}）` : ''}`)
  add('created', '创建', fmtInstant(rec.created_utc))
  add('started', '开始', fmtInstant(rec.started_utc))
  add('ended', '结束', fmtInstant(rec.ended_utc))
  if (!isCurrent) add('wall', '墙钟', rec.wall_s === undefined ? '—' : `${fmtDuration(rec.wall_s)} ${fmtFactor(rec.realtime_factor ?? null)}`)
  if (!isCurrent) add('taps', '观测点', String((rec.observation_points ?? []).length))
  add('diagram_sha256', '框图哈希', short(rec.diagram_sha256), true)
  add('scenario_sha256', '场景哈希', short(rec.scenario_sha256), true)
  add('engine', '引擎版本', rec.engine_version ?? '—', true)
  add('exit', '退出码', rec.exit_code === undefined || rec.exit_code === null ? '—' : String(rec.exit_code), true)
  return out
}

function short(h: string | undefined): string {
  return h ? `${h.slice(0, 12)}…` : '—'
}
