// Airports 浅色底图的配色表与标注字段，逐字节照搬（决策 D-017）。
// 来源：Airports 工程 `index.html` 第 790 行起的 `PM` 表（本方自有代码，位置见 CLAUDE.md 资源清单）。
// **不得改动任何色值**：任何视觉偏离都要先记一条决策（CLAUDE.md 地理场景一节）。

export const PM = {
  paper: '#f4f1ec', earth: '#faf8f5',
  water: '#c9dced', waterInk: '#5d87a3',
  green: '#e3ebdd', park: '#d9e8d1', wood: '#d5e2cc', sand: '#f0e8d6',
  wet: '#dbe6e1', ice: '#eef4f8',
  built: '#efece7', inst: '#eae6de', sport: '#dfead9', grave: '#e1e7db',
  road: '#ffffff', roadCase: '#e0dbd3',
  major: '#fdf6e3', majorCase: '#e8ddc0',
  motor: '#fbe6bf', motorCase: '#dfbe83',
  rail: '#dcd6cc', railCase: '#c6bfb3',
  aero: '#e8e6ef', aeroCase: '#cfccdd', apron: '#efeef4',
  bldg: '#e6e1da', bldgCase: '#d8d2c9',
  bound: '#c3bcb2', ink: '#48423a', dim: '#7b7367', poi: '#8b8173', halo: '#ffffff',
} as const

/**
 * 底图色表的完整键：`PM` 的键加上 Airports 原文里直接写在图层上的六个色值
 * （人行道虚线、滑行道、跑道、铁路虚线、国界、机场标注）。浅色那一套见 protomaps.ts 的 `BASEMAP_LIGHT`。
 */
export type BasemapPalette = { [K in keyof typeof PM]: string } & {
  path: string; taxiway: string; runway: string; railDash: string; boundCountry: string; aeroLabel: string
}

/**
 * 深色底图色表（D-078，用户 2026-09-26「浅色和深色共存，可以切换」）。
 * 观感取 em-demo 的深色控制台（底 #0a0e17、面板 #111827、建筑 #1a2332），但**色值是手写的**，
 * 不引 `protomaps-themes-base`（D-017 那半条仍有效）；键与浅色表一一对应，所以只换颜色、
 * 图层与压盖顺序一概不动。与浅色表一样，任何改动先记决策。
 */
export const PM_DARK: BasemapPalette = {
  paper: '#0a0e17', earth: '#0e131d',
  water: '#0b2233', waterInk: '#5b9cc4',
  green: '#101d17', park: '#11211a', wood: '#0f1c15', sand: '#1a1912',
  wet: '#0e1c1c', ice: '#141c26',
  built: '#111722', inst: '#131a25', sport: '#11201a', grave: '#121a17',
  road: '#1f2939', roadCase: '#0a0e17',
  major: '#27334a', majorCase: '#0c111a',
  motor: '#3a4763', motorCase: '#0c111a',
  rail: '#29334a', railCase: '#0c111a',
  aero: '#161a29', aeroCase: '#232a3e', apron: '#151a27',
  bldg: '#1a2332', bldgCase: '#243044',
  bound: '#3a475c', ink: '#cbd5e1', dim: '#8391a7', poi: '#6b7a90', halo: '#0a0e17',
  path: '#1a2230', taxiway: '#1e2536', runway: '#2b3549', railDash: '#0e131d', boundCountry: '#4a5870', aeroLabel: '#9a95b5',
}

/** 底图标注的名称字段：优先中文，回落到通用名与英文。 */
export const PM_NAME = ['coalesce', ['get', 'name:zh-Hans'], ['get', 'name'], ['get', 'name:en']]

/**
 * 本地只内嵌了 Noto Sans Regular（拉丁 0-255，无粗体），中日韩字符交给
 * `localIdeographFontFamily` 在客户端渲染。所以标注层级只能靠字号、颜色、光晕区分，
 * 不能用字重。
 */
export const PM_FONT = ['Noto Sans Regular']
