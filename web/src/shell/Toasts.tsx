// 右上角非阻塞提示（09 §8）：5 s 自动消失，失败类常驻；不用于进度。

import { useEffect } from 'react'
import { useAppState, useDispatch } from '../state/store.js'

function Toast({ id, kind, text, sticky }: { id: number; kind: string; text: string; sticky: boolean }) {
  const dispatch = useDispatch()
  useEffect(() => {
    if (sticky) return
    const t = setTimeout(() => dispatch({ type: 'ui/toastDismiss', id }), 5000)
    return () => clearTimeout(t)
  }, [id, sticky, dispatch])
  return (
    <div className={`toast ${kind}`} role="status">
      <span>{text}</span>
      <button type="button" aria-label="关闭" onClick={() => dispatch({ type: 'ui/toastDismiss', id })}>×</button>
    </div>
  )
}

export function Toasts() {
  const s = useAppState()
  return (
    <div className="toasts" aria-live="polite">
      {s.ui.toasts.map((t) => <Toast key={t.id} id={t.id} kind={t.kind} text={t.text} sticky={t.sticky} />)}
    </div>
  )
}
