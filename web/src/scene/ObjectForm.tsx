// 对象表单（09 §5.3）。自 D-062 起在左栏（配置归左、观测归右）：链路读数、测向与定位不再出现在表单里，
// 它们在右栏的焦点卡上；航点与活动折在辐射源表单里（默认收起）。
//
// 数值一律工程计数法显示与输入：`2.44 GHz`、`20 MHz`、`30 m`、`12 m/s`，输入接受 SI 前缀，
// 底层存 SI 基本单位。范围校验只做提示，规则的真正解释在引擎（D-042）——
// 前端复刻一份 schema 迟早会与引擎分叉。

import { useAppState, useStore } from '../state/store.js'
import { fmtDeg, fmtMeters, parseSi } from '../shell/format.js'
import {
  activities, addActivity, emitters, hopSequenceMHz, insertWaypoint, removeActivity, removeEmitter,
  removeWaypoint, removeZone, routeOf, setHopArgs, setPath, sites, waypointsOf, zones, type Obj,
} from './editor/scenarioOps.js'
import { lookAngles, RoutePreview, type Waypoint } from './editor/preview.js'
import {
  devicePath, fieldsFor, readField, type DeviceField, type DeviceKind,
} from './editor/deviceFields.js'
import type { ScenarioDoc } from '../state/types.js'
import { enumLabel } from '../chain/enumLabels.js'

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
          {/* 取值用中文名：rel 的末段就是参数名（emission.polarization → polarization） */}
          {(field.options ?? []).map((o) => <option key={o} value={o}>{enumLabel(field.rel.split('.').pop() ?? '', o)}</option>)}
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
  if (!doc) return <div className="group placeholder">载入场景后编辑对象</div>
  if (!sel) return <div className="group placeholder">在左栏或地图上选择对象</div>

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
        <RouteSection doc={doc} emitterId={String(em.id)} />
        <ActivitySection doc={doc} emitterId={String(em.id)} />
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
        {String(a.event) === 'hop' && (
          <>
            <Row label="跳频点">
              <input
                className="form-input"
                defaultValue={hopSequenceMHz(a)}
                data-field="hop-sequence"
                placeholder="MHz，逗号分隔"
                onBlur={(e) => edit(setHopArgs(doc, sel.index, e.currentTarget.value, undefined))}
              />
            </Row>
            <NumField label="停留" value={Number((a.args as Obj | undefined)?.dwell_s ?? 0)} unit="s"
                      path={`activities.${sel.index}.args.dwell_s`} onCommit={commit} />
            <div className="form-note">
              跳频点按停留时长循环。停留要能折出至少一个样点，且跳频点连同带宽都得落在
              站点的奈奎斯特带内（铁律 4）——越界时运行前的频率计划检查会报出是哪一个点。
            </div>
          </>
        )}
        <div className="form-actions">
          <button data-act="back-emitter" onClick={() => store.dispatch({ type: 'scene/select', selection: { kind: 'emitter', id: String(a.emitter_id) } })}>返回辐射源</button>
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
        <button data-act="back-emitter" onClick={() => store.dispatch({ type: 'scene/select', selection: { kind: 'emitter', id: emId } })}>返回辐射源</button>
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

/** 辐射源的航线（D-062）：默认收起的一行「航线 · N 航点」，展开后一行一航点，点了即选中该航点（表单换成航点表单）。 */
function RouteSection({ doc, emitterId }: { doc: ScenarioDoc; emitterId: string }) {
  const store = useStore()
  const wps = waypointsOf(doc, emitterId)
  const dur = wps.length ? new RoutePreview(wps, false).durationS : 0
  return (
    <details className="form-details" data-form-route={emitterId}>
      <summary>航线 · {wps.length} 航点{wps.length ? <span className="tree-dim"> · 全程 {dur.toFixed(0)} s</span> : null}</summary>
      {wps.map((w, i) => (
        <button key={i} type="button" className="tree-row indent" data-tree-waypoint={`${emitterId}:${i}`}
                onClick={() => store.dispatch({ type: 'scene/select', selection: { kind: 'waypoint', id: emitterId, index: i } })}>
          航点 {i + 1} <span className="tree-dim">{w.position.alt_m} m · {w.speed_mps} m/s</span>
        </button>
      ))}
      {!wps.length && <div className="form-note">使用工具条「编辑场景 › 航点」在地图上连续点击添加</div>}
    </details>
  )
}

/** 辐射源的活动时间线（D-062）：默认收起；一行一活动，点时刻即选中（可改时刻），「删」直接删；底部按钮追加。 */
function ActivitySection({ doc, emitterId }: { doc: ScenarioDoc; emitterId: string }) {
  const store = useStore()
  const acts = activities(doc).map((a, i) => ({ a, i })).filter((x) => x.a.emitter_id === emitterId)
  return (
    <details className="form-details" data-form-activities={emitterId}>
      <summary>活动 · {acts.length}</summary>
      {acts.map(({ a, i }) => (
        <div className="form-row" key={i}>
          <button type="button" className="tree-row indent" data-tree-activity={i}
                  onClick={() => store.dispatch({ type: 'scene/select', selection: { kind: 'activity', index: i } })}>
            <span className="mono">{Number(a.t_s).toFixed(1)} s</span> · {String(a.event)}
          </button>
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
        {/* hop 必须带参数才立得住（cross_check 要求 center_Hz 与 sequence 二选一、序列须带正的
            dwell_s），所以新建时就给一组以该源自己的中心频率为基准的缺省值，用户再改 */}
        <button className="mini" data-act="add-hop"
                onClick={() => {
                  const f0 = Number(((emitters(doc).find((e) => String(e.id) === emitterId)?.emission ?? {}) as Obj).center_Hz)
                  const base = Number.isFinite(f0) ? f0 : 2.44e9
                  store.dispatch({ type: 'scene/edit',
                    doc: addActivity(doc, emitterId, 0, 'hop',
                      { sequence: [Math.round(base - 3e5), Math.round(base + 3e5)], dwell_s: 0.01 }) })
                }}>
          + hop
        </button>
      </div>
    </details>
  )
}

function MeasureReadout({ a, b }: { a: { lon: number; lat: number }; b: { lon: number; lat: number } }) {
  const g = lookAngles({ ...a, alt_m: 0 }, { ...b, alt_m: 0 })
  return (
    <div className="group" data-form="measure">
      <div className="group-title">测量</div>
      <Row label="距离">{fmtMeters(g.distance_m)}</Row>
      <Row label="方位">{fmtDeg(g.azimuth_deg)} <span className="tree-dim">真北顺时针</span></Row>
      <div className="form-note">再次点击地图开始新的测量；切换至「选择」工具退出。</div>
    </div>
  )
}
