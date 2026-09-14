// 识别标签的色与名（C-9 / V-8）。一份表三处用：检测识别页签的时间线第三行、突发表、信号页瀑布的时频框。
//
// 判据与地图那批色值（display-route.md §4，D2-4 的 3:1）**分两条**，缘由：这些框画在 viridis 瀑布上，
// 背景从深蓝到亮黄整条都有，任何一个颜色都不可能对整条色带都达到 3:1。所以
//   ① **边界的可见性**不靠类别色，靠白 + 墨两道描边——十个 viridis 锚点上 max(白, 墨) 最低 3.33:1（过 3:1）；
//   ② **类别色**量的是标签文字对它自己那块浅色底衬（renderer 的 rgba(250,248,245,0.92) 片压在 viridis 上）
//      的对比度，按 WCAG 文字的 4.5:1 量，十个锚点上最低 5.37:1。
// 两条的实测值都记在 docs/display-route.md §4。颜色从来不是唯一线索：框上写标签名，表里也有（09 §12）。
//
// 标签集来自 models/recognition/library-v1.json（signal_role 层，取值 assumed）+ 开放集的 unknown。
// 库外标签（例如清单派生的 noise）落到 other 那一档——不为没见过的标签编颜色。

export interface LabelStyle {
  /** 中文短名：突发表与时间线上写它 */
  text: string
  /** 描边与文字色 */
  color: string
}

const KNOWN: Record<string, LabelStyle> = {
  video_link: { text: '图传', color: '#1d4ed8' },
  telemetry_burst: { text: '遥测', color: '#854d0e' },
  rc_hopping: { text: '遥控', color: '#6d28d9' },
  cw_beacon: { text: '信标', color: '#115e59' },
  noise: { text: '噪声', color: '#57534e' },
  unknown: { text: '未知', color: '#a33333' },
}

/** 库外标签与没有识别行的段：灰，不编颜色 */
export const OTHER_LABEL: LabelStyle = { text: '其它', color: '#57534e' }
/** 没有识别行的检测段（识别器未接、或该段没出识别行）：保持 C-3 的红框 */
export const UNRECOGNIZED: LabelStyle = { text: '', color: '#a33333' }

export function labelStyle(label: string | null | undefined): LabelStyle {
  if (!label) return UNRECOGNIZED
  return KNOWN[label] ?? { text: label, color: OTHER_LABEL.color }
}

/** 标签的中文短名；库外标签原样返回（不翻译没见过的东西） */
export function labelText(label: string | null | undefined): string {
  return label ? (KNOWN[label]?.text ?? label) : ''
}
