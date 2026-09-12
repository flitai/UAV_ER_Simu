// 全宽时间轴条（13 报告 §5，D-061）：`.app` 网格的第三行，场景页与结果页可见。
//
// 左端计数（都是当前时刻的事实）、中间轨道（活动标记 + 已到达进度 + 可拖游标）、右端读数与播放控制。
// 状态在 shell/timeStore.ts（外部小 store），命令在 shell/timelineOps.ts；本组件只管版式与指针。
// 09 §3.2 原定「运行结束后顶栏原位变可拖游标」，那一格 170 px 放不下活动标记，改为本条（09 v1.10）。

import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { useAppState, useStore } from '../state/store.js'
import { fmtSeconds } from './format.js'
import { timeStore } from './timeStore.js'
import { ACTIVITY_GLYPH, advance, followSignalCursor, goLive, seekTo, syncSignalCursor, timelineDuration, timelineMarkers, togglePlay } from './timelineOps.js'
import { emitters, sites, zoneOf } from '../scene/editor/scenarioOps.js'
import { currentSituation, situationRev } from '../scene/situationView.js'

const COUNTER_MS = 250   // 计数按 4 Hz 刷新，与卡片同节奏
const DRAG_SYNC_MS = 100 // 拖动中同步信号页游标的节流

interface Counters { targets: number; sites: number; losOk: number; losAll: number; bearings: number; fixes: number; alerts: number }

function useCounters(): Counters {
  const s = useAppState()
  const doc = s.scene.scenario.doc
  const [c, setC] = useState<Counters>({ targets: 0, sites: 0, losOk: 0, losAll: 0, bearings: 0, fixes: 0, alerts: 0 })
  useEffect(() => {
    let shown = ''
    const tick = () => {
      const rev = situationRev() + '|' + (doc ? 'd' : '')
      if (rev === shown) return
      shown = rev
      const v = currentSituation(doc)
      let losOk = 0
      v.links.forEach((l) => { if (l.line_of_sight) losOk++ })
      let bearings = 0
      v.bearings.forEach((b) => { if (b.df_result_state === 'valid') bearings++ })
      let alerts = 0
      v.entities.forEach((e) => { if (zoneOf(doc, e.lon, e.lat, e.alt_m)) alerts++ })
      setC({ targets: emitters(doc).length, sites: sites(doc).length, losOk, losAll: v.links.size, bearings, fixes: v.positions.size, alerts })
    }
    tick()
    const t = window.setInterval(tick, COUNTER_MS)
    return () => window.clearInterval(t)
  }, [doc])
  return c
}

export function Timeline() {
  const s = useAppState()
  const store = useStore()
  const ts = useSyncExternalStore(timeStore.subscribe, timeStore.get, timeStore.get)
  const counters = useCounters()
  const duration = timelineDuration(s)
  const visible = s.ui.view === 'scene' || s.ui.view === 'results'
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ lastSync: number } | null>(null)

  // 新任务开始 / 换任务：回到跟随实时
  const taskId = s.task.id
  const runState = s.task.runState
  useEffect(() => { timeStore.reset() }, [taskId])
  useEffect(() => { if (runState === 'running') timeStore.reset() }, [runState])

  // 信号页改了游标（键、点击）→ 时间轴跟过去；游标被清（跟随实时）→ 时间轴也回 live
  const prevCursor = useRef<number | null>(s.signal.cursor_t_s)
  useEffect(() => {
    const cur = s.signal.cursor_t_s
    const was = prevCursor.current
    prevCursor.current = cur
    if (cur !== null) followSignalCursor(store)
    else if (was !== null && s.signal.follow) timeStore.set({ t: null, mode: 'live', playing: false })
  }, [s.signal.cursor_t_s, s.signal.follow, store])

  // 播放：按墙钟推进逻辑时间 × 倍速
  useEffect(() => {
    if (!ts.playing) return
    let last = performance.now()
    let raf = 0
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (!advance(store, dt)) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [ts.playing, store])

  const tOf = (clientX: number): number => {
    const el = trackRef.current
    if (!el || duration <= 0) return 0
    const r = el.getBoundingClientRect()
    const u = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return u * duration
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
    const t = tOf(e.clientX)
    const now = performance.now()
    const sync = now - d.lastSync >= DRAG_SYNC_MS
    if (sync) d.lastSync = now
    seekTo(store, t, sync)
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    seekTo(store, tOf(e.clientX), true)
  }

  const liveT = s.task.t_s
  const shownT = ts.mode === 'replay' && ts.t !== null ? ts.t : liveT
  const pct = (t: number) => (duration > 0 ? `${(Math.min(Math.max(t, 0), duration) / duration) * 100}%` : '0%')
  const acts = timelineMarkers(s)
  const canPlay = duration > 0 && (runState === 'finished' || runState === 'cancelled' || !taskId)

  return (
    <div className="timeline" hidden={!visible} data-timeline data-timeline-mode={ts.mode}>
      <div className="tl-counts" data-timeline-counts>
        <span>目标 {counters.targets}</span><span>站 {counters.sites}</span>
        <span>视距 {counters.losOk}/{counters.losAll}</span><span>测向 {counters.bearings}</span>
        <span>定位 {counters.fixes}</span>
        <span className={counters.alerts > 0 ? 'alert' : ''}>告警 {counters.alerts}</span>
      </div>
      <div className="tl-track" ref={trackRef} data-timeline-track
           onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="tl-rail" />
        {taskId && duration > 0 && <div className="tl-progress" style={{ width: pct(liveT) }} />}
        {acts.map((a, i) => (
          <span key={i} className={`tl-mark ev-${a.event}`} style={{ left: pct(a.t_s) }}
                title={`${fmtSeconds(a.t_s)} · ${a.event} · ${a.emitter_id}`} data-timeline-mark={a.event}>
            {ACTIVITY_GLYPH[a.event] ?? '·'}
          </span>
        ))}
        {duration > 0 && <div className={'tl-cursor' + (ts.mode === 'replay' ? ' replay' : '')} style={{ left: pct(shownT) }} data-timeline-cursor />}
      </div>
      <div className="tl-right">
        <span className="mono" data-timeline-t>t {fmtSeconds(shownT)} / {duration > 0 ? fmtSeconds(duration) : '—'}</span>
        <button type="button" data-action="tl-play" disabled={!canPlay} title={ts.playing ? '暂停（空格）' : '播放（空格）'}
                onClick={() => togglePlay(store)}>{ts.playing ? '⏸' : '▶'}</button>
        {([1, 2, 5] as const).map((v) => (
          <button type="button" key={v} className={ts.speed === v ? 'on' : ''} data-action="tl-speed" data-speed={v}
                  onClick={() => timeStore.set({ speed: v })}>{v}×</button>
        ))}
        <label title="回到跟随实时：地图与信号页都显示最新一帧">
          <input type="checkbox" checked={ts.mode === 'live'} data-field="tl-follow"
                 onChange={(e) => { if (e.target.checked) goLive(store); else { seekTo(store, shownT, false); syncSignalCursor(store, shownT) } }} /> 跟随实时
        </label>
      </div>
    </div>
  )
}
