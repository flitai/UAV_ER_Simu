// 信号页头（U-1 写、U-3 沿用）：观测点、行数、纵轴单位文字与索引摘要。用户看到的单位只有 dBm（或 dBFS（未标定））；
// 标定来源、常数与出处只在开发者模式的 [data-dev] 里（D-047 ④）。

import { useSyncExternalStore } from 'react'
import { resultBadge } from '../shell/badges.js'
import { fmtHz, fmtInt } from '../shell/format.js'
import { SOURCE_LABEL, scaleLabel } from '../state/selectors.js'
import { useAppState } from '../state/store.js'
import { signalBuffer } from './buffer.js'

export function SignalHead() {
  const s = useAppState()
  const version = useSyncExternalStore(signalBuffer.subscribe.bind(signalBuffer), () => signalBuffer.version, () => 0)
  const idx = s.signal.index
  const op = s.signal.opId
  const liveRows = signalBuffer.rows(op, 'spectrum')
  const rows = Math.max(idx?.rows_available ?? 0, liveRows)
  const label = scaleLabel(idx, false)
  const badge = idx ? resultBadge(idx.run_state, idx.state) : null
  return (
    <div className="signal-head" data-signal-version={version}>
      <div className="row">
        <span className="k">观测点</span><span className="v" data-signal-op>{op ?? '—'}</span>
        <span className="k">行数</span><span className="v" data-signal-rows>{fmtInt(rows)}</span>
        <span className="k">纵轴</span><span className="v unit" data-signal-unit>{label ?? '—'}</span>
        {badge && <span className={`badge result ${badge.tone}${badge.hollow ? ' hollow' : ''}`}>{badge.glyph} {badge.text}{badge.suffix}</span>}
        <span className="muted idx">
          {idx
            ? `中心 ${fmtHz(idx.center_Hz)} · RBW ${fmtHz(idx.bin_width_Hz ?? 0)} · nfft ${idx.nfft ?? '—'} · ${idx.window ?? '—'} · 采样率 ${fmtHz(idx.sample_rate_Hz)}`
            : '中心 — · RBW — · nfft — · 采样率 —'}
        </span>
      </div>
      {/* 开发者模式的标定行常驻：索引到达前后页头行数不变，下面的瀑布画布才不会跳一下高度 */}
      {s.ui.devMode && (
        <div className="row muted" data-dev="calibration">
          {idx?.calibration
            ? `标定：${SOURCE_LABEL[idx.calibration.source] ?? idx.calibration.source} · 常数 ${idx.calibration.offset_dB} dB · ${idx.calibration.note ?? ''}`
            : '标定：—'}
        </div>
      )}
    </div>
  )
}
