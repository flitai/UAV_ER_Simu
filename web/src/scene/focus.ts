// 场景页的「焦点目标」（13 报告 §13，D-062）：右栏焦点卡、地图上的全套叠加、探针三处共用同一条规则。
//
// 焦点 = 选中的辐射源（选中它的航点也算），没选中时取场景里的第一个辐射源。
// 站点或告警区被选中时焦点不变——那是在配置别的对象，不是在看别的目标。

import type { AppState } from '../state/types.js'
import { emitters, sites } from './editor/scenarioOps.js'

export function focusTargetId(s: AppState): string | null {
  const sel = s.scene.editor.selection
  if (sel && (sel.kind === 'emitter' || sel.kind === 'waypoint')) return sel.id
  const first = emitters(s.scene.scenario.doc)[0]
  return first ? String(first.id) : null
}

/**
 * 「焦点站」：视距探测算的就是这个站（07 报告 §9.3）。
 *
 * 规则与焦点目标对称——选中的站点优先，没选中取场景里的第一个站。
 * 选中辐射源或告警区时焦点站不变：那是在看别的对象，不是在换站。
 */
export function focusSiteId(s: AppState): string | null {
  const sel = s.scene.editor.selection
  if (sel && sel.kind === 'site') return sel.id
  const first = sites(s.scene.scenario.doc)[0]
  return first ? String(first.id) : null
}
