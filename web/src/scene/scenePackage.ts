// 场景数据包的读取。前端只认数据包清单 `manifest.json`，不硬编码任何路径或数字——
// 清单是数据包的入口（里程碑 D0-6），改了数据包前端自动跟随。

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
  basemapUrl: string
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

export async function loadScene(id: string, base = ''): Promise<SceneSummary> {
  const r = await fetch(`${base}/api/v1/scenes/${encodeURIComponent(id)}/manifest`)
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
    basemapUrl: `${base}/data/basemap/planet.pmtiles`,
    demTiles: `${base}/data/basemap/dem/{z}/{x}/{y}.png`,
    buildingsUrl: `${base}/data/scene/${m.aoi.id}/buildings.geojson`,
    osmSnapshot: m.provenance?.osm_snapshot_of_tiles ?? null,
    attribution: m.provenance?.attribution ?? null,
  }
}
