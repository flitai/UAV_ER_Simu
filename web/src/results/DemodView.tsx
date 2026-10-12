// 结果页「解调」页签（D-107）：从本次运行保存的原始 IQ 里按需解调一个突发。
// OFDM 族（图传 / 遥控上行 / DroneID 广播）画均衡后的星座；GFSK 遥控画符号中心频偏与瞬时频偏轨迹。
// 解调在服务端做（接收机的做法：ZC 符号同步与信道估计、逐符号相位跟踪），浏览器只收点集（铁律 7）。
// 只摆事实（D-039）：辐射源、预设、调制、点数、EVM / MER、频偏、到达时延、四态徽标；原因与真值对照只在 ?dev=1。

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { stateBadge } from '../shell/badges.js'
import { fmtDuration, fmtInt } from '../shell/format.js'
import { seekTo } from '../shell/timelineOps.js'
import { themeStore } from '../shell/theme.js'
import { useAppState, useStore } from '../state/store.js'
import { tapLabel } from '../chain/model.js'
import { labelText } from './labels.js'
import { burstsOf, demodStore, loadDemodList, selectBurst, selectEmitter, stepBurst } from './demodStore.js'
import { drawConstellation, drawGfsk, setupCanvas } from './demodPlot.js'
import type { DemodHeader } from '../api/client.js'

const PLOT = 500
const GFSK_W = 620
const GFSK_H = 460

export function useDemod() {
  return useSyncExternalStore(demodStore.subscribe, demodStore.get, demodStore.get)
}

/** 本任务里保存了原始 IQ 的观测点 */
export function iqOps(ops: Array<{ op_id: string; products: string[] }>): string[] {
  return ops.filter((o) => o.products.includes('iq')).map((o) => o.op_id)
}

function fmtMHz(f: number): string {
  return `${(f / 1e6).toFixed(3)} MHz`
}

function modulationText(h: DemodHeader): string {
  if (h.kind === 'ofdm') return `OFDM · ${(h.constellation ?? '').toUpperCase()}`
  if (h.kind === 'gfsk') return h.modulation === 'gfsk' ? `GFSK · BT ${h.bt ?? '—'}` : '2-FSK'
  return '—'
}

export function DemodView() {
  const s = useAppState()
  const store = useStore()
  const d = useDemod()
  const ops = iqOps(s.task.observationPoints)
  const opId = d.opId && ops.includes(d.opId) ? d.opId : (ops.includes('s3') ? 's3' : ops[0] ?? null)
  const finished = s.task.runState === 'finished'
  const cvRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (s.task.id && opId && finished) void loadDemodList(s.task.id, opId)
  }, [s.task.id, opId, finished])

  // 画图：结果或主题变了就重画
  useEffect(() => {
    const draw = () => {
      const cv = cvRef.current
      const f = d.frame
      if (!cv || !f) return
      if (f.header.kind === 'ofdm' && f.sections.points) {
        const ctx = setupCanvas(cv, PLOT, PLOT)
        if (ctx) drawConstellation(ctx, PLOT, f.header, f.sections.points)
      } else if (f.header.kind === 'gfsk' && f.sections.deviations && f.sections.trace) {
        const ctx = setupCanvas(cv, GFSK_W, GFSK_H)
        if (ctx) drawGfsk(ctx, GFSK_W, GFSK_H, f.header, f.sections.deviations, f.sections.trace)
      }
    }
    draw()
    return themeStore.subscribe(draw)
  }, [d.frame])

  // ↑ / ↓ 换突发（焦点不在输入框时）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      const b = stepBurst(e.key === 'ArrowUp' ? -1 : 1)
      if (!b) return
      e.preventDefault()
      void selectBurst(b.emitter_id, b.t_s)
      seekTo(store, b.t_s, true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  if (!s.task.id) return <div className="task-panel muted det-empty" data-demod="none">无任务</div>
  if (!ops.length) return <div className="task-panel muted det-empty" data-demod="no-iq">本任务的观测点未保存原始 IQ</div>
  if (!finished) return <div className="task-panel muted det-empty" data-demod="not-finished">任务结束后可解调</div>

  const list = d.list
  const rows = burstsOf(list, d.emitter)
  const h = d.frame?.header ?? null
  return (
    <div className="task-panel demod-panel" data-demod={d.listStatus}>
      <div className="op-tabs" role="tablist" data-demod-ops>
        {ops.map((o) => (
          <button key={o} type="button" role="tab" data-demod-op={o} className={o === opId ? 'on' : ''}
            onClick={() => { if (s.task.id) void loadDemodList(s.task.id, o) }}>{tapLabel(o)}</button>
        ))}
      </div>
      {d.error && d.listStatus === 'error' && <div className="bad">{d.error}</div>}
      {list && (
        <div className="det-head">
          <label className="field">
            <span className="k">辐射源</span>
            <select data-demod-emitter value={d.emitter ?? ''} onChange={(e) => { void selectEmitter(e.target.value) }}>
              {list.emitters.map((e) => (
                <option key={e.emitter_id} value={e.emitter_id}>
                  {e.emitter_id} · {e.preset_name ?? labelText(e.label)}（{e.count}）
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <span className="muted">↑ / ↓ 换突发</span>
        </div>
      )}
      {list && !list.bursts.length && <div className="muted det-empty" data-demod-empty>该观测点频带内没有可解调的突发</div>}
      {list && list.bursts.length > 0 && (
        <div className="demod-body">
          <div className="demod-plot" data-demod-plot={h?.kind ?? 'none'}>
            {d.status === 'loading' && !d.frame && <div className="muted det-empty">解调中…</div>}
            {d.status === 'error' && <div className="bad" data-demod-error>{d.error}</div>}
            <canvas ref={cvRef} data-demod-canvas style={{ display: d.frame && h?.kind ? 'block' : 'none' }} />
            {d.frame && !h?.kind && <div className="muted det-empty" data-demod-failed>
              <span className={'badge result ' + stateBadge(h?.state).tone}>{stateBadge(h?.state).glyph} {stateBadge(h?.state).text}</span>
            </div>}
          </div>
          <div className="demod-list site-table-wrap" data-demod-list>
            <table className="site-table">
              <thead><tr><th>时刻</th><th>时长</th><th>中心频率</th><th>同时同频</th></tr></thead>
              <tbody>
                {rows.map((b) => {
                  const on = d.selected?.emitter_id === b.emitter_id && d.selected?.t_s === b.t_s
                  return (
                    <tr key={`${b.emitter_id}@${b.t_s}`} className={on ? 'on' : ''} data-demod-burst={b.t_s}
                      onClick={() => { void selectBurst(b.emitter_id, b.t_s); seekTo(store, b.t_s, true) }}>
                      <td className="num">{(b.t_s * 1e3).toFixed(3)} ms</td>
                      <td className="num">{fmtDuration(b.t_end_s - b.t_s)}</td>
                      <td className="num">{fmtMHz(b.center_Hz)}</td>
                      <td className="name">{b.overlap.length ? b.overlap.join('、') : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ k, v, attr }: { k: string; v: string; attr?: string }) {
  return (
    <div className="form-row pp-line" data-demod-fact={attr}>
      <span className="form-label">{k}</span><span className="form-value pp-ro">{v}</span>
    </div>
  )
}

export function DemodSummary() {
  const s = useAppState()
  const d = useDemod()
  const h = d.frame?.header ?? null
  if (!h) return <div className="group" data-demod-summary="none"><h2>解调</h2><div className="muted">—</div></div>
  const b = stateBadge(h.state)
  return (
    <div className="group" data-demod-summary={h.kind ?? 'failed'}>
      <h2>解调</h2>
      <div className="form-row pp-line">
        <span className="form-label">状态</span>
        <span className="form-value"><span className={'badge result ' + b.tone} data-demod-state={h.state}>{b.glyph} {b.text}</span></span>
      </div>
      <Row k="辐射源" v={h.emitter_id} />
      <Row k="预设" v={h.preset_name ?? h.preset_id ?? '—'} />
      <Row k="调制" v={modulationText(h)} attr="modulation" />
      <Row k="突发起点" v={`${(h.t_s * 1e3).toFixed(3)} ms`} />
      <Row k="中心频率" v={fmtMHz(h.center_Hz)} />
      {h.kind === 'ofdm' && <>
        <Row k="符号 × 子载波" v={`${h.n_symbols} × ${h.n_subcarriers}`} />
        <Row k="点数" v={fmtInt((h.n_symbols ?? 0) * (h.n_subcarriers ?? 0))} />
        <Row k="EVM" v={`${((h.evm_rms ?? 0) * 100).toFixed(2)} %`} attr="evm" />
        <Row k="MER" v={`${(h.mer_dB ?? 0).toFixed(2)} dB`} attr="mer" />
      </>}
      {h.kind === 'gfsk' && <>
        <Row k="符号率" v={`${((h.symbol_rate_Hz ?? 0) / 1e3).toFixed(3)} kBd`} />
        <Row k="符号数" v={fmtInt(h.n_symbols ?? 0)} />
        <Row k="名义频偏" v={`±${((h.deviation_nominal_Hz ?? 0) / 1e3).toFixed(2)} kHz`} />
        <Row k="实测频偏" v={`±${((h.deviation_Hz ?? 0) / 1e3).toFixed(2)} kHz`} attr="deviation" />
        <Row k="前导与同步字" v={`${h.header_match ?? 0} / 64`} attr="header" />
      </>}
      {h.kind && <>
        <Row k="载频偏差" v={`${((h.cfo_Hz ?? 0) / 1e3).toFixed(3)} kHz`} attr="cfo" />
        <Row k="到达时延" v={`${((h.delay_s ?? 0) * 1e6).toFixed(3)} µs`} attr="delay" />
      </>}
      {s.ui.devMode && (
        <div data-dev>
          <h2>对照（开发者）</h2>
          <Row k="真值载频偏差" v={h.truth.cfo_Hz === null ? '—' : `${(h.truth.cfo_Hz / 1e3).toFixed(3)} kHz`} />
          <Row k="链路时延" v={h.truth.delay_s === null ? '—' : `${(h.truth.delay_s * 1e6).toFixed(3)} µs`} />
          {h.sync_ratio !== undefined && h.sync_ratio !== null && <Row k="ZC 峰比" v={h.sync_ratio.toFixed(1)} />}
          {h.q !== undefined && <Row k="整数倍频偏" v={String(h.q)} />}
          <Row k="算法" v={h.algo_version} />
          {h.reasons.length > 0 && <ul className="pp-notes">{h.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </div>
      )}
    </div>
  )
}
