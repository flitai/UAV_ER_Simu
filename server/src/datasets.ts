// 实测数据清单的只读端点（列表 D-056；单条详情 U-4 / D-075）。
//
// 框图里对实测数据的引用只写 data_id（D-037），浏览器永不见服务器路径；但用户总得有办法
// **知道有哪些片段可选**。此前没有任何接口把清单给出去，回放模式只能手敲标识
// （2026-09-09 用户实测撞到）。这里补上，只读、只出摘要，不出任何路径。
//
//   GET /api/v1/datasets?q=&data_id=&batch=&class=&holdout=&limit=   列表（分组抽样，见下）
//   GET /api/v1/datasets/{data_id}                                   单条详情（两档，见 detailOf）
//
// **白名单，不是黑名单**：详情的每一个键都是这里逐个挑出来写的。索引与逐产物清单里带着
// `source_file`、`producer`、`origin.conversion.tool`、`power.calibration.table` 这类**外部来源或
// 仓库相对路径**——铁律 17 允许它们留在数据里存档，但留档不等于可以发给浏览器。整份透传一次，
// 这条界线就没了，所以这里宁可啰嗦地一键一键挑。

import { promises as fsp } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { SAFE_NAME, type DataEntry, type DataIndex } from './tasks/resolve.js'

/** 一个机型下最多列几条。4714 条全给出去没有意义，演示挑的是机型不是某一片 */
const PER_GROUP = 12
const MAX_ITEMS = 400
const MAX_ITEMS_CAP = 2000

const RE_ONE = /^\/api\/v1\/datasets\/([^/]+)$/

export interface DatasetsDeps {
  index: DataIndex
  /** 仓库根：详情要读逐产物清单（留盘不入 git），路径只在服务端出现 */
  root: string
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
  const one = RE_ONE.exec(url.pathname)
  if (url.pathname !== '/api/v1/datasets' && !one) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return true
  }
  await deps.index.ensureLoaded()
  if (one) return await sendDetail(deps, res, decodeURIComponent(one[1]))
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
  const batch = (url.searchParams.get('batch') ?? '').trim()
  const cls = (url.searchParams.get('class') ?? '').trim()
  const holdoutOnly = boolParam(url.searchParams.get('holdout'))
  const limit = parseLimit(url.searchParams.get('limit'))
  const hits = all.filter((e) => matches(e, q)
    && (!batch || e.batch === batch)
    && (!cls || e.label.class_name === cls)
    && (holdoutOnly === undefined || deps.index.isHoldout(e.data_id) === holdoutOnly))

  // 分组抽样只在**没有点名机型**时生效：挑片段挑的是机型不是某一片，4714 条塞进一个下拉
  // 既慢又没用。但一旦用户已经点了某个机型，"按机型分组"就只剩一个组，再抽样等于
  // 把他刚刚筛出来的东西又藏起来——那时按索引序直接给到 limit。
  const items: Row[] = []
  if (cls) {
    for (const e of hits) {
      if (items.length >= limit) break
      items.push(toRow(e, deps.index.isHoldout(e.data_id)))
    }
  } else {
    const groups = new Map<string, DataEntry[]>()
    for (const e of hits) {
      const key = e.label.class_name ?? `（${e.batch}）`
      const g = groups.get(key)
      if (g) { if (g.length < PER_GROUP) g.push(e) } else groups.set(key, [e])
    }
    for (const [, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const e of g) {
        if (items.length >= limit) break
        items.push(toRow(e, deps.index.isHoldout(e.data_id)))
      }
    }
  }
  return sendJson(res, 200, {
    schema_version: 'cuav-datasets/1',
    total: all.length,
    matched: hits.length,
    truncated: items.length < hits.length,
    facets: facetsOf(all, deps.index),
    items,
  })
}

function boolParam(v: string | null): boolean | undefined {
  if (v === null) return undefined
  const t = v.trim().toLowerCase()
  if (t === 'true' || t === '1') return true
  if (t === 'false' || t === '0') return false
  return undefined
}

function parseLimit(v: string | null): number {
  const n = v === null ? NaN : Number(v)
  if (!Number.isFinite(n) || n < 1) return MAX_ITEMS
  return Math.min(MAX_ITEMS_CAP, Math.floor(n))
}

/**
 * 左栏分面的计数，**在全量上算**，不是在这一页列出来的那几条上算。
 * 在列出来的条目上算分面会给出一个自洽却错误的画面：抽样每组只留 12 条，
 * 分面就会说每个机型都只有 12 条。
 */
function facetsOf(all: DataEntry[], index: DataIndex): Record<string, Record<string, number>> {
  const bump = (m: Record<string, number>, k: string | undefined) => { if (k) m[k] = (m[k] ?? 0) + 1 }
  const batch: Record<string, number> = {}
  const class_name: Record<string, number> = {}
  const visibility: Record<string, number> = {}
  const split: Record<string, number> = {}
  const holdout: Record<string, number> = { true: 0, false: 0 }
  for (const e of all) {
    bump(batch, e.batch)
    bump(class_name, e.label.class_name)
    bump(visibility, e.label.visibility)
    bump(split, e.label.split)
    holdout[index.isHoldout(e.data_id) ? 'true' : 'false'] += 1
  }
  return { batch, class_name, visibility, split, holdout }
}

function sendJson(res: ServerResponse, code: number, body: unknown): boolean {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
  return true
}

/* ─── 单条详情（U-4，D-075）───────────────────────────────────────────────── */

/** 真值里允许出的键。**`original_name` 不在其中**：那是外部数据集的切片名（铁律 17）。 */
const TRUTH_KEYS = ['class_code', 'class_name', 'split', 'visibility', 'individual',
  'distance_m', 'distance_range_m', 'distance_bin', 'band_state'] as const
/** 摸底统计里挑几项有用的：都是从样点算出来的量，不是来源说明。 */
const SURVEY_KEYS = ['rms_dBFS', 'peak_dBFS', 'clip_samples', 'zero_samples',
  'noise_floor_dB', 'peak_above_noise_dB', 'occupied_bandwidth_Hz'] as const

function pick(src: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!src || typeof src !== 'object') return undefined
  const o = src as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k]
  return Object.keys(out).length ? out : undefined
}

function put(into: Record<string, unknown>, key: string, v: unknown): void {
  if (v !== undefined) into[key] = v
}

/**
 * 详情分两档，档位在响应里写明（`detail_level`）：
 *
 * - `index`：只有批索引。**批索引入 git**（`.gitignore` 放行 `index.manifest.json`），
 *   所以任何一份克隆上都有这一档——列表是全量的，只是详情浅一点。
 * - `manifest`：逐产物清单也在盘上（那些不入 git，`tools/iq_convert.py` 确定性重生成）。
 *   采样率、片长、八项质检明细、溯源六件套只有这一档才有。
 *
 * 批索引里**没有采样率**，所以 `index` 档算不出片长——缺的就是缺的，键整个不出现，
 * 界面写「—」，不拿别的数顶替（铁律 15）。
 */
export function detailOf(e: DataEntry, holdout: boolean, manifest: Record<string, unknown> | null): Record<string, unknown> {
  const p = e.product
  const index: Record<string, unknown> = {}
  put(index, 'dataset', e.dataset)
  put(index, 'channel_id', p.channel_id)
  put(index, 'center_frequency_Hz', p.center_frequency_Hz)
  put(index, 'sample_count', p.sample_count)
  put(index, 'segments', p.segments)
  put(index, 'content_sha256', p.content_sha256)
  put(index, 'quality', p.quality)
  put(index, 'truth', pick(p.truth, TRUTH_KEYS))

  const out: Record<string, unknown> = {
    schema_version: 'cuav-dataset/1',
    data_id: e.data_id,
    kind: e.kind,
    batch: e.batch,
    holdout,
    detail_level: manifest ? 'manifest' : 'index',
    index,
  }
  // 标定常数只出数值、来源与状态。**note 与 table 不出**：前者是反推过程的长句、
  // 后者是 data/iq/measured/calibration.json 这个仓库相对路径（D-047、铁律 17）。
  const calFromManifest = pick((manifest?.power as Record<string, unknown> | undefined)?.calibration,
    ['full_scale_dBm', 'source', 'status', 'estimated_utc'])
  const calFromIndex = pick(e.calibration, ['full_scale_dBm', 'source', 'status', 'estimated_utc'])
  put(out, 'calibration', calFromManifest ?? calFromIndex)
  if (!manifest) return out

  const m: Record<string, unknown> = {}
  const sampling = pick(manifest.sampling, ['sample_format', 'sample_rate_Hz', 'sample_count', 'byte_order', 'iq_layout'])
  if (sampling) {
    const fs = sampling.sample_rate_Hz
    const n = sampling.sample_count
    // 片长是算出来的，不是清单里的字段；两个操作数缺一个就不给这个键
    if (typeof fs === 'number' && fs > 0 && typeof n === 'number') sampling.duration_s = n / fs
    m.sampling = sampling
  }
  put(m, 'frequency', pick(manifest.frequency, ['center_frequency_Hz', 'effective_bandwidth_Hz']))
  // start_time 在两个公开数据集里都是 null（发布版无绝对时间戳）。pick 会把 null 丢掉，
  // 于是这个键整个不出现、界面写「—」——与「有个值叫 null」是同一件事的两种写法，取前者。
  put(m, 'time', pick(manifest.time, ['time_basis', 'start_time', 'continuity']))
  put(m, 'channel', pick(manifest.channel, ['station_id', 'channel_id', 'antenna']))
  // power：**不出 `reason`**（里头写着 scripts/ds8_calibration.py）
  put(m, 'power', pick(manifest.power, ['absolute_power', 'gain_dB', 'agc', 'full_scale', 'scale']))
  put(m, 'quality', pick(manifest.quality, ['status', 'checks', 'reasons']))
  put(m, 'model_trace', pick(manifest.model_trace,
    ['model_id', 'model_version', 'model_level', 'model_layer', 'credibility', 'parameter_version', 'confidence', 'trace_id']))
  // origin 只放这两键。它是铁律 17 允许留外部历史来源的唯一例外——
  // source_file / source_sha256 / doi / conversion 一律不出。
  put(m, 'origin', pick(manifest.origin, ['kind', 'dataset']))
  if (manifest.field_sources && typeof manifest.field_sources === 'object') m.field_sources = manifest.field_sources
  put(m, 'survey', pick((manifest.survey as Record<string, unknown> | undefined)?.stats, SURVEY_KEYS))
  // 段只出个数与样点数：段里每一项都带文件名
  const segs = manifest.segments
  if (Array.isArray(segs)) {
    let n = 0
    for (const sg of segs as Array<Record<string, unknown>>) if (typeof sg?.sample_count === 'number') n += sg.sample_count
    m.segments = { count: segs.length, sample_count: n }
  }
  out.manifest = m
  return out
}

async function sendDetail(deps: DatasetsDeps, res: ServerResponse, dataId: string): Promise<boolean> {
  if (!SAFE_NAME.test(dataId)) {
    return sendJson(res, 400, { error: 'bad_data_id', message: '标识必须是 ASCII 字母数字开头、只含字母数字与 _ . -，不超过 128 字符' })
  }
  const e = deps.index.get(dataId)
  if (!e) return sendJson(res, 404, { error: 'not_found', data_id: dataId })

  // 清单不在盘上 → index 档（正常情况：逐产物清单不入 git）。
  // 在盘上却读不动 → 500，**不悄悄降回 index 档**：那会把「文件坏了」显示成「这台机器没数据」。
  let manifest: Record<string, unknown> | null = null
  try {
    const text = await fsp.readFile(join(deps.root, ...e.manifestRel.split('/')), 'utf8')
    const j: unknown = JSON.parse(text)
    if (!j || typeof j !== 'object') throw new Error('清单不是 JSON 对象')
    manifest = j as Record<string, unknown>
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return sendJson(res, 500, { error: 'dataset_read', message: `逐产物清单读不动：${String((err as Error).message ?? err)}` })
    }
  }
  return sendJson(res, 200, detailOf(e, deps.index.isHoldout(dataId), manifest))
}
