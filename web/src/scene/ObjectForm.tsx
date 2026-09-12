// 右栏：对象表单（09 §5.3）与链路读数（09 §5.4）。
//
// 数值一律工程计数法显示与输入：`2.44 GHz`、`20 MHz`、`30 m`、`12 m/s`，输入接受 SI 前缀，
// 底层存 SI 基本单位。范围校验只做提示，规则的真正解释在引擎（D-042）——
// 前端复刻一份 schema 迟早会与引擎分叉。

import { useSyncExternalStore } from 'react'
import { useAppState, useStore } from '../state/store.js'
import { fmtDeg, fmtDelay, fmtHz, fmtMeters, parseSi } from '../shell/format.js'
import { sceneStore, type PositionSample } from './sceneStore.js'
import {
  activities, addActivity, emitters, insertWaypoint, posOf, removeActivity, removeEmitter,
  removeWaypoint, removeZone, routeOf, setPath, sites, splitLinkId, waypointsOf, zones, type Obj,
} from './editor/scenarioOps.js'
import { lookAngles, RoutePreview, type Waypoint } from './editor/preview.js'
import {
  devicePath, fieldsFor, readField, type DeviceField, type DeviceKind,
} from './editor/deviceFields.js'
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

/**
 * 按 `deviceFields.ts` 的描述渲染一个设备参数字段（D-054）。
 * 枚举与数值走同一个入口，两处界面因此长得一样、行为也一样。
 */
export function DeviceRow({
  field, entity, kind, index, onCommit,
}: {
  field: DeviceField
  entity: Obj | undefined
  kind: DeviceKind
  index: number
  onCommit: (path: string, v: unknown) => void
}) {
  const path = devicePath(kind, index, field.rel)
  const raw = readField(entity, field.rel)
  if (field.type === 'enum') {
    // 缺席时显示缺省值，但**不**写回文件——没选过就是没写过（铁律 15）
    const cur = typeof raw === 'string' ? raw : (field.fallback ?? '')
    return (
      <Row label={field.label}>
        <select className="form-input" data-field={path} value={cur}
          onChange={(e) => onCommit(path, e.target.value)}>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Row>
    )
  }
  if (field.type === 'text') {
    // 留空即**删掉**这个键，而不是写空串：场景 schema 要求它非空，写空串会被引擎拒
    const cur = typeof raw === 'string' ? raw : ''
    return (
      <Row label={field.label}>
        <input className="form-input" defaultValue={cur} placeholder="未设置" data-field={path}
          onBlur={(e) => {
            const text = e.currentTarget.value.trim()
            if (text !== cur) onCommit(path, text === '' ? undefined : text)
          }} />
      </Row>
    )
  }
  return (
    <Row label={field.label}>
      <input
        className="form-input"
        // 字段缺席（站钟那几项本来就可能没有）时留空，不写 0——0 是个合法取值，顶上去就分不清了
        defaultValue={typeof raw === 'number' ? String(raw) : ''}
        placeholder={typeof raw === 'number' ? undefined : '未设置'}
        data-field={path}
        onBlur={(e) => {
          const text = e.currentTarget.value.trim()
          if (text === '') return                       // 留空即不改，不是「改成 0」
          const v = parseSi(text)
          if (v === null) {
            e.currentTarget.classList.add('bad')
            e.currentTarget.value = typeof raw === 'number' ? String(raw) : ''
            return
          }
          e.currentTarget.classList.remove('bad')
          if (v !== raw) onCommit(path, v)
        }}
      />
      <span className="form-unit">{field.unit}</span>
    </Row>
  )
}

/** 一个实体的整组设备参数。场景视图与框图页共用。 */
export function DeviceFieldGroup({
  kind, index, entity, onCommit,
}: {
  kind: DeviceKind
  index: number
  entity: Obj | undefined
  onCommit: (path: string, v: unknown) => void
}) {
  return (
    <>
      {fieldsFor(kind, entity).map((f) => (
        <DeviceRow key={f.key} field={f} entity={entity} kind={kind} index={index} onCommit={onCommit} />
      ))}
    </>
  )
}

export function ObjectPanel() {
  const s = useAppState()
  const store = useStore()
  const doc = s.scene.scenario.doc
  const sel = s.scene.editor.selection
  const measure = s.scene.editor.measure

  const edit = (next: ScenarioDoc) => store.dispatch({ type: 'scene/edit', doc: next })
  const commit = (path: string, v: unknown) => { if (doc) edit(setPath(doc, path, v)) }

  if (measure.length === 2) return <MeasureReadout a={measure[0]} b={measure[1]} />
  if (!doc) return <div className="group placeholder">载入场景后在这里编辑对象</div>
  if (!sel) return <div className="group placeholder">在左栏或地图上选一个对象</div>

  if (sel.kind === 'link') return <LinkReadout linkId={sel.id} doc={doc} />

  if (sel.kind === 'site') {
    const i = sites(doc).findIndex((x) => x.id === sel.id)
    const site = sites(doc)[i]
    if (!site) return <div className="group placeholder">对象已不存在</div>
    const p = site.position as Record<string, number>
    return (
      <div className="group" data-form="site">
        <div className="group-title">站点 {String(site.name ?? site.id)}</div>
        <Row label="经度"><span className="mono">{p.lon.toFixed(6)}°</span></Row>
        <Row label="纬度"><span className="mono">{p.lat.toFixed(6)}°</span></Row>
        <NumField label="离地高" value={p.alt_m} unit="m（AGL）" path={`sites.${i}.position.alt_m`} onCommit={commit} />
        <div className="form-sub">设备参数</div>
        <DeviceFieldGroup kind="site" index={i} entity={site} onCommit={commit} />
      </div>
    )
  }

  if (sel.kind === 'emitter') {
    const i = emitters(doc).findIndex((x) => x.id === sel.id)
    const em = emitters(doc)[i]
    if (!em) return <div className="group placeholder">对象已不存在</div>
    const w = (em.emission as Record<string, unknown>).waveform as Record<string, unknown>
    return (
      <div className="group" data-form="emitter">
        <div className="group-title">辐射源 {String(em.name ?? em.id)}</div>
        <Row label="机型"><span>{String(em.platform_type)}</span></Row>
        <div className="form-sub">设备参数（波形 {String(w.type)}）</div>
        <DeviceFieldGroup kind="emitter" index={i} entity={em} onCommit={commit} />
        <ActivityEditor doc={doc} emitterId={String(em.id)} />
        <EmitterLinks doc={doc} emitterId={String(em.id)} />
        <EmitterFixes emitterId={String(em.id)} />
        <button className="btn danger" data-action="remove-emitter"
          onClick={() => {
            store.dispatch({ type: 'scene/edit', doc: removeEmitter(doc, String(em.id)) })
            store.dispatch({ type: 'scene/select', selection: null })
          }}>删除目标</button>
      </div>
    )
  }

  if (sel.kind === 'zone') {
    const i = zones(doc).findIndex((x) => x.id === sel.id)
    const z = zones(doc)[i]
    if (!z) return <div className="group placeholder">对象已不存在</div>
    const c = z.center as Record<string, number>
    const base = `zones.${i}`
    const hasAlt = typeof z.alt_max_m === 'number'
    return (
      <div className="group" data-form="zone" key={sel.id}>
        <div className="group-title">告警区 {String(z.name ?? z.id)}</div>
        <Row label="名称">
          <input className="form-input" defaultValue={String(z.name ?? '')} data-field={`${base}.name`}
                 onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== z.name) commit(`${base}.name`, v) }} />
        </Row>
        <Row label="类别">
          <select className="form-input" value={String(z.kind)} data-field={`${base}.kind`} onChange={(e) => commit(`${base}.kind`, e.target.value)}>
            <option value="alert">alert</option>
            <option value="warning">warning</option>
          </select>
        </Row>
        <NumField label="圆心经度" value={c.lon} unit="°" path={`${base}.center.lon`} onCommit={commit} />
        <NumField label="圆心纬度" value={c.lat} unit="°" path={`${base}.center.lat`} onCommit={commit} />
        <NumField label="半径" value={Number(z.radius_m)} unit="m" path={`${base}.radius_m`} onCommit={commit} />
        <Row label="限高">
          <label><input type="checkbox" checked={hasAlt} data-field={`${base}.alt_max`}
                        onChange={(e) => commit(`${base}.alt_max_m`, e.target.checked ? 300 : undefined)} /> 有上限</label>
        </Row>
        {hasAlt && <NumField label="离地高上限" value={Number(z.alt_max_m)} unit="m（AGL）" path={`${base}.alt_max_m`} onCommit={commit} />}
        <div className="form-actions">
          <button className="btn danger" data-action="remove-zone"
                  onClick={() => { edit(removeZone(doc, String(z.id))); store.dispatch({ type: 'scene/select', selection: null }) }}>删除告警区</button>
        </div>
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

/**
 * 这个辐射源对每个站的链路读数（D-053 §5.3）。多站之后「链路」有 K 条，
 * 挨个列出来比让用户去对象树里逐条点开省事；数值来自 `derivedLinks()` 已经算好的那一份。
 */
function EmitterLinks({ doc, emitterId }: { doc: ScenarioDoc; emitterId: string }) {
  const list = sites(doc)
  if (list.length === 0) return null
  const ep = posOf(emitters(doc).find((x) => x.id === emitterId))
  if (!ep) return null
  return (
    <div data-form-links={emitterId}>
      <div className="form-sub">链路（{list.length} 个站）</div>
      {list.map((st) => {
        const sp = posOf(st)
        if (!sp) return null
        const g = lookAngles(sp, ep)
        return (
          <Row key={String(st.id)} label={String(st.name ?? st.id)}>
            <span>{(g.distance_m / 1000).toFixed(2)} km · {g.azimuth_deg.toFixed(1)}° · {g.elevation_deg.toFixed(1)}°</span>
          </Row>
        )
      })}
    </div>
  )
}

/**
 * 这个辐射源的测向与定位读数（D-053 §5.6）。数据来自 sceneStore（实时 WS 或结束后的文件回放），
 * 没跑过任务时整块不出现——空表格比不显示更让人以为「跑了但没结果」。
 */
function EmitterFixes({ emitterId }: { emitterId: string }) {
  const st = useSyncExternalStore(sceneStore.subscribe, sceneStore.get, sceneStore.get)
  const bs: Array<{ site: string; deg: number; sigma: number; q: string; state: string; mix: boolean }> = []
  st.bearings.forEach((b) => {
    if (b.emitter_id === emitterId) {
      bs.push({ site: b.site_id, deg: b.bearing_deg, sigma: b.bearing_std_deg,
                q: b.df_quality, state: b.df_result_state, mix: b.mixture })
    }
  })
  bs.sort((a, b) => (a.site < b.site ? -1 : 1))
  const ps: Array<{ key: string; p: PositionSample }> = []
  st.positions.forEach((p, k) => { if (p.emitter_id === emitterId) ps.push({ key: k, p }) })
  ps.sort((a, b) => (a.key < b.key ? -1 : 1))
  if (!bs.length && !ps.length) return null
  return (
    <div data-form-fixes={emitterId}>
      {bs.length > 0 && <div className="form-sub">测向</div>}
      {bs.map((b) => (
        <Row key={b.site} label={b.site}>
          <span className={b.state === 'valid' ? '' : 'muted'}>
            {b.state === 'invalid'
              ? '本时刻无有效量测'
              : `${b.deg.toFixed(1)}° · σ ${b.sigma.toFixed(2)}° · ${b.q}${b.mix ? ' · 同频混叠' : ''}`}
          </span>
        </Row>
      ))}
      {ps.length > 0 && <div className="form-sub">定位</div>}
      {ps.map(({ key, p }) => (
        <div key={key}>
          <Row label={p.method}>
            <span>{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</span>
          </Row>
          <Row label="CEP / GDOP">
            <span>{p.cep_m.toFixed(0)} m · {p.gdop.toFixed(2)} · {p.geometry_quality}
              {p.time_quality ? ` · ${p.time_quality}` : ''}</span>
          </Row>
          <Row label="最小交会角">
            <span className={p.min_crossing_angle_deg < 15 ? 'muted' : ''}>
              {p.min_crossing_angle_deg.toFixed(1)}°{p.min_crossing_angle_deg < 15 ? '（交汇偏平，椭圆偏乐观）' : ''}
            </span>
          </Row>
          <Row label="参与站">
            <span>{p.participating_sites.join('、') || '—'}</span>
          </Row>
        </div>
      ))}
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
  // 按已知的站与源精确匹配，不按连字符拆（D-061）；对不上就只显示活值，几何回退空着
  const ids = splitLinkId(doc, linkId)
  const siteId = ids?.site ?? linkId
  const emId = ids?.emitter ?? ''
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
