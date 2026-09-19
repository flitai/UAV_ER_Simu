// 地图工具条（09 §5.2；13 报告 §13，D-062 分组）：观察组常驻（图层、俯仰、测量），
// 编辑组（选择 / 布站 / 布目标 / 航点 / 布告警区、撤销重做）收在「编辑场景」开关后面；「保存场景」常驻。
//
// 图层开关统一在这里，不在左栏重复一份（09 §5.1「去重」）。
// 开发者模式才有的「按高度来源分色」留在弹层里（D-042b：界面不解释估算高度）。

import { useAppState, useDispatch } from '../state/store.js'
import type { SceneTool } from '../state/types.js'

export interface MapToolbarProps {
  hill: boolean
  onHill: (on: boolean) => void
  bySrc: boolean
  onBySrc: (on: boolean) => void
  flat: boolean
  onFlat: () => void
  situation: boolean
  /** 测向线与定位椭圆（D-053）。与态势图层分开：它们的生产者是测向与定位节点，
   *  没跑过带测向的任务时图上本来就是空的，开关仍在，关掉即整层不画 */
  fix: boolean
  onFix: (v: boolean) => void
  /** 告警区与高度立柱（D-061） */
  zonesOn: boolean
  onZones: (v: boolean) => void
  poles: boolean
  onPoles: (v: boolean) => void
  /** 全部目标叠加（D-062）：关着时只有焦点目标画全套（测向色带、椭圆、距离标注），其余目标只画图标、航迹与细链路线 */
  allOverlays: boolean
  onAllOverlays: (v: boolean) => void
  onSituation: (on: boolean) => void
  /** 编辑模式（D-062）：开着才有布站等编辑工具与拖动 */
  editMode: boolean
  onEditMode: (on: boolean) => void
  onSave: () => void
  saving: boolean
}

const EDIT_TOOLS: Array<{ id: SceneTool; label: string; hint: string }> = [
  { id: 'select', label: '选择', hint: '点击选中，拖动站点或航点移动它' },
  { id: 'site', label: '布站', hint: '点击地图放一个站点，放完回到选择' },
  { id: 'emitter', label: '布目标', hint: '点击地图放一个辐射源（复制第一个源的发射参数），放完回到选择' },
  { id: 'waypoint', label: '航点', hint: '先选中辐射源，然后连续点击添加航点；双击或 Esc 结束' },
  { id: 'zone', label: '布告警区', hint: '点击地图放一个圆形告警区（缺省半径 500 m），半径、限高与类别在左栏改' },
]

export function MapToolbar(p: MapToolbarProps) {
  const s = useAppState()
  const dispatch = useDispatch()
  const open = s.ui.popover === 'layers'
  const tool = s.scene.editor.tool
  const canEdit = s.scene.scenario.doc !== null
  const undo = s.scene.undo

  return (
    <div className="map-toolbar">
      <div className="tool-group" data-tool-group="observe">
        <div className="popover-anchor">
          <button type="button" className={open ? 'on' : ''} onClick={() => dispatch({ type: 'ui/popover', id: open ? null : 'layers' })}>图层 ▾</button>
          {open && (
            <div className="popover">
              <label><input type="checkbox" checked={p.hill} onChange={(e) => p.onHill(e.target.checked)} /> 山体阴影</label>
              <label><input type="checkbox" checked={p.situation} onChange={(e) => p.onSituation(e.target.checked)} /> 站点、航线、目标与链路</label>
              <label data-layer="fix"><input type="checkbox" checked={p.fix} onChange={(e) => p.onFix(e.target.checked)} /> 测向线与定位椭圆</label>
              <label data-layer="zones"><input type="checkbox" checked={p.zonesOn} onChange={(e) => p.onZones(e.target.checked)} /> 告警区</label>
              <label data-layer="poles"><input type="checkbox" checked={p.poles} onChange={(e) => p.onPoles(e.target.checked)} /> 高度立柱</label>
              <label data-layer="all-overlays"><input type="checkbox" checked={p.allOverlays} onChange={(e) => p.onAllOverlays(e.target.checked)} /> 全部目标叠加</label>
              {s.ui.devMode && (
                <label data-dev="color-by-src"><input type="checkbox" checked={p.bySrc} onChange={(e) => p.onBySrc(e.target.checked)} /> 按高度来源分色（DEV）</label>
              )}
            </div>
          )}
        </div>
        <button type="button" onClick={p.onFlat}>{p.flat ? '俯视' : '平视'}</button>
        <button type="button" title="两点之间的距离与真北顺时针方位" data-tool="measure"
                className={tool === 'measure' ? 'on' : ''}
                onClick={() => dispatch({ type: 'scene/tool', tool: tool === 'measure' ? 'select' : 'measure' })}>测量</button>
        {/* 视距探测（D3-7）：点地图任一点，对焦点站算视距与刀口绕射损耗。观察工具，不在编辑组里。 */}
        <button type="button" title="点地图任一点，对焦点站算视距与刀口绕射损耗（假设目标在那一点上，高度可在右栏改）"
                data-tool="los" className={tool === 'los' ? 'on' : ''}
                onClick={() => dispatch({ type: 'scene/tool', tool: tool === 'los' ? 'select' : 'los' })}>视距</button>
      </div>
      <div className="tool-group" data-tool-group="edit">
        <button type="button" data-act="edit-mode" className={p.editMode ? 'on' : ''} disabled={!canEdit}
                title={p.editMode ? '结束编辑：收起编辑工具' : '编辑场景：布站、布目标、画航点、布告警区、拖动对象'}
                onClick={() => p.onEditMode(!p.editMode)}>{p.editMode ? '结束编辑' : '编辑场景'}</button>
        {p.editMode && EDIT_TOOLS.map((t) => (
          <button key={t.id} type="button" title={t.hint} data-tool={t.id}
                  className={tool === t.id ? 'on' : ''}
                  onClick={() => dispatch({ type: 'scene/tool', tool: t.id })}>
            {t.label}
          </button>
        ))}
        {/* 正在给谁画。用户 2026-09-19 的原话是「画航点时要和当前选中的目标相关联，
            不能和不同的目标画串了」——串不串是一回事，**看不看得出来**是另一回事，
            以前这里一个字都没有。 */}
        {p.editMode && tool === 'waypoint' && (
          <span className="tool-note" data-route-for={s.scene.editor.routeFor ?? ''}>
            正在给 <b>{s.scene.editor.routeFor ?? '—'}</b> 画航点 · 双击或 Esc 结束
          </span>
        )}
        {p.editMode && (
          <>
            <button type="button" title="撤销" data-act="undo" disabled={!undo.past.length}
                    onClick={() => dispatch({ type: 'scene/undo' })}>↶</button>
            <button type="button" title="重做" data-act="redo" disabled={!undo.future.length}
                    onClick={() => dispatch({ type: 'scene/redo' })}>↷</button>
          </>
        )}
      </div>
      <button type="button" data-act="save-scenario" disabled={!s.scene.dirty || p.saving}
              onClick={p.onSave}>{p.saving ? '保存中…' : '保存场景'}</button>
    </div>
  )
}
