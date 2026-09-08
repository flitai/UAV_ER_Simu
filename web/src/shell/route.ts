// 手写 hash 路由（D-032；09 §4.1）：#/scene（默认）、#/diagram[/canvas]、
// #/results[/signal|/detections|/tasks]、#/data。
// 路由只表达「看哪个页面」，?aoi= 与 ?dev=1 留在 location.search 里不动。
//
// `#/diagram` 是**典型链路视图**（C-7，D-051），`#/diagram/canvas` 是降为高级模式的自由画布。
// 两者共用同一份框图文档，只是编辑方式不同，所以是同一个 view 加一个子形态而不是两个 view
// ——三视图切换（Alt+1/2/3）仍然只有三个去处。

import type { ResultsTab, View } from '../state/types.js'

export interface Route { view: View; resultsTab: ResultsTab; canvas: boolean }

const TABS: ResultsTab[] = ['signal', 'detections', 'tasks']

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const head = parts[0] ?? ''
  if (head === 'diagram') return { view: 'diagram', resultsTab: 'signal', canvas: parts[1] === 'canvas' }
  if (head === 'data') return { view: 'data', resultsTab: 'signal', canvas: false }
  if (head === 'results') {
    const tab = parts[1] as ResultsTab | undefined
    return { view: 'results', resultsTab: tab && TABS.includes(tab) ? tab : 'signal', canvas: false }
  }
  return { view: 'scene', resultsTab: 'signal', canvas: false }
}

export function formatHash(r: Route): string {
  if (r.view === 'results') return r.resultsTab === 'signal' ? '#/results' : `#/results/${r.resultsTab}`
  if (r.view === 'diagram' && r.canvas) return '#/diagram/canvas'
  return `#/${r.view}`
}
