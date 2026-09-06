// 底部抽屉（09 §8）：收起 28 px / 展开 240 px；页签 日志 / 告警 / 数据流 / 资源，切片 ① 只有日志真做。

import { useCallback, useRef } from 'react'
import { useAppState, useDispatch } from '../state/store.js'
import { LogPanel } from './LogPanel.js'
import { StatusBar } from './StatusBar.js'
import { MIN_DRAWER } from './layout.js'
import type { DrawerTab } from '../state/types.js'

const TABS: Array<{ id: DrawerTab; label: string }> = [
  { id: 'log', label: '日志' }, { id: 'alerts', label: '告警' }, { id: 'flow', label: '数据流' }, { id: 'resources', label: '资源' },
]

export function Drawer() {
  const s = useAppState()
  const dispatch = useDispatch()
  const open = s.ui.drawer.open
  const h = open ? s.ui.layout.drawerH : 28
  const drag = useRef<{ y0: number; h0: number } | null>(null)
  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!open) return
    drag.current = { y0: e.clientY, h0: s.ui.layout.drawerH }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [open, s.ui.layout.drawerH])
  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    dispatch({ type: 'ui/layout', layout: { drawerH: Math.max(MIN_DRAWER, d.h0 - (e.clientY - d.y0)) } })
  }, [dispatch])
  const onUp = useCallback(() => { drag.current = null }, [])
  const alerts = s.task.reasons.length + (s.task.error ? 1 : 0)
  return (
    <section className={`drawer${open ? ' open' : ''}`} style={{ height: h }} data-drawer-open={open}>
      <div className="drawer-handle" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
      <div className="drawer-bar">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={open && s.ui.drawer.tab === t.id ? 'on' : ''} data-drawer-tab={t.id}
              onClick={() => dispatch({ type: 'ui/drawer', open: !(open && s.ui.drawer.tab === t.id), tab: t.id })}>
              {t.label}{t.id === 'alerts' && alerts > 0 && <span className="count">{alerts}</span>}
            </button>
          ))}
        </div>
        <StatusBar />
      </div>
      {open && (
        <div className="drawer-body">
          {s.ui.drawer.tab === 'log' && <LogPanel />}
          {s.ui.drawer.tab === 'alerts' && (
            <div className="alerts">
              {s.task.error && <div className="alert error">{s.task.error.code}：{s.task.error.message}{s.task.error.node_id && <code className="chip">{s.task.error.node_id}</code>}</div>}
              {s.task.reasons.map((r, i) => <div key={i} className="alert warn">{r}</div>)}
              {alerts === 0 && <div className="muted empty">没有任务级告警</div>}
            </div>
          )}
          {s.ui.drawer.tab === 'flow' && <div className="muted empty">数据流（切片 ② 启用）</div>}
          {s.ui.drawer.tab === 'resources' && <div className="muted empty">资源（切片 ② 启用）</div>}
        </div>
      )}
    </section>
  )
}
