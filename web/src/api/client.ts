// REST 客户端（docs/api-versions.md §3.1、§3.1a、§3.1b）。HTTP 状态走判别联合，只有网络失败才抛。

import type { DiagramError, ProductIndex, TaskRecord, WsTextEvent } from '../state/types.js'
import type { SpectrumRequest } from '../signal/viewport.js'
import { checkWindowBody, envelopeQueryString, parseRetryAfterMs, parseSuggest, parseWindowHeaders, spectrumQueryString, type WindowMeta } from './window.js'

export interface Health { status: string; service: string; version: string; engine?: { available: boolean; version?: string } }

async function json<T>(r: Response): Promise<T> { return (await r.json()) as T }

export async function getHealth(base = ''): Promise<Health> {
  const r = await fetch(`${base}/api/v1/health`)
  if (!r.ok) throw new Error(`health HTTP ${r.status}`)
  return json<Health>(r)
}

export async function getComponents(base = ''): Promise<{ ok: true; catalog: unknown } | { ok: false; status: number }> {
  const r = await fetch(`${base}/api/v1/components`)
  if (!r.ok) return { ok: false, status: r.status }
  return { ok: true, catalog: await r.json() }
}

export async function listTasks(limit = 1, base = ''): Promise<TaskRecord[]> {
  const r = await fetch(`${base}/api/v1/tasks?limit=${limit}`)
  if (!r.ok) throw new Error(`tasks HTTP ${r.status}`)
  return (await json<{ tasks: TaskRecord[] }>(r)).tasks
}

export async function getTask(id: string, base = ''): Promise<TaskRecord | null> {
  const r = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(id)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`task HTTP ${r.status}`)
  return json<TaskRecord>(r)
}

export type CreateTaskResult =
  | { status: 201 | 200; record: TaskRecord }
  | { status: 400; error: DiagramError }
  | { status: number; message: string }

export async function createTask(text: string, key: string, base = ''): Promise<CreateTaskResult> {
  const r = await fetch(`${base}/api/v1/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: text,
  })
  if (r.status === 201 || r.status === 200) return { status: r.status, record: await json<TaskRecord>(r) }
  let body: Record<string, unknown> = {}
  try { body = await json<Record<string, unknown>>(r) } catch { /* 非 JSON 错误体 */ }
  if (r.status === 400) {
    const d = (body['detail'] ?? body) as Record<string, unknown>
    return {
      status: 400,
      error: { code: String(d['code'] ?? body['error'] ?? 'bad_request'), node_id: String(d['node_id'] ?? ''), port: String(d['port'] ?? ''), message: String(d['message'] ?? body['message'] ?? '') },
    }
  }
  return { status: r.status, message: String(body['message'] ?? body['error'] ?? `HTTP ${r.status}`) }
}

export async function cancelTask(id: string, base = ''): Promise<{ status: 200; record: TaskRecord } | { status: number; message: string }> {
  const r = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  if (r.ok) return { status: 200, record: await json<TaskRecord>(r) }
  let body: Record<string, unknown> = {}
  try { body = await json<Record<string, unknown>>(r) } catch { /* 忽略 */ }
  return { status: r.status, message: String(body['message'] ?? body['error'] ?? `HTTP ${r.status}`) }
}

export interface EventsPage { task_id: string; since: number; events: WsTextEvent[]; last_seq: number; run_state: string }

export async function getEvents(id: string, since: number, limit = 1000, base = ''): Promise<EventsPage> {
  const r = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(id)}/events?since=${since}&limit=${limit}`)
  if (!r.ok) throw new Error(`events HTTP ${r.status}`)
  return json<EventsPage>(r)
}

export type IndexResult = { status: 200; index: ProductIndex } | { status: 409; retryAfterMs: number } | { status: 404 } | { status: number; message: string }

export async function getProductIndex(task: string, op: string, kind: 'spectrum' | 'envelope', base = ''): Promise<IndexResult> {
  const r = await fetch(`${base}/api/v1/results/${encodeURIComponent(task)}/${encodeURIComponent(op)}/${kind}/index`)
  if (r.status === 200) return { status: 200, index: await json<ProductIndex>(r) }
  if (r.status === 409) {
    const ra = Number(r.headers.get('retry-after') ?? '1')
    return { status: 409, retryAfterMs: (Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000 }
  }
  if (r.status === 404) return { status: 404 }
  return { status: r.status, message: `index HTTP ${r.status}` }
}

/** 视窗抽取（B-7）。200 带数据与元信息；409 未就绪；413 超限带建议；其余判别；网络失败才抛。 */
export type WindowResult =
  | { status: 200; data: Float32Array; meta: WindowMeta }
  | { status: 409; retryAfterMs: number }
  | { status: 413; suggest: { px: number; py: number } | null }
  | { status: 400; message: string }
  | { status: 404 }
  | { status: number; message: string }

async function fetchWindow(url: string, signal?: AbortSignal): Promise<WindowResult> {
  const r = await fetch(url, signal ? { signal } : undefined)
  if (r.status === 200) {
    const meta = parseWindowHeaders((n) => r.headers.get(n))
    const buf = await r.arrayBuffer()
    checkWindowBody(buf.byteLength, meta)
    return { status: 200, data: new Float32Array(buf), meta }
  }
  if (r.status === 409) return { status: 409, retryAfterMs: parseRetryAfterMs(r.headers.get('retry-after')) }
  if (r.status === 404) return { status: 404 }
  let body: Record<string, unknown> = {}
  try { body = await json<Record<string, unknown>>(r) } catch { /* 忽略 */ }
  if (r.status === 413) return { status: 413, suggest: parseSuggest(body) }
  const message = String(body['message'] ?? body['error'] ?? `HTTP ${r.status}`)
  if (r.status === 400) return { status: 400, message: body['param'] ? `${String(body['param'])}：${message}` : message }
  return { status: r.status, message }
}

export function getSpectrumWindow(task: string, op: string, q: SpectrumRequest, signal?: AbortSignal, base = ''): Promise<WindowResult> {
  return fetchWindow(`${base}/api/v1/results/${encodeURIComponent(task)}/${encodeURIComponent(op)}/spectrum?${spectrumQueryString(q)}`, signal)
}

export function getEnvelopeWindow(task: string, op: string, q: { t0: number; t1: number; px: number }, signal?: AbortSignal, base = ''): Promise<WindowResult> {
  return fetchWindow(`${base}/api/v1/results/${encodeURIComponent(task)}/${encodeURIComponent(op)}/envelope?${envelopeQueryString(q)}`, signal)
}

// ---------------------------------------------------------------------------
// 场景与航迹（G-4 / G-5）
// ---------------------------------------------------------------------------

export interface ScenarioSummary {
  scenario_id: string
  aoi: string
  name: string
  duration_s: number | null
  sites: number
  emitters: number
}

export async function listScenarios(base = ''): Promise<ScenarioSummary[]> {
  const r = await fetch(`${base}/api/v1/scenarios`)
  if (!r.ok) throw new Error(`scenarios HTTP ${r.status}`)
  return (await json<{ scenarios: ScenarioSummary[] }>(r)).scenarios
}

/** 读场景全文。sha256 是**落盘字节**的哈希，写进框图的 scenario_ref 就用它。 */
export async function getScenario(
  id: string,
  base = '',
): Promise<{ doc: Record<string, unknown>; sha256: string; aoi: string } | null> {
  const r = await fetch(`${base}/api/v1/scenarios/${encodeURIComponent(id)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`scenario HTTP ${r.status}`)
  const text = await r.text()
  return {
    doc: JSON.parse(text) as Record<string, unknown>,
    sha256: r.headers.get('x-cuav-sha256') ?? '',
    aoi: r.headers.get('x-cuav-aoi') ?? '',
  }
}

// ---------------------------------------------------------------- 实测数据清单（D-056）

export interface DatasetRow {
  data_id: string
  kind: string
  batch: string
  /** 命中验收集：允许回放但界面要提示（D-038） */
  holdout: boolean
  class_name?: string
  visibility?: string
  distance_text?: string
  split?: string
  center_frequency_Hz?: number
  sample_count?: number
  quality?: string
}

export interface DatasetList {
  total: number
  matched: number
  truncated: boolean
  items: DatasetRow[]
}

/**
 * 列实测数据片段的摘要（D-056）。服务端按机型分组抽样，`truncated` 说明没列全——
 * 界面要如实说「共多少、列了多少」，不假装列全了。
 * `dataId` 精确查一条：框图里已经填着的那个可能不在抽样里，也得能显示出来。
 */
export async function listDatasets(
  opts: { q?: string; dataId?: string } = {}, base = '',
): Promise<DatasetList> {
  const p = new URLSearchParams()
  if (opts.dataId) p.set('data_id', opts.dataId)
  else if (opts.q) p.set('q', opts.q)
  const r = await fetch(`${base}/api/v1/datasets${p.size ? `?${p}` : ''}`)
  if (!r.ok) throw new Error(`GET /api/v1/datasets ${r.status}`)
  const b = (await r.json()) as DatasetList
  return {
    total: Number(b.total) || 0,
    matched: Number(b.matched) || 0,
    truncated: !!b.truncated,
    items: Array.isArray(b.items) ? b.items : [],
  }
}

export type PutScenarioResult =
  | { ok: true; sha256: string; bytes: number }
  | { ok: false; code: string; message: string }

/**
 * 写场景。服务端只做最小结构检查，语义交引擎（D-042）；返回的 sha256 是落盘字节的哈希，
 * 前端据此更新框图 scenario_ref——两端各自序列化再算哈希必然对不上。
 */
export async function putScenario(id: string, doc: unknown, base = ''): Promise<PutScenarioResult> {
  const r = await fetch(`${base}/api/v1/scenarios/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc, null, 2),
  })
  const text = await r.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { /* 非 JSON 响应 */ }
  if (r.ok) return { ok: true, sha256: String(body['sha256'] ?? ''), bytes: Number(body['bytes'] ?? 0) }
  const detail = body['detail'] as Record<string, unknown> | undefined
  return {
    ok: false,
    code: String(detail?.['code'] ?? body['error'] ?? `HTTP ${r.status}`),
    message: String(detail?.['message'] ?? body['message'] ?? text.slice(0, 200)),
  }
}

// ------------------------------------------------------- 框图读写（C-6，D-051）

export interface DiagramSummary {
  diagram_id: string
  name: string
  template_id: string | null
  mode: string | null
  scenario_id: string | null
  nodes: number
  observation_points: number
  bytes: number
  modified_utc: string
}

export async function listDiagrams(base = ''): Promise<DiagramSummary[]> {
  const r = await fetch(`${base}/api/v1/diagrams`)
  if (!r.ok) throw new Error(`diagrams HTTP ${r.status}`)
  return (await json<{ diagrams: DiagramSummary[] }>(r)).diagrams
}

/** 读框图全文。返回的是**盘上原文**，不是重新序列化的结果。 */
export async function getDiagram(id: string, base = ''): Promise<{ text: string; sha256: string } | null> {
  const r = await fetch(`${base}/api/v1/diagrams/${encodeURIComponent(id)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`diagram HTTP ${r.status}`)
  return { text: await r.text(), sha256: r.headers.get('x-cuav-sha256') ?? '' }
}

export type PutDiagramResult =
  | { ok: true; sha256: string; bytes: number; warnings: string[] }
  | { ok: false; code: string; message: string; node_id: string }

/** 写框图。与场景同法：服务端最小检查，语义交引擎 `--validate`（D-042）。 */
export async function putDiagram(id: string, text: string, base = ''): Promise<PutDiagramResult> {
  const r = await fetch(`${base}/api/v1/diagrams/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: text,
  })
  const body = await r.text()
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(body) as Record<string, unknown> } catch { /* 非 JSON 响应 */ }
  if (r.ok) {
    return {
      ok: true,
      sha256: String(j['sha256'] ?? ''),
      bytes: Number(j['bytes'] ?? 0),
      warnings: Array.isArray(j['warnings']) ? (j['warnings'] as string[]) : [],
    }
  }
  const detail = j['detail'] as Record<string, unknown> | undefined
  return {
    ok: false,
    code: String(detail?.['code'] ?? j['error'] ?? `HTTP ${r.status}`),
    message: String(detail?.['message'] ?? j['message'] ?? body.slice(0, 200)),
    node_id: String(detail?.['node_id'] ?? ''),
  }
}

export async function deleteDiagram(id: string, base = ''): Promise<boolean> {
  const r = await fetch(`${base}/api/v1/diagrams/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return r.ok
}

/** 评价指标（C-5 的产物，C-6 的端点）。未就绪或没有即 null。 */
export async function getMetrics(task: string, base = ''): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${base}/api/v1/results/${encodeURIComponent(task)}/metrics`)
  if (!r.ok) return null
  return (await r.json()) as Record<string, unknown>
}

/** 航迹与链路读数（B-7 的 JSONL 端点，生产者是 G-2）。终态任务没有这类记录时返回空数组。 */
async function getJsonlWindow<T>(
  task: string, kind: 'track' | 'links' | 'bearings' | 'positions', q: string, base: string,
): Promise<T[]> {
  const r = await fetch(`${base}/api/v1/results/${encodeURIComponent(task)}/${kind}${q}`)
  if (r.status === 404) return []
  if (!r.ok) throw new Error(`${kind} HTTP ${r.status}`)
  return json<T[]>(r)
}

export function getTrack(
  task: string, t0: number, t1: number, stride = 1, base = '',
): Promise<Array<Record<string, unknown>>> {
  return getJsonlWindow(task, 'track', `?t0=${t0}&t1=${t1}&stride=${stride}`, base)
}

export function getLinks(
  task: string, t0: number, t1: number, stride = 1, base = '',
): Promise<Array<Record<string, unknown>>> {
  return getJsonlWindow(task, 'links', `?t0=${t0}&t1=${t1}&stride=${stride}`, base)
}

/** 测向报告（D-053）。任务没有测向节点时端点 404，这里返回空数组不当错误。 */
export function getBearings(
  task: string, t0: number, t1: number, stride = 1, base = '',
): Promise<Array<Record<string, unknown>>> {
  return getJsonlWindow(task, 'bearings', `?t0=${t0}&t1=${t1}&stride=${stride}`, base)
}

/** 定位解（D-053）。 */
export function getPositions(
  task: string, t0: number, t1: number, stride = 1, base = '',
): Promise<Array<Record<string, unknown>>> {
  return getJsonlWindow(task, 'positions', `?t0=${t0}&t1=${t1}&stride=${stride}`, base)
}
