// Airports 浅色底图的配色表与标注字段，逐字节照搬（决策 D-017）。
// 来源：/Users/zhiyu/CC/Airports/index.html 第 790 行起的 `PM` 表（本方自有代码）。
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

/** 底图标注的名称字段：优先中文，回落到通用名与英文。 */
export const PM_NAME = ['coalesce', ['get', 'name:zh-Hans'], ['get', 'name'], ['get', 'name:en']]

/**
 * 本地只内嵌了 Noto Sans Regular（拉丁 0-255，无粗体），中日韩字符交给
 * `localIdeographFontFamily` 在客户端渲染。所以标注层级只能靠字号、颜色、光晕区分，
 * 不能用字重。
 */
export const PM_FONT = ['Noto Sans Regular']
