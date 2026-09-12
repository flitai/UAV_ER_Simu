// 手写 hash 路由（D-032；09 §4.1）：#/scene（默认）、#/diagram、
// #/results[/signal|/detections|/tasks]、#/data。
// 路由只表达「看哪个页面」，?aoi=、?scenario=（D-061：打开时载入指定场景，优先于最近任务的场景）与 ?dev=1 留在 location.search 里不动。
//
// `#/diagram` 是**典型链路视图**（C-7，D-051），也是框图页唯一的形态：
// 自由画布连同 `#/diagram/canvas` 这个子形态在 D-060 一并删掉。
// 旧地址 `#/diagram/canvas` 不做特殊处理，按 `#/diagram` 解——多出来的那一段直接忽略，
// 于是收藏夹里的旧链接仍然打得开框图页，不会掉到默认的场景页去。

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
