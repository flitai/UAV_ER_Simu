// 地图工具条（09 §5.2 切片 ①）：「图层 ▾」弹层放山体阴影开关，开发者模式再加高度来源分色；「俯仰」切换平视。

import { useAppState, useDispatch } from '../state/store.js'

export interface MapToolbarProps {
  hill: boolean
  onHill: (on: boolean) => void
  bySrc: boolean
  onBySrc: (on: boolean) => void
  flat: boolean
  onFlat: () => void
}

export function MapToolbar(p: MapToolbarProps) {
  const s = useAppState()
  const dispatch = useDispatch()
  const open = s.ui.popover === 'layers'
  return (
    <div className="map-toolbar">
      <div className="popover-anchor">
        <button type="button" className={open ? 'on' : ''} onClick={() => dispatch({ type: 'ui/popover', id: open ? null : 'layers' })}>图层 ▾</button>
        {open && (
          <div className="popover">
            <label><input type="checkbox" checked={p.hill} onChange={(e) => p.onHill(e.target.checked)} /> 山体阴影</label>
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
