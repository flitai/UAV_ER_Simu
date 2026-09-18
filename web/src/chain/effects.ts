// 传播效应清单的派生（12 号报告 §2.3、§5.1；决策 D-058）。
//
// 这里算的是**用户选了哪几项**，不是物理——物理在 `geo/propagation.cpp`。
// 两侧共用同一张表：C++ 的 `combine()` 按同样的规则填 `included_loss_terms`，
// 单测 `effects.test.ts` 把这张表钉住，改一侧另一侧的测试就会红。
//
// 卡片上只写这一档包含哪几项（用户 2026-09-10 拍板第 ①条），逐项开关在右栏。

import type { ParamValue } from '../diagram/doc.js'

/** 与 `geo/propagation.h` 的 `kTerm*` 逐字对应，顺序也一致。 */
export type LossTerm = 'free_space' | 'ground_reflection' | 'urban_mean' | 'diffraction' | 'shadow' | 'weather'

export const TERM_LABEL: Readonly<Record<LossTerm, string>> = {
  free_space: '自由空间',
  ground_reflection: '地面双径',
  urban_mean: '城市经验',
  diffraction: '建筑遮挡',
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
  // 建筑遮挡是**加项不是替代型主模型**，所以 free_space（乃至 ground_reflection）照旧在；
  // 而且 E3 档每帧都声明，与这一帧恰好挡没挡住无关（07 §14ter.3）。
  const terms: LossTerm[] = ['free_space']
  const on = level !== 'E1'
  if (on && primary === 'two_ray') terms.push('ground_reflection')
  if (on && primary === 'urban_empirical') terms.push('urban_mean')
  if (level === 'E3') terms.push('diffraction')
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
  // 闸三与闸四（07 报告 §5.2，D-074 ⑥）：E3 已按建筑几何确定性地算出遮挡损耗，
  // 统计阴影与城市经验都是**同一效应的统计等效**，同时开即同源双计（EM-P-13 §10.9）。
  // 报文与引擎 `PropagationConfig::validate()` 的两条逐句对齐——前端先说、引擎兜底，
  // 界面拦不住手写的框图（铁律 15）。
  //
  // D3-6 之前这里还拦着整个 E3（浏览器算不出同样的数）。**那条自 D3-7 起撤掉**：
  // `web/src/scene/occlusion/` 的复算与 C++ 同守 148 例 + 真实建筑集五条射线，
  // 场景页的视距探测走的就是它，预览与跑出来的结果不再对不上。
  if (v.level === 'E3' && v.shadow) {
    return 'E3 已按建筑几何确定性地算出遮挡损耗，统计阴影（EM-P-08）是同一效应的统计等效，'
      + '同时开即同源双计；请关掉统计阴影，或把档位降回 E2'
  }
  if (v.level === 'E3' && v.primary === 'urban_empirical') {
    return 'E3 已按建筑几何确定性地算出遮挡损耗，城市经验（EM-P-05）的路损指数与环境偏置'
      + '本身就是建筑密度的经验拟合，同时开即同源双计；E3 下主模型只能选自由空间或地面双径'
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
