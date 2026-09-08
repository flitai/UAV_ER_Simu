// 场景对象树（09 §5.1）：站点、辐射源、航线、活动四组来自场景文件；
// **链路组是派生对象**（站点 × 辐射源），不入文件。点击即选中，右栏出属性或读数。

import { useAppState, useStore } from '../state/store.js'
import { loadScenarioInto } from '../shell/actions.js'
import { fmtHz, fmtSeconds } from '../shell/format.js'
import { activities, derivedLinks, emitters, sites, waypointsOf } from './editor/scenarioOps.js'
import type { SceneSelection } from '../state/types.js'

function sameSel(a: SceneSelection | null, b: SceneSelection): boolean {
  if (!a || a.kind !== b.kind) return false
  if (a.kind === 'activity' && b.kind === 'activity') return a.index === b.index
  if (a.kind === 'waypoint' && b.kind === 'waypoint') return a.id === b.id && a.index === b.index
  return 'id' in a && 'id' in b && a.id === b.id
}

export function ObjectTree({ onFlyTo }: { onFlyTo: (lon: number, lat: number) => void }) {
  const s = useAppState()
  const store = useStore()
  const doc = s.scene.scenario.doc
  const sel = s.scene.editor.selection
  const list = s.scene.scenario.list

  const pick = (selection: SceneSelection, lon?: number, lat?: number) => {
    store.dispatch({ type: 'scene/select', selection })
    if (lon !== undefined && lat !== undefined) onFlyTo(lon, lat)
  }

  if (s.scene.scenario.status === 'loading') return <div className="group placeholder">场景载入中…</div>
  if (!doc) {
    return (
      <div className="group">
        <div className="group-title">场景</div>
        {s.scene.scenario.error ? <div className="form-err">{s.scene.scenario.error}</div> : null}
        <div className="placeholder" style={{ padding: '6px 0' }}>
          {list.length ? '选一个场景' : '还没有场景文件'}
        </div>
        {list.map((x) => (
          <button key={x.scenario_id} className="tree-row" data-scenario={x.scenario_id}
                  onClick={() => void loadScenarioInto(store, x.scenario_id, () => true)}>
            {x.name}
          </button>
        ))}
      </div>
    )
  }

  const emList = emitters(doc)
  const acts = activities(doc)
  const links = derivedLinks(doc)

  return (
    <div className="group scene-tree" data-scene-tree>
      <div className="group-title">
        场景 {String(doc.name ?? doc.scenario_id)}
        {s.scene.dirty ? <span className="dot-dirty" title="未保存">●</span> : null}
      </div>
      <div className="tree-meta">
        时长 {fmtSeconds(Number((doc.time as Record<string, unknown>)?.duration_s ?? 0))} · 种子 {String(doc.seed ?? '—')}
      </div>

      <div className="tree-group">站点 ({sites(doc).length})</div>
      {sites(doc).map((x) => {
        const p = x.position as Record<string, number>
        const id = String(x.id)
        return (
          <button key={id} className={'tree-row' + (sameSel(sel, { kind: 'site', id }) ? ' sel' : '')}
                  data-tree-site={id} onClick={() => pick({ kind: 'site', id }, p.lon, p.lat)}>
            ◉ {String(x.name ?? id)}
          </button>
        )
      })}

      <div className="tree-group">辐射源 ({emList.length})</div>
      {emList.map((x) => {
        const id = String(x.id)
        const em = x.emission as Record<string, unknown>
        const p = x.position as Record<string, number>
        return (
          <button key={id} className={'tree-row' + (sameSel(sel, { kind: 'emitter', id }) ? ' sel' : '')}
                  data-tree-emitter={id} onClick={() => pick({ kind: 'emitter', id }, p.lon, p.lat)}>
            ✈ {String(x.name ?? id)} <span className="tree-dim">{fmtHz(Number(em?.center_Hz ?? 0))}</span>
          </button>
        )
      })}

      <div className="tree-group">航线</div>
      {emList.map((x) => {
        const id = String(x.id)
        const wps = waypointsOf(doc, id)
        if (!wps.length) return null
        return (
          <div key={id}>
            <div className="tree-sub">{String(x.name ?? id)} · {wps.length} 航点</div>
            {wps.map((w, i) => (
              <button key={i}
                      className={'tree-row indent' + (sameSel(sel, { kind: 'waypoint', id, index: i }) ? ' sel' : '')}
                      data-tree-waypoint={`${id}:${i}`}
                      onClick={() => pick({ kind: 'waypoint', id, index: i }, w.position.lon, w.position.lat)}>
              航点 {i + 1} <span className="tree-dim">{w.position.alt_m} m · {w.speed_mps} m/s</span>
              </button>
            ))}
          </div>
        )
      })}

      <div className="tree-group">活动 ({acts.length})</div>
      {acts.map((a, i) => (
        <button key={i} className={'tree-row' + (sameSel(sel, { kind: 'activity', index: i }) ? ' sel' : '')}
                data-tree-activity={i} onClick={() => pick({ kind: 'activity', index: i })}>
          {fmtSeconds(Number(a.t_s))} · {String(a.event)} <span className="tree-dim">{String(a.emitter_id)}</span>
        </button>
      ))}

      <div className="tree-group">链路 ({links.length}) <span className="tree-dim">派生</span></div>
      {links.map((l) => (
        <button key={l.id} className={'tree-row' + (sameSel(sel, { kind: 'link', id: l.id }) ? ' sel' : '')}
                data-tree-link={l.id} onClick={() => pick({ kind: 'link', id: l.id })}>
          {l.site} → {l.emitter}
        </button>
      ))}
    </div>
  )
}
