// 面包屑里的「试验」胶囊（09 §3.1）：场景 + 框图 + 种子 + 模式；任一未保存标 ●；点开是试验详情。

import { useAppState, useDispatch } from '../state/store.js'

export function ExperimentContext() {
  const s = useAppState()
  const dispatch = useDispatch()
  const open = s.ui.popover === 'experiment'
  const dirty = s.scene.dirty || s.diagram.dirty
  const name = (s.diagram.json?.['name'] as string | undefined) ?? s.context.diagramId ?? '未命名试验'
  const title = dirty ? (s.diagram.dirty && s.scene.dirty ? '场景与框图未保存' : s.diagram.dirty ? '框图未保存' : '场景未保存') : name
  return (
    <div className="popover-anchor">
      <button type="button" className={`pill${open ? ' on' : ''}`} title={title} data-crumb="experiment"
        onClick={() => dispatch({ type: 'ui/popover', id: open ? null : 'experiment' })}>
        {name}{dirty && <span className="dirty" aria-label="未保存">●</span>}
      </button>
      {open && (
        <div className="popover experiment">
          <table>
            <tbody>
              <tr><td>场景</td><td>{s.context.scenarioId ?? (s.scene.summary ? `${s.scene.summary.name}（未绑定场景对象）` : '无场景')}</td></tr>
              <tr><td>框图</td><td>{s.context.diagramId ?? '—'}</td></tr>
              <tr><td>种子</td><td>{s.context.seed ?? '—'}</td></tr>
              <tr><td>模式</td><td>
                <select value={s.context.mode} onChange={(e) => dispatch({ type: 'context/mode', mode: e.target.value as 'M2+M3' | 'M1+M2' })}>
                  <option value="M2+M3">算法验证（M2+M3）</option>
                  <option value="M1+M2">工程分析（M1+M2）</option>
                </select>
              </td></tr>
              <tr><td>参数版本</td><td>{s.context.parameterVersion ?? '—'}</td></tr>
              <tr><td>M3 触发单元</td><td>整段（首期）</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
