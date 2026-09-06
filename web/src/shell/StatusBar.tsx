// 状态条（09 §8）：鼠标经纬度 | 坐标与时间基准 | WS 状态（点击展开日志）。

import { useSyncExternalStore } from 'react'
import { timeBasis, wsStatusText } from '../state/selectors.js'
import { useAppState, useDispatch } from '../state/store.js'
import { cursorStore } from './cursorStore.js'
import { fmtLngLat } from './format.js'

export function StatusBar() {
  const s = useAppState()
  const dispatch = useDispatch()
  const cur = useSyncExternalStore(cursorStore.subscribe, cursorStore.get, cursorStore.get)
  const tb = timeBasis(s)
  return (
    <div className="statusbar">
      <span className="cell cursor">
        {cur ? (cur.insideAoi ? fmtLngLat(cur.lng, cur.lat) : `${fmtLngLat(cur.lng, cur.lat)} · AOI 外`) : '—'}
      </span>
      <span className="cell basis" data-basis={tb.attr} title="坐标基准 · 高程基准 · 时间基准（铁律 1、2、3）">{tb.text}</span>
      <button type="button" className={`cell ws ${s.ws.status}`} data-ws-status={s.ws.status} title="点击查看日志"
        onClick={() => dispatch({ type: 'ui/drawer', open: true, tab: 'log' })}>{wsStatusText(s.ws)}</button>
    </div>
  )
}
