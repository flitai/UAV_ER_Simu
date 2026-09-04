// 样式模块共用的常量。单独成文件是为了让 protomaps.ts 不必依赖 maplibre-gl 运行时，
// 从而可以在 Node 里直接求值做黄金基准比对。
export const GLYPH_URL = 'localglyphs://glyphs/{fontstack}/{range}.pbf'
