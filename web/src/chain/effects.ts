// 传播效应清单的派生（12 号报告 §2.3、§5.1；决策 D-058）。
//
// 这里算的是**用户选了哪几项**，不是物理——物理在 `geo/propagation.cpp`。
// 两侧共用同一张表：C++ 的 `combine()` 按同样的规则填 `included_loss_terms`，
// 单测 `effects.test.ts` 把这张表钉住，改一侧另一侧的测试就会红。
//
// 卡片上只写这一档包含哪几项（用户 2026-09-10 拍板第 ①条），逐项开关在右栏。

import type { ParamValue } from '../diagram/doc.js'

/** 与 `geo/propagation.h` 的 `kTerm*` 逐字对应，顺序也一致。 */
export type LossTerm = 'free_space' | 'ground_reflection' | 'urban_mean' | 'shadow' | 'weather'

export const TERM_LABEL: Readonly<Record<LossTerm, string>> = {
  free_space: '自由空间',
  ground_reflection: '地面双径',
  urban_mean: '城市经验',
  shadow: '统计阴影',
  weather: '大气降雨',
}

export type PropLevel = 'E1' | 'E2' | 'E3'
export type PrimaryModel = 'free_space' | 'two_ray' | 'urban_empirical'
export type EnvClass = 'open' | 'suburban' | 'urban' | 'dense_urban'

export const LEVEL_LABEL: Readonly<Record<PropLevel, string>> = {
  E1: 'E1 快速抽象',
  E2: 'E2 工程',
  E3: 'E3 精细机理',
}

export const ENV_LABEL: Readonly<Record<EnvClass, string>> = {
  open: '开阔地',
  suburban: '郊区',
  urban: '城区',
  dense_urban: '密集城区',
}

/** E3 待 D3（切片 ⑤）。**枚举里保留、界面置灰**——隐藏会让人以为这条链只有两档。 */
export const LEVEL_UNAVAILABLE: Readonly<Partial<Record<PropLevel, string>>> = {
  E3: '待 D3（切片 ⑤）接入建筑遮挡与刀口绕射',
}

export interface PropView {
  level: PropLevel
  primary: PrimaryModel
  env: EnvClass
  shadow: boolean
  weather: boolean
  urbanMargin: boolean
  /** 这一档实际包含哪几类损耗，顺序与 `geo/propagation.cpp` 的 `included` 一致 */
  terms: LossTerm[]
  /** 卡片上写的一行 */
  text: string
}

function pickText<T extends string>(v: ParamValue | undefined, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def
}

function pickBool(v: ParamValue | undefined, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def
}

const LEVELS: readonly PropLevel[] = ['E1', 'E2', 'E3']
const PRIMARIES: readonly PrimaryModel[] = ['free_space', 'two_ray', 'urban_empirical']
const ENVS: readonly EnvClass[] = ['open', 'suburban', 'urban', 'dense_urban']

/**
 * 从传播信道槽位的参数里读出当前的档位与效应。缺省与 `ScenarioSource` 的 `ParamSpec` 一致：
 * E1 / free_space / 不开阴影不开天气 / urban / mean。
 */
export function propView(params: Record<string, ParamValue>): PropView {
  const level = pickText(params.prop_level, LEVELS, 'E1')
  const primary = pickText(params.prop_primary, PRIMARIES, 'free_space')
  const env = pickText(params.env_class, ENVS, 'urban')
  const shadow = pickBool(params.prop_shadow, false)
  const weather = pickBool(params.prop_weather, false)
  const urbanMargin = pickText(params.urban_loss_mode,
                               ['mean', 'mean_with_shadow_margin'] as const, 'mean')
                      === 'mean_with_shadow_margin'

  // 与 C++ 的 combine() 同一套规则：E1 只有自由空间；替代型主模型至多一个；
  // 城市经验带分位裕度时它自己也算含 shadow（闸二就是据此拦的）。
  const terms: LossTerm[] = ['free_space']
  const on = level !== 'E1'
  if (on && primary === 'two_ray') terms.push('ground_reflection')
  if (on && primary === 'urban_empirical') terms.push('urban_mean')
  if (on && (shadow || (primary === 'urban_empirical' && urbanMargin))) terms.push('shadow')
  if (on && weather) terms.push('weather')

  const head = !on
    ? TERM_LABEL.free_space
    : primary === 'two_ray' ? TERM_LABEL.ground_reflection
    : primary === 'urban_empirical' ? `${TERM_LABEL.urban_mean}（${ENV_LABEL[env]}）`
    : TERM_LABEL.free_space
  const rest = terms.filter((t) => t !== 'free_space' && t !== 'ground_reflection' && t !== 'urban_mean')
  const text = `${level} · ${head}${rest.length ? ' + ' + rest.map((t) => TERM_LABEL[t]).join(' + ') : ''}`

  return { level, primary, env, shadow, weather, urbanMargin, terms, text }
}

/**
 * 右栏里这一档该显示哪几个参数（12 §5.2）。**不禁用、直接不渲染**：
 * 十五行参数一次全摆出来，用户找不到刚才改的那一项。
 */
export function visiblePropParams(v: PropView): string[] {
  const out = ['prop_level']
  if (v.level === 'E1') return out           // E1 只算自由空间，别的都不适用
  out.push('prop_primary', 'prop_shadow', 'prop_weather', 'env_class')
  if (v.primary === 'two_ray') {
    out.push('ground_type', 'ground_roughness_m', 'coherence_rho', 'max_fade_depth_dB')
  }
  if (v.primary === 'urban_empirical') {
    out.push('path_loss_exponent', 'ref_distance_m', 'urban_loss_mode')
  }
  if (v.shadow) out.push('shadow_sigma_dB', 'shadow_corr_distance_m')
  if (v.weather) out.push('rain_rate_mmh')
  return out
}

/**
 * 与引擎 `PropagationConfig::validate()` 同一份表的前端一侧（12 §4.4、§2.2）。
 * 返回不通过的理由，通过时返回 null。**报文与引擎的措辞对齐**，免得出现前端放行、引擎拒绝。
 *
 * 原先这里还有第四条，拦「自由空间（定参）信道 + 高档位」——那个变体不吃场景参数帧，
 * 算出来的附加损耗不会被施加，只会让链路读数名不副实。D-059 把该变体从框图页撤掉之后，
 * 这条判据无人可达，随之删掉：风险从源头消除，比留一道拦它的闸干净（同 D-057 的处置）。
 */
export function propConflict(v: PropView): string | null {
  // **引擎自 D3-5（2026-09-18）起已经支持 E3**：建筑几何进了帧生产端，视距由它给出、
  // 刀口损耗进 extra_loss_dB。这里仍然拦着，拦的不是引擎算不算得出来，而是**浏览器这一侧
  // 还复算不出同样的数**——场景页的链路预览、覆盖叠加都还是自由空间，放开 E3 会让预览与
  // 跑出来的结果对不上（D3-6 补浏览器侧的 TS 复算，D3-7 才去置灰）。
  // 报文照实说，不写成「引擎待接入」——那句话现在是假的。
  if (v.level === 'E3') {
    return 'E3（建筑遮挡与刀口绕射）引擎已经支持，但浏览器这一侧还没有同源的遮挡复算，'
      + '放开会让画面上的预览与实际跑出来的结果对不上；暂请选 E1 或 E2'
  }
  if (v.level === 'E1' && (v.primary !== 'free_space' || v.shadow || v.weather)) {
    return 'E1 档只算自由空间路损、多普勒与时延；要用双径 / 城市经验 / 阴影 / 天气请把档位改为 E2'
  }
  if (v.shadow && v.primary === 'urban_empirical' && v.urbanMargin) {
    return '城市经验取「均值 + 分位裕度」时已含 90% 分位阴影，再开统计阴影即同源双计'
      + '（EM-P-13 §10.9）；请把 urban_loss_mode 改回 mean，或关掉统计阴影'
  }
  return null
}
