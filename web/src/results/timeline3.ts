// 检测识别时间线的三行条带（C-9，10 报告 §5.7）。纯函数，不碰 DOM 与 store，单测直接调。
//
// 三行：真值区间（truth.jsonl）/ 检测突发（detections 的段）/ 识别标签（recognitions.jsonl）。
// 三行共用一根时间轴（引擎逻辑时间 0…任务时长），与全宽时间轴条同一时基（shell/timelineOps.ts）。
//
// **一次只画一个站**：三站三行就是九行，一屏放不下，也读不出来。焦点站取检测页签那个站下拉的值
// （detectionStore.siteFilter），没选就取第一个站——同一个「焦点」概念，不另设第二个入口（D-057、D-062）。
//
// 时间口径照实摆，不对齐。G-6（D-069）之前真值段起点会明显早于检测段起点——源按块起点门控
// tx_on（块长 65536 ≈ 131 ms）而真值按场景帧算，golden-01 差 7 帧 / 14.7 ms（D-067）；
// 现在开关边沿落在精确样点上，那一项没有了，剩下的差只是检测器要攒够一帧才出结论。

import type { RecognitionRow, TruthRow } from '../api/client.js'
import { labelStyle, labelText } from './labels.js'
import type { DetectionSegment } from './segments.js'

export interface Band {
  key: string
  /** 起止（引擎逻辑时间，秒） */
  t0: number
  t1: number
  /** 条带上写的字；放不下时不写 */
  text: string
  /** 描边与填充色 */
  color: string
  /** 悬停提示 */
  title: string
}

export interface Timeline3 {
  /** 画的是哪一站；未绑站或没有站号时为 null */
  site: string | null
  truth: Band[]
  detect: Band[]
  recognize: Band[]
}

/** 时长为零的段（回放清单的整片真值可能 t_end == t_s）仍要看得见：给一个最小宽度，用时长而不是像素表达 */
function span(t0: number, t1: number, min: number): [number, number] {
  return t1 - t0 >= min ? [t0, t1] : [t0, t0 + min]
}

/**
 * 按焦点站把三种行归成三行条带。`minSpan` 是最小可见时长（调用方按像素宽换算，缺省 0 = 不加宽）。
 * 站为 null 时不过滤（单站任务的行可能根本没有 site_id）。
 */
export function timeline3(
  site: string | null,
  truth: readonly TruthRow[],
  segments: readonly DetectionSegment[],
  recognitions: readonly RecognitionRow[],
  minSpan = 0,
): Timeline3 {
  const atSite = <T extends { site_id?: string | null }>(rows: readonly T[]): T[] =>
    site === null ? [...rows] : rows.filter((r) => (r.site_id ?? null) === site)

  const truthBands: Band[] = atSite(truth).map((r, i) => {
    const [t0, t1] = span(r.t_s, r.t_end_s, minSpan)
    const st = labelStyle(r.label)
    const who = r.emitter_id ? `${r.emitter_id} · ` : ''
    return {
      key: `truth|${r.node_id}|${r.emitter_id ?? ''}|${i}`,
      t0, t1,
      text: labelText(r.label),
      color: st.color,
      title: `真值 ${who}${r.label} · ${r.t_s.toFixed(3)}–${r.t_end_s.toFixed(3)} s${r.in_band ? '' : ' · 频段外'}`,
    }
  })

  const detectBands: Band[] = atSite(segments).map((g) => {
    const [t0, t1] = span(g.t_start, g.t_end, minSpan)
    return {
      key: `det|${g.key}`,
      t0, t1,
      text: String(g.segment_id),
      color: '#a33333',
      title: `突发 #${g.segment_id} · ${g.t_start.toFixed(3)}–${g.t_end.toFixed(3)} s · ${g.frames} 帧 · 峰值 Λ ${g.peak_statistic.toFixed(2)}`,
    }
  })

  const recBands: Band[] = atSite(recognitions).map((r) => {
    const [t0, t1] = span(r.t_s, r.t_end_s, minSpan)
    const st = labelStyle(r.result === 'unknown' ? 'unknown' : r.label)
    return {
      key: `rec|${r.node_id}|${r.segment_id}`,
      t0, t1,
      text: labelText(r.result === 'unknown' ? 'unknown' : r.label),
      color: st.color,
      title: `识别 ${r.label} · 后验 ${r.posterior.toFixed(2)} · ${r.result}`,
    }
  })

  const byT = (a: Band, b: Band) => a.t0 - b.t0 || a.key.localeCompare(b.key)
  return {
    site,
    truth: truthBands.sort(byT),
    detect: detectBands.sort(byT),
    recognize: recBands.sort(byT),
  }
}

/** 探针摘要：三行各几条、各覆盖多长（重叠算一次），够 e2e 断言用 */
export function probeTimeline3(t: Timeline3) {
  const cover = (bands: readonly Band[]): number => {
    let total = 0
    let end = -Infinity
    for (const b of bands) {
      const a = Math.max(b.t0, end)
      if (b.t1 > a) { total += b.t1 - a; end = b.t1 }
    }
    return total
  }
  return {
    site: t.site,
    truth: t.truth.length, detect: t.detect.length, recognize: t.recognize.length,
    truthCover: cover(t.truth), detectCover: cover(t.detect), recognizeCover: cover(t.recognize),
    first: t.truth[0] ? { t0: t.truth[0].t0, t1: t.truth[0].t1, text: t.truth[0].text } : null,
  }
}
