import { useEffect } from 'react'
import { useStore } from '../state/store.js'
import { mapHotkey } from './hotkeys.js'
import { runDiagram } from './actions.js'

export function useHotkeys(): void {
  const store = useStore()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = mapHotkey(e)
      if (!k) return
      if (k !== 'escape') e.preventDefault()
      const { dispatch } = store
      switch (k) {
        case 'view:scene': dispatch({ type: 'ui/navigate', view: 'scene' }); break
        case 'view:diagram': dispatch({ type: 'ui/navigate', view: 'diagram' }); break
        case 'view:results': dispatch({ type: 'ui/navigate', view: 'results' }); break
        case 'view:data': dispatch({ type: 'ui/navigate', view: 'data' }); break
        case 'save': dispatch({ type: 'diagram/markSaved' }); dispatch({ type: 'ui/toast', kind: 'info', text: '已保存（首期只保存在本页）' }); break
        case 'run': void runDiagram(store); break
        case 'escape': dispatch({ type: 'ui/popover', id: null }); break
        case 'drawer': dispatch({ type: 'ui/drawer', open: !store.getState().ui.drawer.open }); break
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [store])
}
