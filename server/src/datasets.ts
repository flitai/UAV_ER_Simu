// 实测数据清单的只读列表（D-056）。
//
// 框图里对实测数据的引用只写 data_id（D-037），浏览器永不见服务器路径；但用户总得有办法
// **知道有哪些片段可选**。此前没有任何接口把清单给出去，回放模式只能手敲标识
// （2026-09-09 用户实测撞到）。这里补上，只读、只出摘要，不出任何路径。
//
// 「数据中心」整页是 U-4 的活，这里只做辐射源卡片挑片段所需的最小集。

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataEntry, DataIndex } from './tasks/resolve.js'

/** 一个机型下最多列几条。4714 条全给出去没有意义，演示挑的是机型不是某一片 */
const PER_GROUP = 12
const MAX_ITEMS = 400

export interface DatasetsDeps {
  index: DataIndex
}

interface Row {
  data_id: string
  kind: string
  batch: string
  holdout: boolean
  class_name?: string
  visibility?: string
  distance_text?: string
  split?: string
  center_frequency_Hz?: number
  sample_count?: number
  quality?: string
}

function toRow(e: DataEntry, holdout: boolean): Row {
  // 只出摘要，**不出 manifestRel**：那是服务器路径（D-037、04 §8.6）
  return { data_id: e.data_id, kind: e.kind, batch: e.batch, holdout, ...e.label }
}

function matches(e: DataEntry, q: string): boolean {
  if (!q) return true
  const hay = `${e.data_id} ${e.batch} ${e.label.class_name ?? ''} ${e.label.visibility ?? ''} `
    + `${e.label.distance_text ?? ''} ${e.label.split ?? ''}`
  return hay.toLowerCase().includes(q)
}

/**
 * `GET /api/v1/datasets?q=&data_id=`
 *
 * 缺省按机型分组、每组最多 `PER_GROUP` 条——挑片段挑的是机型，不是某一片；
 * 全量 4714 条塞进一个下拉既慢又没用。`total` 与 `matched` 如实给出，
 * 界面因此能说清「共多少、列了多少」，不假装列全了。
 *
 * `data_id` 精确查一条：框图里已经填着的那个可能不在分组抽样里，
 * 界面要能把它显示出来，不能因为没列到就当它不存在（铁律 15）。
 */
export async function handleDatasetRoutes(
  deps: DatasetsDeps, req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/datasets') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return true
  }
  await deps.index.ensureLoaded()
  const all = deps.index.all()

  const exact = (url.searchParams.get('data_id') ?? '').trim()
  if (exact) {
    const hit = deps.index.get(exact)
    const body = {
      schema_version: 'cuav-datasets/1',
      total: all.length,
      matched: hit ? 1 : 0,
      truncated: false,
      items: hit ? [toRow(hit, deps.index.isHoldout(hit.data_id))] : [],
    }
    return sendJson(res, 200, body)
  }

  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const hits = all.filter((e) => matches(e, q))

  // 按机型分组抽样，组内保持 data_id 序，取前 PER_GROUP 条
  const groups = new Map<string, DataEntry[]>()
  for (const e of hits) {
    const key = e.label.class_name ?? `（${e.batch}）`
    const g = groups.get(key)
    if (g) { if (g.length < PER_GROUP) g.push(e) } else groups.set(key, [e])
  }
  const items: Row[] = []
  for (const [, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const e of g) {
      if (items.length >= MAX_ITEMS) break
      items.push(toRow(e, deps.index.isHoldout(e.data_id)))
    }
  }
  return sendJson(res, 200, {
    schema_version: 'cuav-datasets/1',
    total: all.length,
    matched: hits.length,
    truncated: items.length < hits.length,
    items,
  })
}

function sendJson(res: ServerResponse, code: number, body: unknown): boolean {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
  return true
}
