// 地图工具条（09 §5.2）：选择 / 布站 / 航点 / 测量 四个工具、撤销重做、图层弹层、俯仰切换。
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
  onSituation: (on: boolean) => void
  onSave: () => void
  saving: boolean
}

const TOOLS: Array<{ id: SceneTool; label: string; hint: string }> = [
  { id: 'select', label: '选择', hint: '点击选中，拖动站点或航点移动它' },
  { id: 'site', label: '布站', hint: '点击地图放一个站点，放完回到选择' },
  { id: 'emitter', label: '布目标', hint: '点击地图放一个辐射源（复制第一个源的发射参数），放完回到选择' },
  { id: 'waypoint', label: '航点', hint: '先在左栏选中辐射源，然后连续点击添加航点；双击或 Esc 结束' },
  { id: 'measure', label: '测量', hint: '两点之间的距离与真北顺时针方位' },
  { id: 'zone', label: '布告警区', hint: '点击地图放一个圆形告警区（缺省半径 500 m），半径、限高与类别在右栏改' },
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
      <div className="tool-group">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" title={t.hint} data-tool={t.id}
                  className={tool === t.id ? 'on' : ''}
                  disabled={!canEdit && t.id !== 'measure'}
                  onClick={() => dispatch({ type: 'scene/tool', tool: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="tool-group">
        <button type="button" title="撤销" data-act="undo" disabled={!undo.past.length}
                onClick={() => dispatch({ type: 'scene/undo' })}>↶</button>
        <button type="button" title="重做" data-act="redo" disabled={!undo.future.length}
                onClick={() => dispatch({ type: 'scene/redo' })}>↷</button>
        <button type="button" data-act="save-scenario" disabled={!s.scene.dirty || p.saving}
                onClick={p.onSave}>{p.saving ? '保存中…' : '保存场景'}</button>
      </div>
      <div className="popover-anchor">
        <button type="button" className={open ? 'on' : ''} onClick={() => dispatch({ type: 'ui/popover', id: open ? null : 'layers' })}>图层 ▾</button>
        {open && (
          <div className="popover">
            <label><input type="checkbox" checked={p.hill} onChange={(e) => p.onHill(e.target.checked)} /> 山体阴影</label>
            <label><input type="checkbox" checked={p.situation} onChange={(e) => p.onSituation(e.target.checked)} /> 站点、航线、目标与链路</label>
            <label data-layer="fix"><input type="checkbox" checked={p.fix} onChange={(e) => p.onFix(e.target.checked)} /> 测向线与定位椭圆</label>
            <label data-layer="zones"><input type="checkbox" checked={p.zonesOn} onChange={(e) => p.onZones(e.target.checked)} /> 告警区</label>
            <label data-layer="poles"><input type="checkbox" checked={p.poles} onChange={(e) => p.onPoles(e.target.checked)} /> 高度立柱</label>
            {s.ui.devMode && (
              <label data-dev="color-by-src"><input type="checkbox" checked={p.bySrc} onChange={(e) => p.onBySrc(e.target.checked)} /> 按高度来源分色（DEV）</label>
            )}
          </div>
        )}
      </div>
      <button type="button" onClick={p.onFlat}>{p.flat ? '俯视' : '平视'}</button>
    </div>
  )
}
