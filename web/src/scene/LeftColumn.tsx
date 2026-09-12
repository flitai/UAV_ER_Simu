// 场景页左栏 = 「场景是怎么配的」（13 报告 §13，D-062）：对象树 + 选中对象的表单 + 数据包一行。
//
// 树上只有场景一级对象（站点、辐射源、告警区）；航点与活动折在辐射源表单里，链路是派生关系不进树。
// 选中对象的表单接在树下面（09 §5.3 的表单本身不变），带一条「取消选择」；测量读数也走这里。

import { ObjectTree } from './ObjectTree.js'
import { ObjectPanel } from './ObjectForm.js'
import { ScenePackagePanel } from './ScenePackagePanel.js'
import { useAppState, useStore } from '../state/store.js'
import type { SceneSelection, SceneSummaryLite } from '../state/types.js'

function selLabel(sel: SceneSelection | null, measuring: boolean): string {
  if (measuring) return '测量'
  if (!sel) return ''
  switch (sel.kind) {
    case 'site': return `站点 ${sel.id}`
    case 'emitter': return `辐射源 ${sel.id}`
    case 'waypoint': return `${sel.id} · 航点 ${sel.index + 1}`
    case 'activity': return `活动 ${sel.index + 1}`
    case 'zone': return `告警区 ${sel.id}`
  }
}

export function LeftColumn({ onFlyTo, scene, error, dev }: {
  onFlyTo: (lon: number, lat: number) => void
  scene: SceneSummaryLite | null
  error: string | null
  dev: boolean
}) {
  const s = useAppState()
  const store = useStore()
  const sel = s.scene.editor.selection
  const measuring = s.scene.editor.measure.length === 2
  const showForm = !!s.scene.scenario.doc && (!!sel || measuring)
  return (
    <>
      <ObjectTree onFlyTo={onFlyTo} />
      {showForm && (
        <div className="sel-bar" data-selection-bar>
          <span>{selLabel(sel, measuring)}</span>
          <span className="spacer" />
          <button type="button" className="mini" data-action="clear-selection"
                  onClick={() => {
                    store.dispatch({ type: 'scene/select', selection: null })
                    if (measuring) store.dispatch({ type: 'scene/measure', points: [] })
                  }}>取消选择</button>
        </div>
      )}
      {showForm && <ObjectPanel />}
      <ScenePackagePanel scene={scene} error={error} dev={dev} />
    </>
  )
}
