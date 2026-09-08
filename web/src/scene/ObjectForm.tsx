// 右栏：对象表单（09 §5.3）与链路读数（09 §5.4）。
//
// 数值一律工程计数法显示与输入：`2.44 GHz`、`20 MHz`、`30 m`、`12 m/s`，输入接受 SI 前缀，
// 底层存 SI 基本单位。范围校验只做提示，规则的真正解释在引擎（D-042）——
// 前端复刻一份 schema 迟早会与引擎分叉。

import { useSyncExternalStore } from 'react'
import { useAppState, useStore } from '../state/store.js'
import { fmtDeg, fmtDelay, fmtHz, fmtMeters, parseSi } from '../shell/format.js'
import { sceneStore } from './sceneStore.js'
import {
  activities, addActivity, emitters, insertWaypoint, posOf, removeActivity, removeWaypoint,
  routeOf, setPath, sites, waypointsOf,
} from './editor/scenarioOps.js'
import { lookAngles, RoutePreview, type Waypoint } from './editor/preview.js'
import type { ScenarioDoc } from '../state/types.js'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <span className="form-label">{label}</span>
      <span className="form-value">{children}</span>
    </div>
  )
}

/** 一个数值字段：显示带单位，输入接受 SI 前缀；认不出来红框并保持原值（铁律 15）。 */
function NumField({
  label, value, unit, path, scale = 1, onCommit,
}: {
  label: string
  value: number
  unit: string
  path: string
  scale?: number
  onCommit: (path: string, v: number) => void
}) {
  return (
    <Row label={label}>
      <input
        className="form-input"
        defaultValue={String(value / scale)}
        data-field={path}
        onBlur={(e) => {
          const v = parseSi(e.currentTarget.value)
          if (v === null) {
            e.currentTarget.classList.add('bad')
            e.currentTarget.value = String(value / scale)
            return
          }
          e.currentTarget.classList.remove('bad')
          if (v * scale !== value) onCommit(path, v * scale)
        }}
      />
      <span className="form-unit">{unit}</span>
    </Row>
  )
}

export function ObjectPanel() {
  const s = useAppState()
  const store = useStore()
  const doc = s.scene.scenario.doc
  const sel = s.scene.editor.selection
  const measure = s.scene.editor.measure

  const edit = (next: ScenarioDoc) => store.dispatch({ type: 'scene/edit', doc: next })
  const commit = (path: string, v: number) => { if (doc) edit(setPath(doc, path, v)) }

  if (measure.length === 2) return <MeasureReadout a={measure[0]} b={measure[1]} />
  if (!doc) return <div className="group placeholder">载入场景后在这里编辑对象</div>
  if (!sel) return <div className="group placeholder">在左栏或地图上选一个对象</div>

  if (sel.kind === 'link') return <LinkReadout linkId={sel.id} doc={doc} />

  if (sel.kind === 'site') {
    const i = sites(doc).findIndex((x) => x.id === sel.id)
    const site = sites(doc)[i]
    if (!site) return <div className="group placeholder">对象已不存在</div>
    const p = site.position as Record<string, number>
    const ant = site.antenna as Record<string, number>
    const rx = site.receiver as Record<string, number>
    return (
      <div className="group" data-form="site">
        <div className="group-title">站点 {String(site.name ?? site.id)}</div>
        <Row label="经度"><span className="mono">{p.lon.toFixed(6)}°</span></Row>
        <Row label="纬度"><span className="mono">{p.lat.toFixed(6)}°</span></Row>
        <NumField label="离地高" value={p.alt_m} unit="m（AGL）" path={`sites.${i}.position.alt_m`} onCommit={commit} />
        <NumField label="天线增益" value={ant.gain_dBi} unit="dBi" path={`sites.${i}.antenna.gain_dBi`} onCommit={commit} />
        <div className="form-sub">接收机</div>
        <NumField label="采样率" value={rx.fs_Hz} unit="Hz" path={`sites.${i}.receiver.fs_Hz`} onCommit={commit} />
        <NumField label="中心频率" value={rx.center_Hz} unit="Hz" path={`sites.${i}.receiver.center_Hz`} onCommit={commit} />
        <NumField label="带宽" value={rx.bw_Hz} unit="Hz" path={`sites.${i}.receiver.bw_Hz`} onCommit={commit} />
        <NumField label="噪声系数" value={rx.nf_dB} unit="dB" path={`sites.${i}.receiver.nf_dB`} onCommit={commit} />
      </div>
    )
  }

  if (sel.kind === 'emitter') {
    const i = emitters(doc).findIndex((x) => x.id === sel.id)
    const em = emitters(doc)[i]
    if (!em) return <div className="group placeholder">对象已不存在</div>
    const e = em.emission as Record<string, unknown>
    const w = e.waveform as Record<string, unknown>
    return (
      <div className="group" data-form="emitter">
        <div className="group-title">辐射源 {String(em.name ?? em.id)}</div>
        <Row label="机型"><span>{String(em.platform_type)}</span></Row>
        <NumField label="中心频率" value={Number(e.center_Hz)} unit="Hz" path={`emitters.${i}.emission.center_Hz`} onCommit={commit} />
        <NumField label="占用带宽" value={Number(e.bw_Hz)} unit="Hz" path={`emitters.${i}.emission.bw_Hz`} onCommit={commit} />
        <NumField label="发射功率" value={Number(e.tx_power_dBm)} unit="dBm" path={`emitters.${i}.emission.tx_power_dBm`} onCommit={commit} />
        <NumField label="天线增益" value={Number(e.antenna_gain_dBi)} unit="dBi" path={`emitters.${i}.emission.antenna_gain_dBi`} onCommit={commit} />
        <div className="form-sub">波形 {String(w.type)}</div>
        {typeof w.offset_Hz === 'number'
          ? <NumField label="频偏" value={w.offset_Hz} unit="Hz" path={`emitters.${i}.emission.waveform.offset_Hz`} onCommit={commit} />
          : null}
        {typeof w.period_s === 'number'
          ? <NumField label="突发周期" value={w.period_s} unit="s" path={`emitters.${i}.emission.waveform.period_s`} onCommit={commit} />
          : null}
        {typeof w.duty === 'number'
          ? <NumField label="占空比" value={w.duty} unit="" path={`emitters.${i}.emission.waveform.duty`} onCommit={commit} />
          : null}
        <ActivityEditor doc={doc} emitterId={String(em.id)} />
      </div>
    )
  }

  if (sel.kind === 'activity') {
    const a = activities(doc)[sel.index]
    if (!a) return <div className="group placeholder">活动已不存在</div>
    return (
      <div className="group" data-form="activity">
        <div className="group-title">活动 {sel.index + 1}</div>
        <Row label="时刻"><span className="mono">{Number(a.t_s).toFixed(1)} s</span></Row>
        <Row label="事件">{String(a.event)}</Row>
        <Row label="辐射源">{String(a.emitter_id)}</Row>
        <NumField label="时刻" value={Number(a.t_s)} unit="s" path={`activities.${sel.index}.t_s`} onCommit={commit} />
        <div className="form-actions">
          <button data-act="remove-activity" onClick={() => {
            edit(removeActivity(doc, sel.index))
            store.dispatch({ type: 'scene/select', selection: null })
          }}>删除活动</button>
        </div>
        <div className="form-note">
          活动必须按时刻非降排序，改了时刻后保存前会自动重排（docs/scenario-format.md §6）。
        </div>
      </div>
    )
  }

  // 航点
  const emId = sel.id
  const wps = waypointsOf(doc, emId)
  const w = wps[sel.index]
  if (!w) return <div className="group placeholder">航点已不存在</div>
  const r = routeOf(doc, emId)
  const ri = (doc.routes as Array<Record<string, unknown>>).indexOf(r as Record<string, unknown>)
  const base = `routes.${ri}.waypoints.${sel.index}`
  return (
    <div className="group" data-form="waypoint">
      <div className="group-title">{emId} · 航点 {sel.index + 1} / {wps.length}</div>
      <Row label="经度"><span className="mono">{w.position.lon.toFixed(6)}°</span></Row>
      <Row label="纬度"><span className="mono">{w.position.lat.toFixed(6)}°</span></Row>
      <NumField label="离地高" value={w.position.alt_m} unit="m（AGL）" path={`${base}.position.alt_m`} onCommit={commit} />
      <NumField label="速度" value={w.speed_mps} unit="m/s" path={`${base}.speed_mps`} onCommit={commit} />
      <NumField label="悬停" value={w.loiter_s ?? 0} unit="s" path={`${base}.loiter_s`} onCommit={commit} />
      <div className="form-actions">
        <button data-act="insert-wp" onClick={() => edit(insertWaypoint(doc, emId, sel.index))}>插入航点</button>
        <button data-act="remove-wp" disabled={wps.length <= 1}
                onClick={() => { edit(removeWaypoint(doc, emId, sel.index)); store.dispatch({ type: 'scene/select', selection: null }) }}>
          删除航点
        </button>
      </div>
      <RouteSummary wps={wps} />
    </div>
  )
}

function RouteSummary({ wps }: { wps: Waypoint[] }) {
  const p = new RoutePreview(wps, false)
  return (
    <div className="form-note">
      航线全程 {p.durationS.toFixed(1)} s（浏览器预览，只做直线插值；物理量由引擎给出）
    </div>
  )
}

function ActivityEditor({ doc, emitterId }: { doc: ScenarioDoc; emitterId: string }) {
  const store = useStore()
  const acts = activities(doc).map((a, i) => ({ a, i })).filter((x) => x.a.emitter_id === emitterId)
  return (
    <>
      <div className="form-sub">活动时间线</div>
      {acts.map(({ a, i }) => (
        <div className="form-row" key={i}>
          <span className="form-label mono">{Number(a.t_s).toFixed(1)} s</span>
          <span className="form-value">{String(a.event)}</span>
          <button className="mini" data-act="remove-activity"
                  onClick={() => store.dispatch({ type: 'scene/edit', doc: removeActivity(doc, i) })}>删</button>
        </div>
      ))}
      <div className="form-actions">
        {(['tx_on', 'tx_off', 'hover', 'cruise'] as const).map((ev) => (
          <button key={ev} className="mini" data-act={`add-${ev}`}
                  onClick={() => store.dispatch({ type: 'scene/edit', doc: addActivity(doc, emitterId, 0, ev) })}>
            + {ev}
          </button>
        ))}
      </div>
    </>
  )
}

/**
 * 链路读数（09 §5.4）。运行时来自引擎的参数帧（WS link 事件 / links.jsonl）；
 * 未运行时只给浏览器能算的几何量，路损、时延、多普勒一律写「运行后由引擎给出」——
 * 前端不做物理（docs/scenario-format.md §1）。
 */
function LinkReadout({ linkId, doc }: { linkId: string; doc: ScenarioDoc }) {
  const st = useSyncExternalStore(sceneStore.subscribe, sceneStore.get, sceneStore.get)
  const live = st.links.get(linkId)
  const dash = linkId.lastIndexOf('-')
  const siteId = linkId.slice(0, dash)
  const emId = linkId.slice(dash + 1)
  const sp = posOf(sites(doc).find((x) => x.id === siteId))
  const target = st.entities.get(emId)
  const ep = target ? { lon: target.lon, lat: target.lat, alt_m: target.alt_m } : posOf(emitters(doc).find((x) => x.id === emId))
  const geo = sp && ep ? lookAngles(sp, ep) : null

  return (
    <div className="group" data-form="link">
      <div className="group-title">链路 {siteId} → {emId}</div>
      <Row label="状态">
        {live
          ? <span className={live.line_of_sight ? 'badge-los' : 'badge-nlos'}>
              ● {live.line_of_sight ? '视距' : '非视距'} <span className="tree-dim">平地假设</span>
            </span>
          : <span className="tree-dim">未运行</span>}
      </Row>
      <Row label="距离">{fmtMeters(live ? live.distance_m : geo?.distance_m)}</Row>
      <Row label="方位">{fmtDeg(live ? live.azimuth_deg : geo?.azimuth_deg)}</Row>
      <Row label="俯仰">{fmtDeg(live ? live.elevation_deg : geo?.elevation_deg)}</Row>
      <Row label="路损">
        {live ? <>{live.path_loss_dB.toFixed(2)} dB <span className="tree-dim">自由空间</span></> : <span className="tree-dim">运行后由引擎给出</span>}
      </Row>
      <Row label="时延">{live ? fmtDelay(live.delay_s) : <span className="tree-dim">运行后由引擎给出</span>}</Row>
      <Row label="多普勒">{live ? `${live.doppler_Hz >= 0 ? '+' : '−'}${Math.abs(live.doppler_Hz).toFixed(1)} Hz` : <span className="tree-dim">运行后由引擎给出</span>}</Row>
      {live ? (
        <>
          <Row label="帧"><span className="mono">{live.valid_from_s.toFixed(3)}–{live.valid_to_s.toFixed(3)} s</span></Row>
          <Row label="更新率">{live.update_rate_Hz.toFixed(0)} Hz <span className={live.state === 'valid' ? 'badge-los' : 'badge-nlos'}>● {live.state}</span></Row>
        </>
      ) : null}
      {target ? (
        <>
          <div className="form-sub">目标</div>
          <Row label="高度">{fmtMeters(target.alt_m)}</Row>
          <Row label="航向">{fmtDeg(target.heading_deg)}</Row>
          <Row label="速度">{target.speed_mps.toFixed(1)} m/s</Row>
          <Row label="发射">{target.tx_on ? '开' : '关'} · {fmtHz(target.center_Hz)}</Row>
        </>
      ) : null}
    </div>
  )
}

function MeasureReadout({ a, b }: { a: { lon: number; lat: number }; b: { lon: number; lat: number } }) {
  const g = lookAngles({ ...a, alt_m: 0 }, { ...b, alt_m: 0 })
  return (
    <div className="group" data-form="measure">
      <div className="group-title">测量</div>
      <Row label="距离">{fmtMeters(g.distance_m)}</Row>
      <Row label="方位">{fmtDeg(g.azimuth_deg)} <span className="tree-dim">真北顺时针</span></Row>
      <div className="form-note">再点一次地图开始新的测量；切回「选择」工具即退出。</div>
    </div>
  )
}
