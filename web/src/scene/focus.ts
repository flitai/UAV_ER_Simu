// 场景页的「焦点目标」（13 报告 §13，D-062）：右栏焦点卡、地图上的全套叠加、探针三处共用同一条规则。
//
// 焦点 = 选中的辐射源（选中它的航点也算），没选中时取场景里的第一个辐射源。
// 站点或告警区被选中时焦点不变——那是在配置别的对象，不是在看别的目标。

import type { AppState } from '../state/types.js'
import { emitters } from './editor/scenarioOps.js'

export function focusTargetId(s: AppState): string | null {
  const sel = s.scene.editor.selection
  if (sel && (sel.kind === 'emitter' || sel.kind === 'waypoint')) return sel.id
  const first = emitters(s.scene.scenario.doc)[0]
  return first ? String(first.id) : null
}
