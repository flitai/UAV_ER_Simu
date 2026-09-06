import { useAppState, useDispatch } from '../state/store.js'
import type { View } from '../state/types.js'

const VIEWS: Array<{ id: View; label: string; key: string }> = [
  { id: 'scene', label: '场景', key: 'Alt+1' }, { id: 'diagram', label: '框图', key: 'Alt+2' }, { id: 'results', label: '结果', key: 'Alt+3' },
]

export function ViewSwitch() {
  const s = useAppState()
  const dispatch = useDispatch()
  return (
    <div className="view-switch">
      {VIEWS.map((v) => (
        <button key={v.id} type="button" className={s.ui.view === v.id ? 'on' : ''} data-view-btn={v.id} title={v.key}
          onClick={() => dispatch({ type: 'ui/navigate', view: v.id })}>{v.label}</button>
      ))}
      <button type="button" className={`data${s.ui.view === 'data' ? ' on' : ''}`} data-view-btn="data" title="Alt+4"
        onClick={() => dispatch({ type: 'ui/navigate', view: 'data' })}>数据</button>
    </div>
  )
}
