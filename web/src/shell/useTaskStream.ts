// WebSocket 客户端的生命周期与 rAF 批量提交（09 附录 A.2）。单例持在 ref 里，订阅按 task.id 与 since 变化。

import { useEffect, useRef } from 'react'
import { getEvents } from '../api/client.js'
import { WsClient, wsUrl } from '../api/ws.js'
import {
  bearingFromPayload, entityFromPayload, linkFromPayload, positionFromPayload, sceneStore,
} from '../scene/sceneStore.js'
import { signalBuffer } from '../signal/buffer.js'
import { useAppState, useStore } from '../state/store.js'
import type { WsTextEvent } from '../state/types.js'

declare global {
  interface Window {
    __cuav?: {
      ws: { dropForTest: () => boolean; state: () => unknown }
      signal?: { zoomTo: (vp: { t0?: number; t1?: number; f0?: number; f1?: number }) => void; reset: () => void; csv: () => { name: string; text: string } | null }
      perf?: { reset: () => void }
      /** 当前框图的规范文本。端到端拿它与盘上字节逐字节对拍（`slice4-smoke`），
       *  也用来读节点参数——`__probe()` 的 diagram 只给计数，读不到参数（D-058 加）。 */
      diagramText?: () => string
      /** 渲染与物理同源的当场核对（D4，D-076）。**是命令不是探针**：它会触发建筑几何的懒加载，
       *  而 `__probe()` 必须保持无副作用（D4-3 的验收条件之一）。 */
      scene?: { sameSource: () => Promise<unknown> }
    }
  }
}

const MAX_PER_FLUSH = 400

export function useTaskStream(): void {
  const store = useStore()
  const s = useAppState()
  const clientRef = useRef<WsClient | null>(null)
  const pending = useRef<WsTextEvent[]>([])
  const raf = useRef<number | null>(null)

  if (!clientRef.current) {
    // 每帧最多折叠 MAX_PER_FLUSH 条：切片 ① 的 2447 条事件在 82 ms 内到齐，一次全折叠是一个 80 ms 的长任务（U-3 实测）
    const flush = () => {
      raf.current = null
      const evs = pending.current.splice(0, MAX_PER_FLUSH)
      const dev = store.getState().ui.devMode
      if (dev) performance.mark('cuav-flush-0')
      if (evs.length) store.dispatch({ type: 'stream/batch', events: evs, wallMs: performance.now() })
      if (dev) performance.measure('stream.flush', 'cuav-flush-0')
      if (pending.current.length) raf.current = requestAnimationFrame(flush)
    }
    clientRef.current = new WsClient({
      url: wsUrl(),
      fetchEvents: (id, since) => getEvents(id, since),
      onEvent: (ev) => {
        if (ev.type === 'subscribed') {
          store.dispatch({ type: 'ws/subscribed', last_seq: Number(ev.payload['last_seq'] ?? 0), run_state: ev.payload['run_state'] as never })
          return
        }
        // 实体与链路是高频量（10–100 Hz），走独立的小 store，不进主 store 的批量折叠（G-5）
        if (ev.type === 'entity') {
          const e = entityFromPayload(ev.t_s, ev.payload)
          if (e) sceneStore.pushEntity(e)
          return
        }
        if (ev.type === 'link') {
          const l = linkFromPayload(ev.t_s, ev.payload)
          if (l) sceneStore.pushLink(l)
          return
        }
        // 测向与定位同样是高频量（每站每源 10 Hz），走同一条旁路（D-053）
        if (ev.type === 'bearing') {
          const b = bearingFromPayload(ev.t_s, ev.payload)
          if (b) sceneStore.pushBearing(b)
          return
        }
        if (ev.type === 'position') {
          const p = positionFromPayload(ev.t_s, ev.payload)
          if (p) sceneStore.pushPosition(p)
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
    if (s.ui.devMode) window.__cuav = { ...(window.__cuav ?? {}), ws: { dropForTest: () => c.dropForTest(), state: () => ({ ...c.state }) } }
    else delete window.__cuav
    return () => { delete window.__cuav }
  }, [s.ui.devMode])

  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    clientRef.current?.close()
  }, [])
}
