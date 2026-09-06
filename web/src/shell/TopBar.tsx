// 顶栏（09 §2、§3）：系统图标 | 面包屑「项目 › 试验 › 任务」| 运行组 | 视图切换 + 数据 + ⋯ | DEV 标记。
// 任务胶囊带两个正交徽标：运行态（图标）与结果四态（形状 + 文字 + 颜色）。

import { useAppState, useDispatch } from '../state/store.js'
import { ExperimentContext } from './ExperimentContext.js'
import { RunGroup } from './RunGroup.js'
import { ViewSwitch } from './ViewSwitch.js'
import { resultBadge, runStateGlyph } from './badges.js'

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="2.2" fill="currentColor" />
    </svg>
  )
}

export function TopBar() {
  const s = useAppState()
  const dispatch = useDispatch()
  const rg = runStateGlyph(s.task.runState)
  const rb = resultBadge(s.task.runState, s.task.result)
  const menu = s.ui.popover === 'menu'
  const about = s.ui.popover === 'about'
  return (
    <header className="topbar">
      <div className="popover-anchor">
        <button type="button" className="logo" title="关于" onClick={() => dispatch({ type: 'ui/popover', id: about ? null : 'about' })}><Logo /></button>
        {about && <div className="popover"><b>无人机电子信号侦察仿真系统</b><div className="muted">服务 {s.server.version ?? '—'} · 引擎 {s.server.engineAvailable === null ? '—' : s.server.engineAvailable ? '就绪' : '不可用'}</div></div>}
      </div>
      <nav className="crumbs" aria-label="试验上下文">
        <span className="pill project" data-crumb="project">{s.context.projectId}</span>
        <span className="chev">›</span>
        <ExperimentContext />
        <span className="chev">›</span>
        <span className="pill task" data-crumb="task" title={s.task.reasons.join('；') || rg.label}>
          <span className="task-id">{s.task.id ?? '无任务'}</span>
          <span className="badge run" data-run-state={s.task.runState ?? 'none'} title={rg.label}>{rg.glyph}</span>
          <span className={`badge result ${rb.tone}${rb.hollow ? ' hollow' : ''}`} data-result={s.task.result ?? 'none'}>{rb.glyph} {rb.text}{rb.suffix}</span>
          {s.task.holdoutRefs > 0 && <span className="badge note" title="使用了验收集片段">验收集</span>}
        </span>
      </nav>
      <RunGroup />
      <ViewSwitch />
      <div className="popover-anchor">
        <button type="button" className="more" title="更多" onClick={() => dispatch({ type: 'ui/popover', id: menu ? null : 'menu' })}>⋯</button>
        {menu && (
          <div className="popover menu">
            <div className="item disabled">模型目录（切片 ③）</div>
            <div className="item disabled">试验中心（阶段 2）</div>
            <div className="item" onClick={() => dispatch({ type: 'ui/popover', id: 'about' })}>关于</div>
          </div>
        )}
      </div>
      {s.ui.devMode && <span className="dev-mark" data-dev="mark" title="开发者模式：演示时请去掉 ?dev=1">DEV</span>}
    </header>
  )
}
