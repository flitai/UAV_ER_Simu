// 场景数据包的读取。前端只认数据包清单 `manifest.json`，不硬编码任何路径或数字——
// 清单是数据包的入口（里程碑 D0-6），改了数据包前端自动跟随。
// 底图同理：用哪一份（开发机上的全球底图，还是交付包里的区域底图）由服务端 /api/v1/basemap 说了算（D-084），
// 这里不写死 planet.pmtiles；取不到就报错，不退回写死的地址。

export interface SceneSummary {
  id: string
  name: string
  bbox: [number, number, number, number]
  center: [number, number]
  extentKm: [number, number]
  buildings: {
    features: number
    srcPct: Record<string, number>
    heightQ50: number | null
    heightMax: number | null
    estimatedPct: number
  }
  /** 服务端选用的底图（D-084）：`planet` 或区域 id */
  basemapId: string
  basemapUrl: string
  /** 区域底图之外的全球概览（D-084 补充）；全球底图或概览不在时为 null */
  overviewUrl: string | null
  overviewMaxZoom: number | null
  demTiles: string
  buildingsUrl: string
  osmSnapshot: string | null
  attribution: string | null
}

interface RawManifest {
  aoi: { id: string; name?: string; bbox: number[]; center: number[]; extent_km?: number[] }
  buildings_summary?: {
    features?: number
    src_distribution_pct?: Record<string, number>
    height_m?: { q50?: number; max?: number }
  }
  provenance?: { osm_snapshot_of_tiles?: string; attribution?: string }
}

export async function listScenes(base = ''): Promise<string[]> {
  const r = await fetch(`${base}/api/v1/scenes`)
  if (!r.ok) throw new Error(`列出场景失败：HTTP ${r.status}`)
  return ((await r.json()) as { scenes: string[] }).scenes
}

interface BasemapChoice { id: string; pmtiles_url: string; dem_tiles: string; overview_url: string | null; overview_maxzoom: number | null }

async function loadBasemap(base: string): Promise<BasemapChoice> {
  const r = await fetch(`${base}/api/v1/basemap`)
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { message?: string } | null
    throw new Error(`底图不可用：${body?.message ?? `HTTP ${r.status}`}`)
  }
  return (await r.json()) as BasemapChoice
}

export async function loadScene(id: string, base = ''): Promise<SceneSummary> {
  const [r, bm] = await Promise.all([fetch(`${base}/api/v1/scenes/${encodeURIComponent(id)}/manifest`), loadBasemap(base)])
  if (!r.ok) throw new Error(`读取场景清单失败：HTTP ${r.status}`)
  const m = (await r.json()) as RawManifest
  const bs = m.buildings_summary ?? {}
  const pct = bs.src_distribution_pct ?? {}
  const estimated = Object.entries(pct)
    .filter(([k]) => k.startsWith('est:'))
    .reduce((a, [, v]) => a + v, 0)
  return {
    id: m.aoi.id,
    name: m.aoi.name ?? m.aoi.id,
    bbox: m.aoi.bbox as [number, number, number, number],
    center: m.aoi.center as [number, number],
    extentKm: (m.aoi.extent_km ?? [0, 0]) as [number, number],
    buildings: {
      features: bs.features ?? 0,
      srcPct: pct,
      heightQ50: bs.height_m?.q50 ?? null,
      heightMax: bs.height_m?.max ?? null,
      estimatedPct: +estimated.toFixed(2),
    },
    basemapId: bm.id,
    basemapUrl: `${base}${bm.pmtiles_url}`,
    overviewUrl: bm.overview_url ? `${base}${bm.overview_url}` : null,
    overviewMaxZoom: bm.overview_maxzoom ?? null,
    demTiles: `${base}${bm.dem_tiles}`,
    buildingsUrl: `${base}/data/scene/${m.aoi.id}/buildings.geojson`,
    osmSnapshot: m.provenance?.osm_snapshot_of_tiles ?? null,
    attribution: m.provenance?.attribution ?? null,
  }
}
