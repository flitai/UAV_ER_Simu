// 读数栏（09 §7.2 Marker 行）：M1 峰值自动跟踪、M2 手动，Δ 频差与 Δ 电平，悬停读数。

import { useSyncExternalStore } from 'react'
import { fmtDb, fmtDelta, fmtHz, fmtSeconds } from '../shell/format.js'
import { useAppState } from '../state/store.js'
import { markerReadout } from './trace.js'
import { viewStore } from './viewStore.js'

export function MarkerBar() {
  const s = useAppState()
  const v = useSyncExternalStore(viewStore.subscribe, viewStore.get, viewStore.get)
  const unit = s.signal.display.unit
  const m2 = s.signal.markers.find((m) => m.id === 'M2')
  const m2f = m2?.freq_Hz ?? null
  const d = markerReadout(v.m1 ? { f: v.m1.f, v: v.m1.v } : null, m2f !== null && v.m2Level !== null ? { f: m2f, v: v.m2Level } : null)
  const t0s = s.signal.index?.t0_s ?? 0
  return (
    <div className="marker-bar" data-marker-bar>
      <span className="m m1" data-marker="M1">M1 {v.m1 ? <>{fmtHz(v.m1.f)} <b>{fmtDb(v.m1.v, unit)}</b></> : '—'}</span>
      <span className="m m2" data-marker="M2">M2 {m2f !== null ? <>{fmtHz(m2f)} <b>{fmtDb(v.m2Level, unit)}</b></> : <span className="muted">— 按 M 放置</span>}</span>
      <span className="m d">Δ {fmtDelta(d.df, fmtHz)} · {fmtDelta(d.dv, (x) => fmtDb(x))}</span>
      {s.signal.cursor_t_s !== null && <span className="m cur">t {fmtSeconds(t0s + s.signal.cursor_t_s)}</span>}
      <span className="m hover muted">{v.hover ? `${fmtHz(v.hover.f)}${v.hover.t !== null ? ` · ${fmtSeconds(t0s + v.hover.t)}` : ''}${v.hover.v !== null ? ` · ${fmtDb(v.hover.v, unit)}` : ''}` : ''}</span>
    </div>
  )
}
