// 场景选择（2026-09-13 用户定：场景在场景页选，框图页与结果页跟着走，D-065）。
//
// 2026-09-27 由左栏挪到顶栏（用户：「不要隐藏在左侧，直接放在上面的空白栏中，靠在右侧的按钮附近」）：
// 场景页的顶栏不放试验面包屑（那是框图页与结果页的事），右侧运行按钮前正好空着。
// **仍然只在场景页出现**——同一件事一个入口（D-057 / D-065），框图页只读写出当前场景。
// 换场景即载入那份文件；有未保存的改动先问一句，不静默丢。链路侧由 ChainView 的 useSceneSync 跟随。

import { useAppState, useStore } from '../state/store.js'
import { loadScenarioInto } from '../shell/actions.js'

export function ScenarioPick() {
  const s = useAppState()
  const store = useStore()
  const sc = s.scene.scenario
  const cur = sc.id ?? ''
  const err = sc.status === 'error' ? sc.error : null
  return (
    <label className="scene-pick-top" data-form="scene-pick" title={err ?? undefined}>
      <span className="scene-pick-label">场景</span>
      <select data-field="scenario" value={cur} disabled={sc.status === 'loading'}
        className={err ? 'bad' : undefined}
        onChange={(e) => {
          const id = e.target.value
          if (!id || id === cur) return
          if (s.scene.dirty && !window.confirm('当前场景有未保存的改动，切换会丢弃这些改动。继续？')) {
            e.target.value = cur
            return
          }
          void loadScenarioInto(store, id, () => true)
        }}>
        {!cur && <option value="">（未选）</option>}
        {sc.list.map((x) => (
          <option key={x.scenario_id} value={x.scenario_id}>
            {x.scenario_id}{x.name ? ` · ${x.name}` : ''}{x.readonly ? '（基准 · 只读）' : ''}
          </option>
        ))}
      </select>
      {err && <span className="scene-pick-err" data-scene-pick-error>{err}</span>}
    </label>
  )
}
