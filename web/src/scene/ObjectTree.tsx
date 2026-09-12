// 场景对象树（09 §5.1；13 报告 §13，D-062 瘦身）：只列场景的一级对象——站点、辐射源、告警区，一行一个。
// 航点与活动是辐射源的内部明细，折在它的表单里；链路是站点 × 辐射源的派生关系，地图与右栏在显示，不进树。
// 点击即选中：表单出现在树下面，右栏的焦点卡跟着选中的辐射源走。

import { useAppState, useStore } from '../state/store.js'
import { loadScenarioInto } from '../shell/actions.js'
import { fmtHz, fmtSeconds } from '../shell/format.js'
import { emitters, sites, zones } from './editor/scenarioOps.js'
import type { SceneSelection } from '../state/types.js'

function sameSel(a: SceneSelection | null, b: SceneSelection): boolean {
  if (!a || a.kind !== b.kind) return false
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
  const zoneList = zones(doc)

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
        const active = sel && (sel.kind === 'emitter' || sel.kind === 'waypoint') && sel.id === id
        return (
          <button key={id} className={'tree-row' + (active ? ' sel' : '')}
                  data-tree-emitter={id} onClick={() => pick({ kind: 'emitter', id }, p.lon, p.lat)}>
            ✈ {String(x.name ?? id)} <span className="tree-dim">{fmtHz(Number(em?.center_Hz ?? 0))}</span>
          </button>
        )
      })}

      <div className="tree-group">告警区 ({zoneList.length})</div>
      {zoneList.map((z) => {
        const id = String(z.id)
        const c = z.center as Record<string, number>
        return (
          <button key={id} className={'tree-row' + (sameSel(sel, { kind: 'zone', id }) ? ' sel' : '')}
                  data-tree-zone={id} onClick={() => pick({ kind: 'zone', id }, c.lon, c.lat)}>
            ◯ {String(z.name ?? id)} <span className="tree-dim">{String(z.kind)} · {Number(z.radius_m)} m</span>
          </button>
        )
      })}
    </div>
  )
}
