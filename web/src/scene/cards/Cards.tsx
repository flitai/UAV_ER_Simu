// 场景页右栏的常驻卡片栈（13 报告 §3，D-061）：目标列表（表，用来扫）+ 目标卡（分节，用来读）+ 站点卡。
//
// 数据来自 sceneStore（实时或回放）与场景文档，派生算法在 derive.ts；这里只管版式与选中。
// 刷新节奏：sceneStore 每条事件 notify 一次（10–100 Hz × K × N），右栏按 4 Hz 定频取版本号重算，
// 与地图 20 Hz 定频同一思路（D-049 ⑩：高频量不进主 store，也不让它按事件频率重渲染）。
// 卡片只摆事实（D-039）：无威胁 %、无概率 %，读数都是产品行或按链路帧算出的量。

import { useEffect, useMemo, useState } from 'react'
import { useAppState, useStore } from '../../state/store.js'
import { fmtDb, fmtDeg, fmtHz, fmtMeters } from '../../shell/format.js'
import { sceneStore } from '../sceneStore.js'
import { buildSiteCards, buildTargetCards, type SiteCardData, type SiteRow, type TargetCardData } from './derive.js'
import { BearingDial, PlatformIcon } from './icons.js'

const CARD_TICK_MS = 250   // 4 Hz

/** 态势 store 的版本号，按定频取：变了才让卡片重算。 */
function useSceneRev(): number {
  const [rev, setRev] = useState(() => sceneStore.get().rev)
  useEffect(() => {
    const t = window.setInterval(() => {
      const r = sceneStore.get().rev
      setRev((prev) => (prev === r ? prev : r))
    }, CARD_TICK_MS)
    return () => window.clearInterval(t)
  }, [])
  return rev
}

const PLATFORM_LABEL: Record<string, string> = { multirotor: '多旋翼', fixed_wing: '固定翼', racing: '穿越机', medium: '中型' }

function Field({ label, children, attr }: { label: string; children: React.ReactNode; attr?: string }) {
  return (
    <div className="card-field" data-card-field={attr}>
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  )
}

function txText(on: boolean | null): string {
  return on === null ? '—' : on ? '开' : '关'
}

function SiteLine({ r }: { r: SiteRow }) {
  const b = r.bearing
  return (
    <div className={'card-site' + (r.link_state && r.link_state !== 'valid' ? ' degraded' : '')} data-card-site={r.site_id}>
      <div className="card-site-head">
        <span className="card-site-name">{r.site_name}</span>
        {r.line_of_sight !== null && (
          <span className={r.line_of_sight ? 'badge-los' : 'badge-nlos'}>● {r.line_of_sight ? '视距' : '非视距'}</span>
        )}
        {b && <BearingDial bearing_deg={b.bearing_deg} sigma_deg={b.sigma_deg} valid={b.state === 'valid'} size={36} />}
      </div>
      <div className="card-grid">
        <Field label="距离" attr="distance">{fmtMeters(r.distance_m)}{r.ground_m !== null ? <span className="dim"> · 地面 {fmtMeters(r.ground_m)}</span> : null}</Field>
        <Field label="方位 / 俯仰" attr="angles">{fmtDeg(r.azimuth_deg)} / {fmtDeg(r.elevation_deg)}</Field>
        <Field label="路损" attr="loss">{fmtDb(r.path_loss_dB)}</Field>
        <Field label="接收电平" attr="rx">{fmtDb(r.rx_dBm, 'dBm')}</Field>
        <Field label="信噪比" attr="snr">{fmtDb(r.snr_dB)}</Field>
        <Field label="测向" attr="bearing">
          {b
            ? b.state === 'invalid'
              ? <span className="dim">本时刻无有效量测</span>
              : <>{fmtDeg(b.bearing_deg)} ± {(2 * b.sigma_deg).toFixed(1)}° · {b.df_quality}{b.mixture ? ' · 同频混叠' : ''}</>
            : '—'}
        </Field>
      </div>
    </div>
  )
}

function TargetCard({ c, open, selected, onToggle }: { c: TargetCardData; open: boolean; selected: boolean; onToggle: () => void }) {
  const m = c.motion
  return (
    <div className={'card' + (open ? ' open' : '') + (selected ? ' sel' : '')} data-card={c.id} data-card-open={open ? '1' : undefined}>
      <button type="button" className="card-head" onClick={onToggle} data-card-head={c.id}>
        <PlatformIcon type={c.platform_type} />
        <span className="card-title">{c.name}</span>
        <span className="dim">{c.id}</span>
        {c.inZone && <span className="card-badge alert" data-card-zone>{c.inZone}</span>}
        <span className="spacer" />
        {m && <span className="dim">{fmtMeters(m.alt_m)} · 发射{txText(m.tx_on)}</span>}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="card-body">
          <div className="card-sec">身份</div>
          <div className="card-grid">
            <Field label="机型">{PLATFORM_LABEL[c.platform_type] ?? c.platform_type}{c.equipment_model ? <span className="dim"> · {c.equipment_model}</span> : null}</Field>
            <Field label="中心频率">{c.center_Hz !== null ? fmtHz(c.center_Hz) : '—'}</Field>
            <Field label="带宽">{c.bw_Hz !== null ? fmtHz(c.bw_Hz) : '—'}</Field>
            <Field label="发射功率">{fmtDb(c.tx_power_dBm, 'dBm')}{c.tx_gain_dBi !== null ? <span className="dim"> · 天线 {c.tx_gain_dBi} dBi</span> : null}</Field>
            {c.polarization && <Field label="极化">{c.polarization}</Field>}
          </div>
          {m && (
            <>
              <div className="card-sec">运动</div>
              <div className="card-grid">
                <Field label="位置"><span className="mono">{m.lon.toFixed(5)}, {m.lat.toFixed(5)}</span></Field>
                <Field label="离地高">{fmtMeters(m.alt_m)}</Field>
                <Field label="航向 / 速度">{fmtDeg(m.heading_deg)} / {m.speed_mps !== null ? `${m.speed_mps.toFixed(1)} m/s` : '—'}</Field>
                <Field label="发射">{txText(m.tx_on)}{m.center_Hz !== null ? <span className="dim"> · {fmtHz(m.center_Hz)}</span> : null}</Field>
              </div>
            </>
          )}
          <div className="card-sec">各站（{c.sites.length}）</div>
          {c.sites.map((r) => <SiteLine key={r.site_id} r={r} />)}
          {c.fixes.length > 0 && (
            <>
              <div className="card-sec">定位</div>
              {c.fixes.map((f) => (
                <div className="card-grid" key={f.method} data-card-fix={f.method}>
                  <Field label={f.method}><span className="mono">{f.lat.toFixed(5)}, {f.lon.toFixed(5)}</span></Field>
                  <Field label="CEP">{f.cep_m.toFixed(0)} m</Field>
                  {/* aoa 的 gdop 实为 rms_trace_m（米），tdoa 的是无量纲几何精度因子：按行标单位，不混（13 §3.3） */}
                  <Field label={f.method === 'aoa' ? '位置均方根' : 'GDOP'}>{f.method === 'aoa' ? `${f.gdop.toFixed(1)} m` : f.gdop.toFixed(2)}</Field>
                  {/* 最小交会角只对到达角交汇有意义；时差解上它恒为 0，不显示 */}
                  <Field label="几何">{f.geometry_quality}{f.time_quality ? ` · ${f.time_quality}` : ''}{f.method.includes('aoa') ? ` · 交会 ${f.min_crossing_angle_deg.toFixed(0)}°` : ''}</Field>
                  <Field label="参与站">{f.sites.join('、') || '—'}</Field>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TargetList({ cards, selectedId, onPick }: { cards: TargetCardData[]; selectedId: string | null; onPick: (id: string) => void }) {
  return (
    <table className="tlist" data-target-list>
      <thead>
        <tr><th></th><th>目标</th><th>高度</th><th>速度</th><th>航向</th><th>发射</th><th>最近站</th></tr>
      </thead>
      <tbody>
        {cards.map((c) => {
          const m = c.motion
          return (
            <tr key={c.id} className={c.id === selectedId ? 'sel' : ''} data-target-row={c.id} onClick={() => onPick(c.id)}>
              <td className="icon"><PlatformIcon type={c.platform_type} size={16} /></td>
              <td className="name">{c.name}{c.inZone ? <span className="card-badge alert"> 告警区</span> : null}</td>
              <td className="num">{m ? fmtMeters(m.alt_m) : '—'}</td>
              <td className="num">{m?.speed_mps !== null && m?.speed_mps !== undefined ? `${m.speed_mps.toFixed(1)} m/s` : '—'}</td>
              <td className="num">{fmtDeg(m?.heading_deg ?? null)}</td>
              <td>{txText(m?.tx_on ?? null)}</td>
              <td className="num">{fmtMeters(c.nearest_m)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function SiteCards({ cards, selectedId, onPick }: { cards: SiteCardData[]; selectedId: string | null; onPick: (id: string) => void }) {
  return (
    <div className="site-cards" data-site-cards>
      {cards.map((c) => (
        <button type="button" key={c.id} className={'site-card' + (c.id === selectedId ? ' sel' : '')} data-site-card={c.id} onClick={() => onPick(c.id)}>
          <span className="site-card-line">
            <span className="card-title">◉ {c.name}</span>
            <span className="dim">{c.equipment_model ?? c.id}</span>
            <span className="spacer" />
            {c.worst_quality && <span className="card-badge">{c.worst_quality}</span>}
            {c.sync_state && <span className="dim">{c.sync_state}</span>}
          </span>
          <span className="site-card-line mono">
            {c.fs_Hz !== null ? fmtHz(c.fs_Hz) : '—'}{c.center_Hz !== null ? ` @ ${fmtHz(c.center_Hz)}` : ''} · nf {c.nf_dB !== null ? `${c.nf_dB} dB` : '—'} · 天线 {c.gain_dBi !== null ? `${c.gain_dBi} dBi` : '—'} · 链路 {c.links}
          </span>
        </button>
      ))}
    </div>
  )
}

export function CardStack() {
  const s = useAppState()
  const store = useStore()
  const doc = s.scene.scenario.doc
  const rev = useSceneRev()
  // rev 变了才重算：sceneStore.get() 返回同一个对象，靠它本身的引用判断不出变化
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cards = useMemo(() => buildTargetCards(doc, sceneStore.get()), [doc, rev])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const siteCards = useMemo(() => buildSiteCards(doc, sceneStore.get()), [doc, rev])
  const sel = s.scene.editor.selection
  const selEmitter = sel && sel.kind === 'emitter' ? sel.id : null
  const selSite = sel && sel.kind === 'site' ? sel.id : null
  // 展开哪张：跟着选中走；没选中时展开第一张；用户点过标题以用户为准
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({})
  const openOf = (id: string, i: number) => openOverride[id] ?? (selEmitter ? id === selEmitter : i === 0)

  const pickEmitter = (id: string) => store.dispatch({ type: 'scene/select', selection: { kind: 'emitter', id } })
  const pickSite = (id: string) => store.dispatch({ type: 'scene/select', selection: { kind: 'site', id } })

  return (
    <div className="cards" data-card-stack data-cards={cards.length}>
      <div className="group">
        <div className="group-title">目标（{cards.length}）</div>
        {cards.length === 0 ? <div className="dim">场景里没有辐射源</div> : <TargetList cards={cards} selectedId={selEmitter} onPick={pickEmitter} />}
      </div>
      {cards.map((c, i) => (
        <TargetCard key={c.id} c={c} open={openOf(c.id, i)} selected={c.id === selEmitter}
                    onToggle={() => setOpenOverride((o) => ({ ...o, [c.id]: !openOf(c.id, i) }))} />
      ))}
      <div className="group">
        <div className="group-title">站点（{siteCards.length}）</div>
        {siteCards.length === 0 ? <div className="dim">场景里没有站点</div> : <SiteCards cards={siteCards} selectedId={selSite} onPick={pickSite} />}
      </div>
    </div>
  )
}
