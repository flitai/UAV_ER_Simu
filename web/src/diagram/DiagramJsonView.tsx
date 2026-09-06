// 框图视图的切片 ① 过渡形态（09 §6）：示例下拉 + JSON 编辑框 + 错误列表（每条带 node_id 与 port）。
// 左右栏容器保留，内容为「切片 ③ 启用」；React Flow 画布是 U-2。

import { ColumnLayout } from '../shell/ColumnLayout.js'
import { useAppState, useDispatch } from '../state/store.js'
import { EXAMPLES } from './examples/index.js'

export function DiagramJsonView() {
  const s = useAppState()
  const dispatch = useDispatch()
  const errors = s.diagram.validation && !s.diagram.validation.ok ? s.diagram.validation.errors : []
  return (
    <ColumnLayout
      left={<div className="group placeholder">组件库（切片 ③ 启用）</div>}
      center={
        <div className="diagram-json">
          <div className="diagram-tools">
            <label>示例框图
              <select data-action="example" value="" onChange={(e) => { const ex = EXAMPLES.find((x) => x.id === e.target.value); if (ex) dispatch({ type: 'diagram/loadExample', text: ex.text }) }}>
                <option value="">选择…</option>
                {EXAMPLES.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
              </select>
            </label>
            <span className="muted">{s.context.diagramId ?? '未命名'}{s.diagram.dirty ? ' ●' : ''}</span>
            <span className="muted right">Ctrl+Enter 校验并运行</span>
          </div>
          <textarea className="diagram-text" spellCheck={false} value={s.diagram.text} data-diagram-text
            onChange={(e) => dispatch({ type: 'diagram/setText', text: e.target.value })} />
          <ol className="diagram-errors" data-diagram-errors>
            {s.diagram.parseError && <li className="error"><b>json_parse</b> {s.diagram.parseError}</li>}
            {errors.map((e, i) => (
              <li key={i} className="error">
                <code className="chip">{e.node_id || '—'}</code><code className="chip">{e.port || '—'}</code>
                <b>{e.code}</b> {e.message}
              </li>
            ))}
            {s.diagram.validation?.ok && <li className="ok">校验通过，已提交</li>}
          </ol>
        </div>
      }
      right={<div className="group placeholder">参数面板（切片 ③ 启用）</div>}
    />
  )
}
