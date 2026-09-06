// 三栏框架（09 §4.4）：左 280 / 最小 220、中 flex、右 320 / 最小 260；可拖、可收起。
// 收起时栏体仍挂载（hidden），DOM 里的文字照旧可查（e2e 依赖侧栏 h1）。

import { useCallback, useRef, type ReactNode } from 'react'
import { useAppState, useDispatch } from '../state/store.js'
import { MIN_LEFT, MIN_RIGHT } from './layout.js'

export function ColumnLayout({ left, center, right }: { left: ReactNode; center: ReactNode; right: ReactNode }) {
  const s = useAppState()
  const dispatch = useDispatch()
  const { leftW, rightW } = s.ui.layout
  const drag = useRef<{ side: 'left' | 'right'; x0: number; w0: number } | null>(null)

  const onDown = useCallback((side: 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { side, x0: e.clientX, w0: side === 'left' ? leftW : rightW }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [leftW, rightW])
  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x0
    const w = d.side === 'left' ? Math.max(MIN_LEFT, d.w0 + dx) : Math.max(MIN_RIGHT, d.w0 - dx)
    dispatch({ type: 'ui/layout', layout: d.side === 'left' ? { leftW: w } : { rightW: w } })
  }, [dispatch])
  const onUp = useCallback(() => { drag.current = null }, [])

  const lc = s.ui.leftCollapsed
  const rc = s.ui.rightCollapsed
  return (
    <div className="cols" style={{ gridTemplateColumns: `${lc ? 24 : leftW}px 4px 1fr 4px ${rc ? 24 : rightW}px` }}>
      <aside className={`col left${lc ? ' collapsed' : ''}`}>
        <button type="button" className="rail" title={lc ? '展开左栏' : '收起左栏'} onClick={() => dispatch({ type: 'ui/collapse', side: 'left', collapsed: !lc })}>{lc ? '›' : '‹'}</button>
        <div className="col-body" hidden={lc}>{left}</div>
      </aside>
      <div className="gutter" onPointerDown={onDown('left')} onPointerMove={onMove} onPointerUp={onUp} />
      <main className="col center">{center}</main>
      <div className="gutter" onPointerDown={onDown('right')} onPointerMove={onMove} onPointerUp={onUp} />
      <aside className={`col right${rc ? ' collapsed' : ''}`}>
        <button type="button" className="rail" title={rc ? '展开右栏' : '收起右栏'} onClick={() => dispatch({ type: 'ui/collapse', side: 'right', collapsed: !rc })}>{rc ? '‹' : '›'}</button>
        <div className="col-body" hidden={rc}>{right}</div>
      </aside>
    </div>
  )
}
