// 场景页右栏（13 报告 §2、§3，D-061）：常驻卡片栈；选中对象或量了两点时，表单叠在栈顶并带「返回卡片」。
// 09 §5.3 的表单本身不变（ObjectPanel），只是不再独占右栏、不再用空态提示占位。

import { ObjectPanel } from './ObjectForm.js'
import { CardStack } from './cards/Cards.js'
import { useAppState, useStore } from '../state/store.js'
import type { SceneSelection } from '../state/types.js'

function selLabel(sel: SceneSelection | null, measuring: boolean): string {
  if (measuring) return '测量'
  if (!sel) return ''
  switch (sel.kind) {
    case 'site': return `站点 ${sel.id}`
    case 'emitter': return `辐射源 ${sel.id}`
    case 'waypoint': return `${sel.id} · 航点 ${sel.index + 1}`
    case 'activity': return `活动 ${sel.index + 1}`
    case 'link': return `链路 ${sel.id}`
    case 'zone': return `告警区 ${sel.id}`
  }
}

export function RightColumn() {
  const s = useAppState()
  const store = useStore()
  const doc = s.scene.scenario.doc
  const sel = s.scene.editor.selection
  const measuring = s.scene.editor.measure.length === 2
  if (!doc) return <div className="group placeholder">载入场景后在这里编辑对象</div>
  const showForm = !!sel || measuring
  return (
    <>
      {showForm && (
        <div className="sel-bar" data-selection-bar>
          <span>{selLabel(sel, measuring)}</span>
          <span className="spacer" />
          <button type="button" className="mini" data-action="clear-selection"
                  onClick={() => {
                    store.dispatch({ type: 'scene/select', selection: null })
                    if (measuring) store.dispatch({ type: 'scene/measure', points: [] })
                  }}>返回卡片</button>
        </div>
      )}
      {showForm && <ObjectPanel />}
      <CardStack />
    </>
  )
}
