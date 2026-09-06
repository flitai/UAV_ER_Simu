// 右栏「仪表与视窗控制」（09 §7.1 线框右栏；§7.2 参考电平 / 动态范围 / 分辨率 / 迹线 / 缩放行）。
// 分辨率是引擎参数不是显示参数：只读并给「去框图改」。

import { useEffect, useState, useSyncExternalStore } from 'react'
import { fmtHz } from '../shell/format.js'
import { useAppState, useStore } from '../state/store.js'
import type { TraceMode } from '../state/types.js'
import { signalHooks, viewStore } from './viewStore.js'

function NumField({ label, value, unit, step, onCommit, attr }: { label: string; value: number; unit: string; step?: number; onCommit: (v: number) => void; attr: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const commit = () => { const n = Number(text); if (Number.isFinite(n) && n !== value) onCommit(n); else setText(String(value)) }
  return (
    <label className="field">
      <span className="k">{label}</span>
      <input type="number" step={step ?? 'any'} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() } }} data-field={attr} />
      <span className="u">{unit}</span>
    </label>
  )
}

export function InstrumentPanel() {
  const s = useAppState()
  const store = useStore()
  const v = useSyncExternalStore(viewStore.subscribe, viewStore.get, viewStore.get)
  const d = s.signal.display
  const idx = s.signal.index
  const win = s.signal.follow && v.shown ? v.shown : s.signal.viewport
  const dispatch = store.dispatch
  const setVp = (p: Partial<{ t0: number; t1: number; f0: number; f1: number }>) => dispatch({ type: 'signal/viewport', viewport: { t0: win.t0, t1: win.t1, f0: win.f0, f1: win.f1, ...p } })
  return (
    <div className="instrument" data-instrument>
      <div className="group">
        <h2>迹线</h2>
        <label className="field"><span className="k">模式</span>
          <select value={d.trace} onChange={(e) => dispatch({ type: 'signal/display', patch: { trace: e.target.value as TraceMode } })} data-field="trace">
            <option value="single">单帧</option><option value="avg">平均 N 帧</option><option value="maxhold">最大保持</option><option value="minhold">最小保持</option>
          </select>
        </label>
        {d.trace === 'avg' && <NumField label="平均" value={d.avgN} unit="帧" step={1} attr="avgN" onCommit={(n) => dispatch({ type: 'signal/display', patch: { avgN: Math.max(1, Math.floor(n)) } })} />}
        {(d.trace === 'maxhold' || d.trace === 'minhold') && <button type="button" onClick={() => signalHooks.clearHold?.()} data-action="clear-hold">清除保持</button>}
      </div>
      <div className="group">
        <h2>电平</h2>
        <label className="field"><span className="k">自动</span><input type="checkbox" checked={d.auto} onChange={(e) => dispatch({ type: 'signal/display', patch: { auto: e.target.checked } })} data-field="auto" /></label>
        <NumField label="参考电平" value={d.refLevel_dB} unit={d.unit} step={10} attr="refLevel" onCommit={(n) => dispatch({ type: 'signal/display', patch: { refLevel_dB: n, auto: false } })} />
        <NumField label="动态范围" value={d.range_dB} unit="dB" step={10} attr="range" onCommit={(n) => dispatch({ type: 'signal/display', patch: { range_dB: Math.max(10, n), auto: false } })} />
        <label className="field"><span className="k">频率轴</span>
          <select value={d.freqAxis} onChange={(e) => dispatch({ type: 'signal/display', patch: { freqAxis: e.target.value as 'rf' | 'offset' } })} data-field="freqAxis">
            <option value="rf">射频绝对</option><option value="offset">相对中心</option>
          </select>
        </label>
      </div>
      <div className="group">
        <h2>分辨率</h2>
        <div className="muted">{idx ? `nfft ${idx.nfft ?? '—'} · ${idx.window ?? '—'} · RBW ${fmtHz(idx.bin_width_Hz ?? 0)}` : '—'}</div>
        <button type="button" onClick={() => dispatch({ type: 'ui/navigate', view: 'diagram' })} data-action="goto-diagram">去框图改</button>
      </div>
      <div className="group">
        <h2>视窗</h2>
        <NumField label="t0" value={round(win.t0, 6)} unit="s" attr="t0" onCommit={(n) => setVp({ t0: n })} />
        <NumField label="t1" value={round(win.t1, 6)} unit="s" attr="t1" onCommit={(n) => setVp({ t1: n })} />
        <NumField label="f0" value={round(win.f0 / 1e3, 3)} unit="kHz" attr="f0" onCommit={(n) => setVp({ f0: n * 1e3 })} />
        <NumField label="f1" value={round(win.f1 / 1e3, 3)} unit="kHz" attr="f1" onCommit={(n) => setVp({ f1: n * 1e3 })} />
        <label className="field"><span className="k">统计</span>
          <select value={s.signal.viewport.stat} onChange={(e) => dispatch({ type: 'signal/viewport', viewport: { stat: e.target.value as 'max' | 'mean' | 'min' } })} data-field="stat">
            <option value="max">max</option><option value="mean">mean</option><option value="min">min</option>
          </select>
        </label>
        <label className="field"><span className="k">跟随实时</span><input type="checkbox" checked={s.signal.follow} onChange={(e) => dispatch({ type: 'signal/follow', on: e.target.checked })} data-field="follow" /></label>
        <div className="muted">频率相对中心；时间相对起点。框选 / 滚轮 / Alt 拖动会转入回看。</div>
      </div>
      <div className="group">
        <h2>色带</h2>
        <div className="muted">viridis · 刻度同频谱量程</div>
      </div>
    </div>
  )
}

function round(v: number, digits: number): number { const m = Math.pow(10, digits); return Math.round(v * m) / m + 0 }
