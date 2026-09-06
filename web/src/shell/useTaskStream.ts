// WebSocket 客户端的生命周期与 rAF 批量提交（09 附录 A.2）。单例持在 ref 里，订阅按 task.id 与 since 变化。

import { useEffect, useRef } from 'react'
import { getEvents } from '../api/client.js'
import { WsClient, wsUrl } from '../api/ws.js'
import { signalBuffer } from '../signal/buffer.js'
import { useAppState, useStore } from '../state/store.js'
import type { WsTextEvent } from '../state/types.js'

declare global {
  interface Window { __cuav?: { ws: { dropForTest: () => boolean; state: () => unknown } } }
}

export function useTaskStream(): void {
  const store = useStore()
  const s = useAppState()
  const clientRef = useRef<WsClient | null>(null)
  const pending = useRef<WsTextEvent[]>([])
  const raf = useRef<number | null>(null)

  if (!clientRef.current) {
    const flush = () => {
      raf.current = null
      const evs = pending.current
      pending.current = []
      if (evs.length) store.dispatch({ type: 'stream/batch', events: evs, wallMs: performance.now() })
    }
    clientRef.current = new WsClient({
      url: wsUrl(),
      fetchEvents: (id, since) => getEvents(id, since),
      onEvent: (ev) => {
        if (ev.type === 'subscribed') {
          store.dispatch({ type: 'ws/subscribed', last_seq: Number(ev.payload['last_seq'] ?? 0), run_state: ev.payload['run_state'] as never })
          return
        }
        pending.current.push(ev)
        if (raf.current === null) raf.current = requestAnimationFrame(flush)
      },
      onRow: (h, data) => signalBuffer.push(h, data),
      onStatus: (ws) => store.dispatch({ type: 'ws/status', ws }),
      onClientLog: (level, message) => store.dispatch({ type: 'log/client', level, message }),
    })
  }

  const taskId = s.task.id
  const since = s.task.subscribeSince
  useEffect(() => {
    const c = clientRef.current!
    if (taskId) c.subscribe(taskId, since)
    else c.close()
  }, [taskId, since])

  useEffect(() => {
    const c = clientRef.current!
    if (s.ui.devMode) window.__cuav = { ws: { dropForTest: () => c.dropForTest(), state: () => ({ ...c.state }) } }
    else delete window.__cuav
    return () => { delete window.__cuav }
  }, [s.ui.devMode])

  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    clientRef.current?.close()
  }, [])
}
