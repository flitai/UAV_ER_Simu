// 数据导出端点（D-090）：把一次任务里存了原始 IQ 的观测点导出成 SigMF，写到服务器本机目录。
//
//   GET  /api/v1/tasks/{id}/export   可导出的观测点（ADC 之后、开了 iq、样点文件在）+ 当前或上一次导出作业 + 导出目录里的文件
//   POST /api/v1/tasks/{id}/export   {ops?: string[]} → 202 起一个导出作业；缺省导出全部可导出的观测点
//
// 原始 IQ 不进浏览器（铁律 7、D-087 ③）：两个端点只回摘要（观测点、样点数、大小、进度、文件名与字节数），
// 样点只在服务器盘上从 data/runs/<任务>/ 流到 data/exports/<任务>/。目录以相对仓库根的形式给出
// （`data/exports/<任务>/`，铁律 17），不给绝对路径——单机模式下用户就在这台机器上，按安装目录去找。
//
// 作业在进程内：同一任务同时只跑一个导出；导出先写进 `.tmp-<作业>/`，全部成功才挪进导出目录并写
// `export.json`（服务重启后 GET 据它报上一次的结果），失败或服务中途停掉不会留下半截文件。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { sendJson } from '../static.js'
import { readJsonBody } from '../tasks/routes.js'
import { HttpError } from '../tasks/manager.js'
import type { TaskRecord } from '../tasks/store.js'
import { EXPORTER_VERSION, ExportError, exportRun, exportableOps, pointOf, type CatalogDoc, type ExportOpResult } from './sigmf.js'

export interface ExportDeps {
  /** 仓库根（找场景文件） */
  root: string
  getTask: (id: string) => TaskRecord | null
  runDir: (id: string) => string
  exportDir: (id: string) => string
  catalog: () => Promise<CatalogDoc>
  now?: () => string
  log?: (msg: string) => void
}

export interface ExportJob {
  job_id: string
  state: 'running' | 'done' | 'failed'
  ops: string[]
  started_utc: string
  ended_utc?: string
  progress: { done_bytes: number; total_bytes: number }
  error?: string
  results?: ExportOpResult[]
}

export interface ExportableOp {
  op_id: string
  point: string
  label: string
  sample_rate_Hz: number
  center_Hz: number
  samples: number
  duration_s: number
  /** 引擎存的 cf32 字节数（每复样点 8 字节） */
  bytes_raw: number
  /** 导出后 .sigmf-data 的字节数（ci16，每复样点 4 字节） */
  bytes_export: number
}

const RE = /^\/api\/v1\/tasks\/([^/]+)\/export$/
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isExportPath(path: string): boolean {
  return RE.test(path)
}

export class ExportService {
  private readonly jobs = new Map<string, ExportJob>()
  private seq = 0

  constructor(readonly deps: ExportDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  }

  /** 相对仓库根的导出目录（给界面看的形式） */
  dirRel(id: string): string {
    return `data/exports/${id}/`
  }

  async exportable(id: string): Promise<ExportableOp[]> {
    const run = this.deps.runDir(id)
    let d: Parameters<typeof exportableOps>[0]
    try {
      d = JSON.parse(await fsp.readFile(join(run, 'diagram.json'), 'utf8'))
    } catch {
      return []
    }
    const out: ExportableOp[] = []
    for (const op of exportableOps(d)) {
      let idx: Record<string, unknown>
      try {
        idx = JSON.parse(await fsp.readFile(join(run, op.id, 'iq.index.json'), 'utf8'))
      } catch {
        continue                                     // 没跑完或 iq 没写出来：不列
      }
      const n = Number(idx.samples)
      const fs = Number(idx.sample_rate_Hz)
      out.push({
        op_id: op.id, point: pointOf(d, op) ?? '', label: op.label ?? op.id,
        sample_rate_Hz: fs, center_Hz: Number(idx.center_Hz), samples: n, duration_s: n / fs,
        bytes_raw: 8 * n, bytes_export: 4 * n,
      })
    }
    return out
  }

  /** 进程内的作业；没有则读导出目录里的 export.json（上一次成功的导出） */
  async job(id: string): Promise<ExportJob | null> {
    const live = this.jobs.get(id)
    if (live) return live
    try {
      const saved = JSON.parse(await fsp.readFile(join(this.deps.exportDir(id), 'export.json'), 'utf8')) as ExportJob
      return saved
    } catch {
      return null
    }
  }

  async files(id: string): Promise<Array<{ name: string; bytes: number }>> {
    const dir = this.deps.exportDir(id)
    let names: string[] = []
    try {
      names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
    } catch {
      return []
    }
    const out = []
    for (const name of names.sort()) {
      if (name === 'export.json') continue
      out.push({ name, bytes: (await fsp.stat(join(dir, name))).size })
    }
    return out
  }

  async start(id: string, rec: TaskRecord, ops: string[] | undefined): Promise<ExportJob> {
    if (rec.run_state !== 'finished') {
      throw new HttpError(409, { error: 'not_finished', task_id: id, run_state: rec.run_state, message: '任务还没有正常结束' })
    }
    if (this.jobs.get(id)?.state === 'running') {
      throw new HttpError(409, { error: 'export_running', task_id: id, message: '这个任务正在导出' })
    }
    const avail = await this.exportable(id)
    if (!avail.length) {
      throw new HttpError(409, { error: 'nothing_to_export', task_id: id, message: '这个任务没有存原始 IQ 的观测点' })
    }
    const ids = new Set(avail.map((a) => a.op_id))
    if (ops !== undefined) {
      const bad = ops.filter((x) => !ids.has(x))
      if (bad.length || !ops.length) {
        throw new HttpError(400, { error: 'bad_ops', task_id: id, ops: bad, message: `不可导出的观测点：${bad.join('、') || '（空）'}` })
      }
    }
    const want = ops ?? avail.map((a) => a.op_id)
    const total = avail.filter((a) => want.includes(a.op_id)).reduce((s, a) => s + a.bytes_raw, 0)
    const job: ExportJob = {
      job_id: `x${Date.now().toString(36)}${(this.seq++).toString(36)}`,
      state: 'running', ops: want, started_utc: this.now(), progress: { done_bytes: 0, total_bytes: total },
    }
    this.jobs.set(id, job)
    void this.run(id, job)
    return job
  }

  private async run(id: string, job: ExportJob): Promise<void> {
    const dir = this.deps.exportDir(id)
    const tmp = join(dir, `.tmp-${job.job_id}`)
    try {
      const catalog = await this.deps.catalog()
      await fsp.mkdir(tmp, { recursive: true })
      const results = await exportRun({
        root: this.deps.root, runDir: this.deps.runDir(id), outDir: tmp, catalog, ops: job.ops, stemPrefix: id,
        onProgress: (done, total) => {
          job.progress = { done_bytes: done, total_bytes: total }
        },
      })
      for (const r of results) {
        for (const f of r.files) await fsp.rename(join(tmp, f.name), join(dir, f.name))
      }
      job.state = 'done'
      job.results = results
      job.ended_utc = this.now()
      const saved: ExportJob & { task_id: string; exporter: string } = {
        ...job, task_id: id, exporter: `server/src/exports/sigmf.ts ${EXPORTER_VERSION}`,
      }
      await fsp.writeFile(join(dir, 'export.json'), JSON.stringify(saved, null, 2) + '\n', 'utf8')
    } catch (e) {
      job.state = 'failed'
      job.ended_utc = this.now()
      job.error = e instanceof ExportError ? e.message : `导出失败：${(e as Error).message}`
      if (!(e instanceof ExportError)) this.deps.log?.(`导出 ${id} 出错：${(e as Error).stack ?? String(e)}`)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  }
}

/** 命中导出路由返回 true（含 405 / 404 / 4xx）；不是返回 false */
export async function handleExportRoutes(req: IncomingMessage, res: ServerResponse, path: string, svc: ExportService): Promise<boolean> {
  const m = RE.exec(path)
  if (!m) return false
  const method = req.method ?? 'GET'
  const id = decodeURIComponent(m[1])
  const rec = TASK_ID.test(id) ? svc.deps.getTask(id) : null
  if (!rec) {
    sendJson(res, 404, { error: 'not_found', task_id: id })
    return true
  }
  try {
    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, {
        task_id: id, run_state: rec.run_state, dir: svc.dirRel(id),
        exportable: await svc.exportable(id), job: await svc.job(id), files: await svc.files(id),
      })
      return true
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req)) as { ops?: unknown } | null
      let ops: string[] | undefined
      if (body && body.ops !== undefined) {
        if (!Array.isArray(body.ops) || !body.ops.every((x) => typeof x === 'string')) {
          sendJson(res, 400, { error: 'bad_request', message: 'ops 必须是字符串数组' })
          return true
        }
        ops = body.ops as string[]
      }
      const job = await svc.start(id, rec, ops)
      sendJson(res, 202, { task_id: id, dir: svc.dirRel(id), job })
      return true
    }
    res.writeHead(405, { allow: 'GET, HEAD, POST' })
    res.end()
    return true
  } catch (e) {
    if (e instanceof HttpError) {
      sendJson(res, e.status, e.body)
      return true
    }
    throw e
  }
}
