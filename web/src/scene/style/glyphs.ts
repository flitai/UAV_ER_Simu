// 离线字形协议。照搬 Airports index.html 第 726 行起的 registerGlyphs（决策 D-017）。
//
// MapLibre 取字形走 AJAX 请求。这里注册自定义协议，直接把 `public/vendor/glyphs.js` 里内嵌的
// base64 字形喂给它，交付环境因此不需要任何字形服务（铁律 6：运行不联网）。
//
// 字形数据来源与许可：Noto Sans Regular 生成的带符号距离场图集（拉丁 0-255），
// SIL Open Font License 1.1，见 web/public/vendor/THIRD-PARTY-NOTICES.md。

import maplibregl from 'maplibre-gl'
export { GLYPH_URL } from './constants.js'

declare global {
  interface Window {
    GLYPHS?: Record<string, Record<string, string>>
  }
}

let registered = false

/** 注册一次即可；重复调用无副作用。返回是否真的注册上（字形数据未加载时为 false）。 */
export function registerGlyphs(): boolean {
  if (registered) return true
  if (typeof window === 'undefined' || !window.GLYPHS) return false
  maplibregl.addProtocol('localglyphs', async (params) => {
    const m = /glyphs\/([^/]+)\/([^/]+)\.pbf/.exec(params.url)
    const stack = m ? decodeURIComponent(m[1]) : ''
    const range = m ? m[2] : ''
    const b64 = window.GLYPHS?.[stack]?.[range]
    if (!b64) return { data: new ArrayBuffer(0) } // 该区段无字形，静默留空
    const bin = atob(b64)
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    return { data: buf.buffer }
  })
  registered = true
  return true
}
