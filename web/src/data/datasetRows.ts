// 数据中心的纯函数（U-4，D-075）：列怎么写、页脚那句话、详情分几组。
//
// **界面只摆事实**（D-039、D-042b、D-043）：机型、视距、距离、样点数、验收集、四态徽标照实写，
// 但不写「采集参数来自论文」「标定常数是估算值」这类**解释数据来源**的句子——那是 D-042b
// 要挡的话。它们仍随数据走（铁律 14），服务端照给，只在 `?dev=1` 的质检面板里出现
// （用户 2026-09-19 拍板）。

import { formatEng } from '../diagram/format.js'
import { fmtDuration, fmtHz } from '../shell/format.js'
import type { DatasetDetail, DatasetRow } from '../api/client.js'

/** 列表一行的各列。视距译成中文，距离照清单给的文字写（两批数据一个有精确值一个只有区间）。 */
export interface DatasetCells {
  data_id: string
  className: string
  batch: string
  visibility: string
  distance: string
  center: string
  samples: string
  quality: string
  holdout: boolean
}

export function datasetCells(r: DatasetRow): DatasetCells {
  return {
    data_id: r.data_id,
    className: r.class_name ?? '—',
    batch: r.batch,
    visibility: r.visibility === 'LOS' ? '视距' : r.visibility === 'NLOS' ? '非视距' : r.visibility ?? '—',
    distance: r.distance_text ?? '—',
    center: r.center_frequency_Hz ? `${formatEng(r.center_frequency_Hz)}Hz` : '—',
    samples: r.sample_count ? formatEng(r.sample_count) : '—',
    quality: r.quality ?? 'not_applicable',
    holdout: r.holdout,
  }
}

/**
 * 页脚那句话。**与挑单下拉共用同一个实现**——同一句口径两处各写一遍迟早会走样，
 * 而 `slice4-smoke` 正盯着它的文案（D-056 ②）。
 */
export function datasetsNote(total: number, matched: number, listed: number, truncated: boolean, err?: string | null): string {
  if (err) return `数据清单取不到：${err}`
  return truncated ? `共 ${total} 段 · 匹配 ${matched} 段 · 列出 ${listed} 段` : `共 ${total} 段 · 匹配 ${matched} 段`
}

export interface DetailRow { key: string; label: string; value: string; dev?: boolean }

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function s(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * 右栏详情。`detail_level === 'index'` 时清单不在本机（那些不入 git），采样率、片长、
 * 八项质检与溯源都缺席——**缺的写「—」，不拿别的数顶替**（铁律 15）。
 *
 * `dev` 为真才出质检原因、八项质检明细、标定来源与溯源六件套。
 */
export function detailRows(d: DatasetDetail, dev: boolean): DetailRow[] {
  const out: DetailRow[] = []
  const add = (key: string, label: string, value: string, devOnly = false) => {
    if (devOnly && !dev) return
    out.push({ key, label, value, ...(devOnly ? { dev: true } : {}) })
  }
  const idx = d.index ?? {}
  const man = (d.manifest ?? {}) as Record<string, Record<string, unknown> | undefined>
  const sampling = man.sampling ?? {}
  const freq = man.frequency ?? {}

  add('dataset', '数据集', s(idx.dataset) ?? d.batch)
  add('channel', '通道', s(idx.channel_id) ?? '—')
  const center = n(freq.center_frequency_Hz) ?? n(idx.center_frequency_Hz)
  add('center', '中心频率', center === null ? '—' : `${fmtHz(center)}`)
  const fs = n(sampling.sample_rate_Hz)
  add('fs', '采样率', fs === null ? '—' : `${fmtHz(fs)}`)
  const count = n(sampling.sample_count) ?? n(idx.sample_count)
  add('samples', '样点数', count === null ? '—' : formatEng(count))
  const dur = n(sampling.duration_s)
  add('duration', '片长', dur === null ? '—' : fmtDuration(dur))
  const bw = n(freq.effective_bandwidth_Hz)
  add('bandwidth', '有效带宽', bw === null ? '—' : `${fmtHz(bw)}`)
  add('segments', '段数', String(n(idx.segments) ?? (man.segments as Record<string, unknown> | undefined)?.count ?? '—'))

  const t = man.time ?? {}
  add('time_basis', '时间基准', s(t.time_basis) ?? '—')
  const cont = t.continuity as Record<string, unknown> | undefined
  add('continuity', '连续性', s(cont?.flag) ?? '—')

  const cal = d.calibration ?? {}
  const fsdBm = n(cal.full_scale_dBm)
  add('calibration', '满量程电平', fsdBm === null ? '—' : `${fsdBm.toFixed(1)} dBm`)
  // 标定**来源**只在开发者模式（D-047 ④：界面只标 dBm，来源徽标不给用户看）
  add('calibration_source', '标定来源', `${s(cal.source) ?? '—'}${s(cal.status) ? `（${s(cal.status)}）` : ''}`, true)

  const q = man.quality ?? {}
  add('quality', '数据质量', s(q.status) ?? s(idx.quality) ?? '—')
  const reasons = Array.isArray(q.reasons) ? (q.reasons as string[]) : []
  if (reasons.length) add('quality_reasons', '质检原因', reasons.join('；'), true)
  const checks = q.checks as Record<string, unknown> | undefined
  if (checks) add('quality_checks', '八项质检', Object.entries(checks).map(([k, v]) => `${k}=${String(v)}`).join('　'), true)

  const tr = man.model_trace ?? {}
  if (Object.keys(tr).length) {
    add('model_trace', '溯源', `${s(tr.model_id) ?? '—'} · ${s(tr.model_layer) ?? '—'}/${s(tr.model_level) ?? '—'}/${s(tr.credibility) ?? '—'}`, true)
  }
  return out
}

/** 真值摘要：只摆清单里记着的那几项，没有就不写。 */
export function truthRows(d: DatasetDetail): DetailRow[] {
  const t = ((d.index ?? {}).truth ?? {}) as Record<string, unknown>
  const out: DetailRow[] = []
  const add = (key: string, label: string, value: string | null) => { if (value) out.push({ key, label, value }) }
  add('class_name', '机型', s(t.class_name))
  add('class_code', '类码', s(t.class_code))
  add('visibility', '视距', t.visibility === 'LOS' ? '视距' : t.visibility === 'NLOS' ? '非视距' : s(t.visibility))
  const dm = n(t.distance_m)
  const range = Array.isArray(t.distance_range_m) ? (t.distance_range_m as number[]) : null
  add('distance', '距离', dm !== null ? `${dm} m` : range && range.length === 2 ? `${range[0]}–${range[1]} m` : s(t.distance_bin))
  add('split', '出版方划分', t.split === 'test' ? '测试集' : t.split === 'train' ? '训练集' : s(t.split))
  add('individual', '个体', n(t.individual) === null ? null : String(t.individual))
  add('band_state', '频段状态', s(t.band_state))
  return out
}
