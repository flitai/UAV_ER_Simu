// 枚举参数取值的中文名（卡片摘要与右栏下拉共用）。
//
// 此前界面直接把目录里的英文标识摆出来：方向图写 `omni`、极化写 `vertical`、
// 时延模式写 `tracking`、噪声估计写 `sliding`——这些是代码里的取值不是术语
// （用户 2026-09-21 指出：界面文字要用电磁与数字通信领域的专业表达）。
//
// 与 PARAM_LABELS 同一套办法、同一条边界：**这张表只管显示名**，不声明语义、不参与编译，
// 框图里写进去的永远是目录里的英文标识。单测读组件目录对拍，漏一个当场红。
//
// 键是「参数名.取值」。实测组件目录里只有 `window` 的四个取值跨组件出现，
// 而它在两处含义相同（FFT 窗函数），所以扁平表不会有歧义。

import type { ParamSpec } from '../api/catalog.js'

/** 这些参数的取值不翻译，理由各自写明。单测据此豁免。 */
export const KEEP_AS_IS: ReadonlySet<string> = new Set([
  'bits',         // 量化位数，取值就是数字
  'fir_version',  // 冻结抽头表的版本号（lp_v1 / pfb_v1 / rx_v1），是标识不是词
  'prop_level',   // E1 / E2 / E3 是 01 号文件定的精度档，界面另配「E1 快速抽象」式的长名
])

export const ENUM_LABELS: Readonly<Record<string, string>> = {
  // 天线
  'pattern.omni': '全向', 'pattern.directional': '定向',
  'pointing.fixed': '固定指向', 'pointing.heading': '随航向',
  'role.tx': '发射', 'role.rx': '接收',
  'polarization.horizontal': '水平', 'polarization.vertical': '垂直',
  'polarization.lhcp': '左旋圆极化', 'polarization.rhcp': '右旋圆极化',
  'polarization.slant45': '斜 45°',
  'peer_polarization.horizontal': '水平', 'peer_polarization.vertical': '垂直',
  'peer_polarization.lhcp': '左旋圆极化', 'peer_polarization.rhcp': '右旋圆极化',
  'peer_polarization.slant45': '斜 45°',

  // 信道施加
  'gain_mode.link_budget': '完整链路预算', 'gain_mode.path_loss_only': '仅传播损耗',
  'delay_mode.off': '不施加', 'delay_mode.fixed_at_start': '起始时刻定值',
  'delay_mode.tracking': '逐帧跟踪',

  // 传播效应
  'prop_primary.free_space': '自由空间', 'prop_primary.two_ray': '地面双径',
  'prop_primary.urban_empirical': '城市经验',
  'env_class.open': '开阔地', 'env_class.suburban': '郊区',
  'env_class.urban': '城区', 'env_class.dense_urban': '密集城区',
  'ground_type.water': '水面', 'ground_type.paved': '铺装地面',
  'ground_type.dirt': '裸土', 'ground_type.grass': '草地', 'ground_type.unknown': '未知',
  'urban_loss_mode.mean': '中值路径损耗', 'urban_loss_mode.mean_with_shadow_margin': '中值含阴影裕度',

  // 接收机与量化
  'noise_mode.none': '不注入', 'noise_mode.thermal': '热噪声',
  'rounding.nearest': '四舍五入',

  // 检测
  'noise_mode.probe': '起始帧定值', 'noise_mode.sliding': '滑动中值',

  // 特征与识别
  'bandwidth_method.occupied_99': '99% 占用带宽', 'bandwidth_method.edge_minus_20dB': '−20 dB 带边',
  'min_quality.full': '完整', 'min_quality.overload': '过载',
  'min_quality.short': '过短', 'min_quality.low_snr': '低信噪比',

  // 真值与评价
  'truth_source.scenario': '场景真值', 'truth_source.manifest': '数据清单',
  'truth_source.none': '不用真值',

  // 测向与定位
  'method.aoa': '测向交会', 'method.tdoa': '到达时差', 'method.aoa_tdoa': '测向时差联合',
  'method.amplitude_compare': '比幅测向', 'method.interferometer': '干涉仪测向',
  'weighting.correlated_reference': '参考站相关加权', 'weighting.independent_pairs': '站对独立加权',
  'reference_station_rule.best_snr': '信噪比最高站', 'reference_station_rule.first': '首站',

  // FFT 窗函数
  'window.rect': '矩形窗', 'window.hann': '汉宁窗',
  'window.hamming': '汉明窗', 'window.blackman': '布莱克曼窗',

  // 场景里的设备字段（deviceFields.ts 的 options，不在组件目录里）
  'sync_state.locked': '已锁定', 'sync_state.holdover': '保持', 'sync_state.unsynced': '未同步',
}

/** 枚举取值的显示名；没有登记的退回原始标识（与 paramLabel 同一条退路）。 */
export function enumLabel(paramName: string, value: unknown): string {
  const v = String(value)
  return ENUM_LABELS[`${paramName}.${v}`] ?? v
}

/** 布尔量写成「是 / 否」，不写 true / false——后者是代码里的字面量，不是界面用语。 */
export function boolLabel(v: boolean): string { return v ? '是' : '否' }

/** 参数取值的显示名：枚举查表，布尔写「是 / 否」，其余原样。`ps` 缺席时只按值的类型判断。 */
export function valueLabel(ps: ParamSpec | undefined, value: unknown): string {
  if (ps?.enum && ps.enum.length > 0) return enumLabel(ps.name, value)
  if (typeof value === 'boolean') return boolLabel(value)
  return String(value)
}
