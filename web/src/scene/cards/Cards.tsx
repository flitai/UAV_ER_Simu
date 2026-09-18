// 场景页右栏「态势」（13 报告 §13，D-062）：焦点卡（一张）+ 目标列表（一行一目标）+ 站点（一行一站）。
//
// 三级组织：地图与时间轴计数是总览，目标列表是第二级，焦点卡是第三级——详情一次只看一个。
// 右栏只放观测量；机型、频率、功率这类配置项折在焦点卡底部的「身份」里，改它们去左栏的表单。
// 数据来自 currentSituation（live / replay / preview 同一帧），派生算法在 derive.ts；这里只管版式。
// 刷新节奏：4 Hz 定频取版本号重算，与地图 20 Hz 定频同一思路（D-049 ⑩）。
// 卡片只摆事实（D-039）：无威胁 %、无概率 %，读数都是产品行或按链路帧算出的量。

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAppState, useStore } from '../../state/store.js'
import { fmtDb, fmtDeg, fmtHz, fmtMeters } from '../../shell/format.js'
import { losProbeStore, probeInputAt, runLosProbe } from '../losProbe.js'
import { currentSituation, situationRev } from '../situationView.js'
import { focusTargetId } from '../focus.js'
import { buildSiteCards, buildTargetCards, type SiteCardData, type SiteRow, type TargetCardData } from './derive.js'
import { PlatformIcon } from './icons.js'

const CARD_TICK_MS = 250   // 4 Hz

/** 态势版本号（数据 + 时间轴），按定频取：变了才让卡片重算。 */
function useSceneRev(): string {
  const [rev, setRev] = useState(() => situationRev())
  useEffect(() => {
    const t = window.setInterval(() => {
      const r = situationRev()
      setRev((prev) => (prev === r ? prev : r))
    }, CARD_TICK_MS)
    return () => window.clearInterval(t)
  }, [])
  return rev
}

const PLATFORM_LABEL: Record<string, string> = { multirotor: '多旋翼', fixed_wing: '固定翼', racing: '穿越机', medium: '中型' }

function txText(on: boolean | null): string {
  return on === null ? '—' : on ? '开' : '关'
}

/** 一位小数、不带单位（单位在列头）；缺就是缺，写 —（铁律 15）。 */
function bare(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(1)
}

/** DF-Q1 → Q1：表格里放不下前缀，列头已经写明是测向。 */
function qShort(q: string): string {
  return q.replace(/^DF-/, '')
}

/** 每站两行：第一行链路读数（站 / 距离 / 电平 / 信噪比），第二行测向。320 px 的右栏放不下五列并排，测向连同 ± 2σ 与质量档另起一行才不被截。 */
function SiteTableRows({ r }: { r: SiteRow }) {
  const b = r.bearing
  const degraded = r.link_state && r.link_state !== 'valid' ? ' degraded' : ''
  return (
    <>
      <tr className={'main' + degraded} data-card-site={r.site_id}>
        <td className="name">
          {r.line_of_sight !== null && (
            <span className={r.line_of_sight ? 'los' : 'nlos'} title={r.line_of_sight ? '视距' : '非视距'}>●</span>
          )}
          {r.site_name}
        </td>
        <td className="num" data-card-field="distance">{fmtMeters(r.distance_m)}</td>
        <td className="num" data-card-field="rx">{bare(r.rx_dBm)}</td>
        <td className="num" data-card-field="snr">{bare(r.snr_dB)}</td>
      </tr>
      <tr className={'sub' + degraded} data-card-site-bearing={r.site_id}>
        <td colSpan={4} data-card-field="bearing">
          <span className="k">测向</span>
          {b
            ? b.state === 'invalid'
              ? <span className="dim">本时刻无有效量测</span>
              : <>{bare(b.bearing_deg)}° ± {(2 * b.sigma_deg).toFixed(1)}° <span className="dim">{qShort(b.df_quality)}{b.mixture ? ' · 同频混叠' : ''}</span></>
            : <span className="dim">—</span>}
        </td>
      </tr>
    </>
  )
}

/** 焦点卡：一个目标的全部观测量。头一行身份，第二行运动一句话，中间各站一表，定位一行，身份配置折叠在底部。 */
function FocusCard({ c }: { c: TargetCardData }) {
  const m = c.motion
  return (
    <div className="focus-card" data-focus-card={c.id}>
      <div className="focus-head">
        <PlatformIcon type={c.platform_type} size={20} />
        <span className="focus-title">{c.name}</span>
        <span className="dim">{c.id}</span>
        {c.inZone && <span className="card-badge alert" data-card-zone={c.inZone}>{c.inZoneName ?? c.inZone}</span>}
      </div>
      <div className="focus-summary mono" data-focus-summary>
        {m
          ? <>{fmtMeters(m.alt_m)} · {m.speed_mps !== null ? `${m.speed_mps.toFixed(1)} m/s` : '—'} · 航向 {fmtDeg(m.heading_deg)} · 发射 {txText(m.tx_on)}{m.center_Hz !== null ? ` · ${fmtHz(m.center_Hz)}` : ''}</>
          : <span className="dim">未运行</span>}
      </div>
      {c.sites.length > 0 && (
        <div className="site-table-wrap">
          <table className="site-table" data-focus-sites>
            <thead>
              {/* 单位写在列头，数字裸写。不列真值方位（测向已是同一方向的量测）与路损（电平 = 发射 + 天线 − 路损，路损在探针里）。 */}
              <tr><th>站</th><th>距离</th><th>电平 dBm</th><th>信噪比 dB</th></tr>
            </thead>
            <tbody>{c.sites.map((r) => <SiteTableRows key={r.site_id} r={r} />)}</tbody>
          </table>
        </div>
      )}
      {c.fixes.map((f) => (
        <div className="focus-fix" key={f.method} data-card-fix={f.method}>
          <span className="k">定位</span>
          <span className="mono">
            {f.method} · {f.lat.toFixed(5)}, {f.lon.toFixed(5)} · CEP {f.cep_m.toFixed(0)} m
            {/* aoa 的 gdop 实为 rms_trace_m（米），tdoa 的是无量纲几何精度因子：按行标单位，不混（13 §3.3） */}
            {' · '}{f.method === 'aoa' ? `均方根 ${f.gdop.toFixed(1)} m` : `GDOP ${f.gdop.toFixed(2)}`}
            {' · '}{f.geometry_quality}{f.time_quality ? ` · ${f.time_quality}` : ''}
            {/* 最小交会角只对到达角交汇有意义；时差解上它恒为 0，不显示 */}
            {f.method.includes('aoa') ? ` · 交会 ${f.min_crossing_angle_deg.toFixed(0)}°` : ''} · {f.sites.length} 站
          </span>
        </div>
      ))}
      {m && <div className="focus-fix" data-focus-pos><span className="k">位置</span><span className="mono">{m.lat.toFixed(5)}, {m.lon.toFixed(5)}</span></div>}
      <details className="focus-identity" data-focus-identity>
        <summary>身份</summary>
        <div className="focus-identity-body">
          {PLATFORM_LABEL[c.platform_type] ?? c.platform_type}{c.equipment_model ? ` · ${c.equipment_model}` : ''}
          {c.center_Hz !== null ? ` · 中心 ${fmtHz(c.center_Hz)}` : ''}
          {c.bw_Hz !== null ? ` · 带宽 ${fmtHz(c.bw_Hz)}` : ''}
          {c.tx_power_dBm !== null ? ` · 发射 ${fmtDb(c.tx_power_dBm, 'dBm')}` : ''}
          {c.tx_gain_dBi !== null ? ` · 天线 ${c.tx_gain_dBi} dBi` : ''}
          {c.polarization ? ` · ${c.polarization}` : ''}
        </div>
      </details>
    </div>
  )
}

function TargetList({ cards, focusId, onPick }: { cards: TargetCardData[]; focusId: string | null; onPick: (id: string) => void }) {
  return (
    <table className="tlist" data-target-list>
      <thead>
        <tr><th></th><th>目标</th><th>高度</th><th>速度</th><th>发射</th><th>最近站</th></tr>
      </thead>
      <tbody>
        {cards.map((c) => {
          const m = c.motion
          return (
            <tr key={c.id} className={c.id === focusId ? 'sel' : ''} data-target-row={c.id} onClick={() => onPick(c.id)}>
              <td className="icon"><PlatformIcon type={c.platform_type} size={14} /></td>
              <td className="name">{c.name}{c.inZone ? <span className="card-badge alert" data-row-zone={c.inZone}>告警区</span> : null}</td>
              <td className="num">{m ? fmtMeters(m.alt_m) : '—'}</td>
              <td className="num">{m?.speed_mps !== null && m?.speed_mps !== undefined ? `${m.speed_mps.toFixed(1)} m/s` : '—'}</td>
              <td>{txText(m?.tx_on ?? null)}</td>
              <td className="num">{fmtMeters(c.nearest_m)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** 站点一行一站：只放观测到的量（测向质量、时统状态、链路数）。采样率、噪声系数、天线增益是配置，在左栏表单与框图页。 */
function SiteRows({ cards, selectedId, onPick }: { cards: SiteCardData[]; selectedId: string | null; onPick: (id: string) => void }) {
  return (
    <div className="site-rows" data-site-cards>
      {cards.map((c) => (
        <button type="button" key={c.id} className={'site-row' + (c.id === selectedId ? ' sel' : '')} data-site-card={c.id} onClick={() => onPick(c.id)}>
          <span className="site-name">◉ {c.name}</span>
          <span className="spacer" />
          {c.worst_quality && <span className="card-badge">{c.worst_quality}</span>}
          {c.sync_state && <span className="dim">{c.sync_state}</span>}
          <span className="dim">链路 {c.links}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * 视距探测卡（D3-7，D-074）。**只摆事实**（D-039）：站、点、假设高度、距离、视距与否、刀口损耗。
 *
 * 假设高度是一个输入不是读数——同一点贴地与 120 米是两个完全不同的答案，藏起来等于让人读错。
 * 自由空间路损**不在这张卡上**：浏览器里没有第二份 `fspl_dB`，为了一行读数新造一份无人守着的物理不划算。
 */
function LosProbeCard() {
  const s = useAppState()
  const store = useStore()
  const st = useSyncExternalStore(losProbeStore.subscribe, losProbeStore.get, losProbeStore.get)
  const scene = s.scene.summary
  if (st.status === 'idle') return null

  const r = st.result
  /** 改高度即把它固定下来（下一次点地图仍用这个值）；`null` 表示放开、跟回焦点目标。 */
  const retarget = (h: number | null) => {
    losProbeStore.setHeight(h)
    if (!r || !scene) return
    const next = probeInputAt(s, r.lon, r.lat, h ?? undefined)
    if ('error' in next) {
      store.dispatch({ type: 'ui/toast', kind: 'warn', text: `视距探测：${next.error}` })
      return
    }
    void runLosProbe(scene.buildingsUrl, scene.center[0], scene.center[1], next.input)
  }

  return (
    <div className="group" data-form="los-probe">
      <div className="group-title los-title">
        视距探测
        <span className="spacer" />
        <button type="button" className="mini" data-action="clear-los-probe" onClick={() => losProbeStore.clear()}>清除</button>
      </div>
      {st.status === 'loading' && <div className="dim">正在取建筑几何…（首次约 0.2 秒，之后即时）</div>}
      {st.status === 'error' && <div className="pp-warn">{st.error}</div>}
      {r && (
        <table className="los-table" data-los-probe={r.line_of_sight ? 'los' : 'nlos'}>
          <tbody>
            <tr><td className="name">站</td><td colSpan={2}>◉ {r.site_name}<span className="dim"> · 离地 {r.site.alt_m.toFixed(0)} m</span></td></tr>
            <tr><td className="name">点</td><td colSpan={2} className="mono">{r.lon.toFixed(6)}, {r.lat.toFixed(6)}</td></tr>
            <tr>
              <td className="name">假设目标高度</td>
              <td colSpan={2}>
                <input type="number" className="form-input mini-num" data-field="los-height" step={10} min={0}
                       value={Math.round(r.height_agl_m)} onChange={(e) => retarget(Number(e.target.value))} />
                <span className="dim"> m（AGL）</span>
                {st.heightOverride !== null
                  ? <button type="button" className="mini" data-action="los-height-follow"
                            title="放开固定，跟回焦点目标此刻的离地高" onClick={() => retarget(null)}>跟随目标</button>
                  : <span className="dim"> · 跟随焦点目标</span>}
              </td>
            </tr>
            <tr><td className="name">距离</td><td colSpan={2}>{fmtMeters(r.distance_m)}<span className="dim"> · 方位 {fmtDeg(r.azimuth_deg)}</span></td></tr>
            <tr>
              <td className="name">视距</td>
              <td colSpan={2} data-los-probe-verdict={r.line_of_sight ? 'los' : 'nlos'}>
                <span className={r.line_of_sight ? 'los' : 'nlos'}>●</span> {r.line_of_sight ? '视距' : '非视距'}
              </td>
            </tr>
            <tr>
              <td className="name">刀口绕射损耗</td>
              <td colSpan={2} data-los-probe-field="diffraction">{fmtDb(r.diffraction_dB)}
                {!r.line_of_sight && <span className="dim"> · 侵入 {r.intrusion_m.toFixed(1)} m</span>}
              </td>
            </tr>
            <tr><td className="name">频率</td><td colSpan={2}>{fmtHz(r.frequency_Hz)}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  )
}

export function SituationPanel() {
  const s = useAppState()
  const store = useStore()
  const doc = s.scene.scenario.doc
  const rev = useSceneRev()
  // rev 变了才重算：快照对象每次新建，靠版本号判断变化；回放时快照是时间轴 t 处的那一帧
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cards = useMemo(() => buildTargetCards(doc, currentSituation(doc)), [doc, rev])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const siteCards = useMemo(() => buildSiteCards(doc, currentSituation(doc)), [doc, rev])
  const sel = s.scene.editor.selection
  const focusId = focusTargetId(s)
  const focus = cards.find((c) => c.id === focusId) ?? cards[0] ?? null
  const selSite = sel && sel.kind === 'site' ? sel.id : null

  const pickEmitter = (id: string) => store.dispatch({ type: 'scene/select', selection: { kind: 'emitter', id } })
  const pickSite = (id: string) => store.dispatch({ type: 'scene/select', selection: { kind: 'site', id } })

  if (!doc) return <div className="group placeholder">载入场景后在这里看态势</div>
  return (
    <div className="situation" data-situation data-cards={cards.length}>
      {/* 探测结果压在最上面：它是刚刚点出来的，不是常驻读数；没探测过时整张卡不渲染 */}
      <LosProbeCard />
      {focus ? <FocusCard c={focus} /> : <div className="group dim">场景里没有辐射源</div>}
      {cards.length > 0 && (
        <div className="group">
          <div className="group-title">目标（{cards.length}）</div>
          <TargetList cards={cards} focusId={focus?.id ?? null} onPick={pickEmitter} />
        </div>
      )}
      <div className="group">
        <div className="group-title">站点（{siteCards.length}）</div>
        {siteCards.length === 0 ? <div className="dim">场景里没有站点</div> : <SiteRows cards={siteCards} selectedId={selSite} onPick={pickSite} />}
      </div>
    </div>
  )
}
