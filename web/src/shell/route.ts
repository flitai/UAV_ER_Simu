// 手写 hash 路由（D-032；09 §4.1）：#/scene（默认）、#/diagram、#/results[/signal|/detections|/tasks]、#/data。
// 路由只表达「看哪个页面」，?aoi= 与 ?dev=1 留在 location.search 里不动。

import type { ResultsTab, View } from '../state/types.js'

export interface Route { view: View; resultsTab: ResultsTab }

const TABS: ResultsTab[] = ['signal', 'detections', 'tasks']

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const head = parts[0] ?? ''
  if (head === 'diagram') return { view: 'diagram', resultsTab: 'signal' }
  if (head === 'data') return { view: 'data', resultsTab: 'signal' }
  if (head === 'results') {
    const tab = parts[1] as ResultsTab | undefined
    return { view: 'results', resultsTab: tab && TABS.includes(tab) ? tab : 'signal' }
  }
  return { view: 'scene', resultsTab: 'signal' }
}

export function formatHash(r: Route): string {
  if (r.view === 'results') return r.resultsTab === 'signal' ? '#/results' : `#/results/${r.resultsTab}`
  return `#/${r.view}`
}
