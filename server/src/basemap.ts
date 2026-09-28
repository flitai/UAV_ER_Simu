// 底图选用（W-3，D-084）：开发机上保留全球底图，交付包只带区域底图，两份并存、由这里挑一份给浏览器。
//
// 选用规则（环境变量 CUAV_BASEMAP）：
//   - `planet`：全球底图 data/basemap/planet.pmtiles + 全球 DEM data/basemap/dem/；
//   - `<区域 id>`（如 `beijing`）：data/basemap/regional/<id>.pmtiles + regional/<id>-dem/；
//   - 不设：**全球底图在就用它**（开发机的老行为逐字不变），不在就用唯一的一份区域底图；
//     区域底图不止一份又没点名 → 不猜，报错要求点名。
// 点了名却不在盘上 → 503 并说清楚缺哪个文件，**不退回另一份**（铁律 15：不拿别的顶替）。
// 每次请求现查一次文件，换底图不必重启服务。

import { promises as fsp } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { sendJson } from './static.js'

const ID_RE = /^[a-z0-9][a-z0-9-]*$/

export interface BasemapChoice {
  id: string
  kind: 'planet' | 'regional'
  /** 浏览器取底图用的地址（经 /data/basemap/ 的 Range 静态服务） */
  pmtiles_url: string
  dem_tiles: string
  /** 区域底图的覆盖范围 [W, S, E, N]；全球底图为 null */
  bounds: [number, number, number, number] | null
  /**
   * 区域底图之外的全球概览（D-084 补充）：`data/basemap/overview/world-z6.pmtiles`，zoom 0–6。
   * 只配区域底图用——前端把两份合成一个数据源，zoom ≤ overview_maxzoom 取概览、以上取区域底图；
   * 全球底图本身就全，恒为 null。概览不在盘上也是 null（区域外空白照实，不报错）
   */
  overview_url: string | null
  overview_maxzoom: number | null
  selected_by: 'env' | 'auto'
}

export type BasemapResult = { ok: true; choice: BasemapChoice } | { ok: false; status: number; code: string; message: string }

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

async function regionalIds(root: string): Promise<string[]> {
  try {
    const es = await fsp.readdir(join(root, 'data', 'basemap', 'regional'))
    return es.filter((f) => f.endsWith('.pmtiles') && !f.includes('.part.'))
      .map((f) => f.slice(0, -'.pmtiles'.length)).filter((id) => ID_RE.test(id)).sort()
  } catch {
    return []
  }
}

async function regionalBounds(root: string, id: string): Promise<[number, number, number, number] | null> {
  try {
    const m = JSON.parse(await fsp.readFile(join(root, 'data', 'basemap', 'regional', `${id}.manifest.json`), 'utf8')) as
      { output?: { bounds?: number[] } }
    const b = m.output?.bounds
    return Array.isArray(b) && b.length === 4 ? (b as [number, number, number, number]) : null
  } catch {
    return null
  }
}

const OVERVIEW_ID = 'world-z6'

/** 全球概览底图：文件与清单都在才算数，最高层级取清单里自检过的 maxzoom，不写死 */
async function overview(root: string): Promise<{ url: string; maxzoom: number } | null> {
  const dir = join(root, 'data', 'basemap', 'overview')
  if (!(await exists(join(dir, `${OVERVIEW_ID}.pmtiles`)))) return null
  try {
    const m = JSON.parse(await fsp.readFile(join(dir, `${OVERVIEW_ID}.manifest.json`), 'utf8')) as { output?: { maxzoom?: number } }
    const z = m.output?.maxzoom
    return typeof z === 'number' && Number.isInteger(z) && z >= 0 ? { url: `/data/basemap/overview/${OVERVIEW_ID}.pmtiles`, maxzoom: z } : null
  } catch {
    return null
  }
}

export async function resolveBasemap(root: string, env: string | undefined = process.env.CUAV_BASEMAP): Promise<BasemapResult> {
  const want = env?.trim() || ''
  const planetOk = await exists(join(root, 'data', 'basemap', 'planet.pmtiles'))
  const planet = (by: 'env' | 'auto'): BasemapResult => ({
    ok: true,
    choice: { id: 'planet', kind: 'planet', pmtiles_url: '/data/basemap/planet.pmtiles',
      dem_tiles: '/data/basemap/dem/{z}/{x}/{y}.png', bounds: null, overview_url: null, overview_maxzoom: null, selected_by: by },
  })
  const regional = async (id: string, by: 'env' | 'auto'): Promise<BasemapResult> => {
    const ov = await overview(root)
    return {
      ok: true,
      choice: { id, kind: 'regional', pmtiles_url: `/data/basemap/regional/${id}.pmtiles`,
        dem_tiles: `/data/basemap/regional/${id}-dem/{z}/{x}/{y}.png`, bounds: await regionalBounds(root, id),
        overview_url: ov?.url ?? null, overview_maxzoom: ov?.maxzoom ?? null, selected_by: by },
    }
  }

  if (want === 'planet') {
    return planetOk ? planet('env')
      : { ok: false, status: 503, code: 'basemap_unavailable', message: 'CUAV_BASEMAP=planet，但 data/basemap/planet.pmtiles 不在本机' }
  }
  if (want) {
    if (!ID_RE.test(want)) return { ok: false, status: 503, code: 'basemap_unavailable', message: `CUAV_BASEMAP 取值不合法：${want}` }
    return (await regionalIds(root)).includes(want) ? regional(want, 'env')
      : { ok: false, status: 503, code: 'basemap_unavailable', message: `CUAV_BASEMAP=${want}，但 data/basemap/regional/${want}.pmtiles 不在本机` }
  }
  if (planetOk) return planet('auto')
  const ids = await regionalIds(root)
  if (ids.length === 1) return regional(ids[0]!, 'auto')
  if (ids.length === 0) return { ok: false, status: 503, code: 'basemap_unavailable', message: '本机既没有全球底图也没有区域底图（data/basemap/）' }
  return { ok: false, status: 503, code: 'basemap_ambiguous', message: `本机有多份区域底图（${ids.join('、')}），请用 CUAV_BASEMAP 点名` }
}

/** GET /api/v1/basemap。处理了返回 true。 */
export async function handleBasemapRoute(root: string, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path !== '/api/v1/basemap') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return true
  }
  const r = await resolveBasemap(root)
  if (r.ok) sendJson(res, 200, r.choice)
  else sendJson(res, r.status, { error: r.code, message: r.message })
  return true
}
