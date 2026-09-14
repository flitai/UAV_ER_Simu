// 检测识别页签顶部的三行时间线条带（C-9，10 报告 §5.7）。
//
// 三行 = 真值区间 / 检测突发 / 识别标签，共用一根轴（引擎逻辑时间 0…任务时长），
// 与全宽时间轴条同一时基。指针交互照 shell/Timeline.tsx 那一套：按下即 seek、拖动中 100 ms 节流同步信号游标、
// 松手再同步一次；点条带直接跳到它的起点。全宽时间轴条不动（13 §5 的第三行网格还是它）。
//
// 只画焦点站的三行（timeline3.ts 的头注写了为什么不是 K 站 × 3 行）。

import { useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { fmtSeconds } from '../shell/format.js'
import { timeStore } from '../shell/timeStore.js'
import { seekTo, timelineDuration } from '../shell/timelineOps.js'
import { useAppState, useStore } from '../state/store.js'
import { detectionStore, focusSite, visibleSegments } from './detectionStore.js'
import { recognitionStore } from './recognitionStore.js'
import { truthStore, visibleTruth } from './truthStore.js'
import { timeline3, type Band } from './timeline3.js'

const DRAG_SYNC_MS = 100
/** 条带上写字的最小相对宽度：再窄就只剩悬停提示（写不下硬写会糊成一片） */
const TEXT_MIN_FRAC = 0.05

const ROWS: Array<{ key: 'truth' | 'detect' | 'recognize'; label: string }> = [
  { key: 'truth', label: '真值' },
  { key: 'detect', label: '检测' },
  { key: 'recognize', label: '识别' },
]

export function DetectionTimeline() {
  const s = useAppState()
  const store = useStore()
  const det = useSyncExternalStore(detectionStore.subscribe, detectionStore.get, detectionStore.get)
  const rec = useSyncExternalStore(recognitionStore.subscribe, recognitionStore.get, recognitionStore.get)
  const tru = useSyncExternalStore(truthStore.subscribe, truthStore.get, truthStore.get)
  const ts = useSyncExternalStore(timeStore.subscribe, timeStore.get, timeStore.get)
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ lastSync: number } | null>(null)

  const duration = timelineDuration(s)
  const site = focusSite(det)
  // 零时长的段（回放清单的整片真值）也要看得见：最小宽度取轴长的 0.4%
  const t3 = timeline3(site, visibleTruth(tru, site), visibleSegments(det), rec.rows, duration * 0.004)

  const tOf = (clientX: number): number => {
    const el = trackRef.current
    if (!el || duration <= 0) return 0
    const r = el.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width))) * duration
  }
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || duration <= 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { lastSync: 0 }
    timeStore.set({ playing: false })
    seekTo(store, tOf(e.clientX), false)
    e.preventDefault()
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const now = performance.now()
    const sync = now - d.lastSync >= DRAG_SYNC_MS
    if (sync) d.lastSync = now
    seekTo(store, tOf(e.clientX), sync)
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    seekTo(store, tOf(e.clientX), true)
  }

  const pct = (t: number) => (duration > 0 ? (Math.min(Math.max(t, 0), duration) / duration) * 100 : 0)
  const shownT = ts.mode === 'replay' && ts.t !== null ? ts.t : s.task.t_s
  const counts: Record<string, number> = { truth: t3.truth.length, detect: t3.detect.length, recognize: t3.recognize.length }

  const bandEl = (b: Band) => {
    const w = duration > 0 ? (b.t1 - b.t0) / duration : 0
    return (
      <span key={b.key} className="tl3-band" data-tl3-band={b.key} title={b.title}
            style={{ left: `${pct(b.t0)}%`, width: `${Math.max(w * 100, 0.3)}%`, borderColor: b.color, background: b.color + '33' }}
            onPointerDown={(e) => { e.stopPropagation(); timeStore.set({ playing: false }); seekTo(store, b.t0, true) }}>
        {w >= TEXT_MIN_FRAC && b.text ? <i style={{ color: b.color }}>{b.text}</i> : null}
      </span>
    )
  }

  return (
    <div className="tl3" data-tl3 data-tl3-site={site ?? ''}>
      <div className="tl3-head">
        <span>时间线</span>
        {site && <span className="muted">{site}</span>}
        <span className="muted">真值 {counts.truth} · 突发 {counts.detect} · 识别 {counts.recognize}</span>
        <span className="spacer" />
        <span className="mono muted" data-tl3-t>{fmtSeconds(shownT)} / {duration > 0 ? fmtSeconds(duration) : '—'}</span>
      </div>
      <div className="tl3-body">
        <div className="tl3-keys">{ROWS.map((r) => <span key={r.key}>{r.label}</span>)}</div>
        <div className="tl3-track" ref={trackRef} data-tl3-track
             onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {ROWS.map((r) => (
            <div key={r.key} className="tl3-lane" data-tl3-lane={r.key}>{t3[r.key].map(bandEl)}</div>
          ))}
          {duration > 0 && <div className="tl3-cursor" style={{ left: `${pct(shownT)}%` }} data-tl3-cursor />}
        </div>
      </div>
      <div className="tl3-axis"><span>0 s</span>{duration > 0 && <span>{fmtSeconds(duration)}</span>}</div>
    </div>
  )
}
