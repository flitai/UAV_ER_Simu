// 日志页签（09 §8）：环形 2000 行、级别过滤、搜索、跟随末尾；每行带 seq 与逻辑时间。

import { useEffect, useRef } from 'react'
import { filterLog } from '../state/logRing.js'
import { useAppState, useDispatch } from '../state/store.js'

export function LogPanel() {
  const s = useAppState()
  const dispatch = useDispatch()
  const box = useRef<HTMLDivElement>(null)
  const lines = filterLog(s.log.ring, s.log.filter, s.log.query)
  useEffect(() => {
    if (s.log.followTail && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines.length, s.log.followTail])
  const onScroll = () => {
    const el = box.current
    if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 4
    if (atEnd !== s.log.followTail) dispatch({ type: 'log/followTail', on: atEnd })
  }
  return (
    <div className="log-panel">
      <div className="log-tools">
        <select value={s.log.filter} onChange={(e) => dispatch({ type: 'log/filter', filter: e.target.value as 'all' | 'warn' | 'error' })}>
          <option value="all">全部</option><option value="warn">告警及以上</option><option value="error">只看错误</option>
        </select>
        <input type="search" placeholder="搜索" value={s.log.query} onChange={(e) => dispatch({ type: 'log/query', query: e.target.value })} />
        <label><input type="checkbox" checked={s.log.followTail} onChange={(e) => dispatch({ type: 'log/followTail', on: e.target.checked })} /> 跟随末尾</label>
        <span className="muted">{lines.length} / {s.log.ring.length} 行</span>
      </div>
      <div className="log-lines" ref={box} onScroll={onScroll}>
        {lines.map((l) => (
          <div key={l.id} className="log-line" data-level={l.level} data-origin={l.origin}>
            <span className="seq">{l.seq || '—'}</span>
            <span className="t">{l.t_s.toFixed(3)}</span>
            <span className="lv">{l.level}</span>
            <span className="msg">{l.message}</span>
            {l.node_id && <code className="chip">{l.node_id}</code>}
            {l.port && <code className="chip">{l.port}</code>}
          </div>
        ))}
        {lines.length === 0 && <div className="muted empty">没有日志</div>}
      </div>
    </div>
  )
}
