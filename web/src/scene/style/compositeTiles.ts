// 区域底图 + 全球概览合成一个矢量数据源（D-084 补充）。
//
// 交付包只带北京区域底图（zoom 0–15）与一份全球概览（zoom 0–6，约 45 MB）。两份都从同一份
// planet.pmtiles 同一 OSM 快照抽出，zoom ≤ 6 的瓦片在北京范围内逐字节相同，所以合成规则只有一条：
//   zoom ≤ 概览最高层级 → 取概览；否则 → 取区域底图（区域外没有就是空白，照实显示）。
//
// 为什么不在样式里挂两个数据源：底图 60 层每层都绑 `source: 'pm'`，挂两个就得把 60 层复制一份，
// 样式与 Airports 黄金基准逐层对照就失效了（D-017）。这里改的只是 `pm` 这一个数据源的地址。
// 为什么不用 pmtiles 自带的 Protocol：它按归档头部的 bounds 出 TileJSON，区域归档的 bounds 是
// 北京外包框，MapLibre 根本不会去请求框外的瓦片，概览就补不上。
//
// 地址：`cuavpm://<键>` 是 TileJSON，`cuavpm://<键>/{z}/{x}/{y}` 是瓦片。

import maplibregl from 'maplibre-gl'
import { PMTiles } from 'pmtiles'

export interface CompositeSpec {
  /** 区域底图（zoom 0–15）的地址 */
  regionalUrl: string
  /** 全球概览（zoom 0–overviewMaxZoom）的地址 */
  overviewUrl: string
  overviewMaxZoom: number
  maxzoom: number
}

/** 纯函数：瓦片该从哪一份取。单测对它。 */
export function pickArchive(z: number, overviewMaxZoom: number): 'overview' | 'regional' {
  return z <= overviewMaxZoom ? 'overview' : 'regional'
}

/** 纯函数：解析 `cuavpm://` 地址。 */
export function parseCompositeUrl(url: string): { key: string; zxy: [number, number, number] | null } | null {
  const m = /^cuavpm:\/\/([a-z0-9-]+)(?:\/(\d+)\/(\d+)\/(\d+))?$/.exec(url)
  if (!m) return null
  return { key: m[1]!, zxy: m[2] === undefined ? null : [Number(m[2]), Number(m[3]), Number(m[4])] }
}

const registry = new Map<string, { spec: CompositeSpec; regional: PMTiles; overview: PMTiles }>()
let installed = false

/** 登记一份合成数据源，返回样式里 `pm` 数据源该用的地址。同一个键重复登记即覆盖。 */
export function registerComposite(key: string, spec: CompositeSpec): string {
  registry.set(key, { spec, regional: new PMTiles(spec.regionalUrl), overview: new PMTiles(spec.overviewUrl) })
  if (!installed) {
    maplibregl.addProtocol('cuavpm', async (params, abort) => {
      const p = parseCompositeUrl(params.url)
      const e = p ? registry.get(p.key) : undefined
      if (!p || !e) throw new Error(`未登记的合成底图：${params.url}`)
      if (!p.zxy) {
        return {
          data: {
            tilejson: '3.0.0',
            tiles: [`cuavpm://${p.key}/{z}/{x}/{y}`],
            minzoom: 0,
            maxzoom: e.spec.maxzoom,
            // 全球范围：让 MapLibre 在北京框外也去要 zoom ≤ 6 的瓦片
            bounds: [-180, -85.0511, 180, 85.0511],
          },
        }
      }
      const [z, x, y] = p.zxy
      const src = pickArchive(z, e.spec.overviewMaxZoom) === 'overview' ? e.overview : e.regional
      const r = await src.getZxy(z, x, y, abort.signal)
      // 归档里没有这块（区域底图框外的高层级）：空瓦片，与 pmtiles 自带协议的处理一致
      return { data: r ? new Uint8Array(r.data) : new Uint8Array() }
    })
    installed = true
  }
  return `cuavpm://${key}`
}
