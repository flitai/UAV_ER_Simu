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
