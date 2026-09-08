// 组件目录的类型与查询（09 §6，docs/component-catalog.md）。
//
// 目录是引擎 `cuav_run --catalog` 的输出，经 GET /api/v1/components 到前端。**画布不另存一份规则**：
// 组件有哪些、参数什么单位范围、哪两个端口能连、连不上的理由，全部只从这里查（08 报告 §4.4）。
// 所以画布、服务端与引擎三处的校验不可能不一致。

export type PortType =
  | 'IQStream' | 'SceneParamFrame' | 'ChannelPathSet'
  | 'SpectrumFrame' | 'DetectionList' | 'FeatureVector' | 'RecognitionList'

export type Category = 'source' | 'channel' | 'antenna' | 'receiver' | 'data' | 'algorithm'

export interface ParamSpec {
  name: string
  type: 'number' | 'string' | 'enum' | 'bool'
  unit?: string
  min?: number
  max?: number
  default?: number | string | boolean | null
  enum?: string[]
  required?: boolean
  internal?: boolean
  excludes?: string[]
  description?: string
  constraint?: string
}

/** `optional` 只在为真时出现在目录里：未连线的可选输入口不算悬空，组件用自身参数顶替（D-051）。 */
export interface PortSpec { name: string; type: PortType; optional?: boolean }

export interface DynamicPorts { pattern: string; source: string; type: PortType }

export interface ComponentSpec {
  type: string
  display_name: string
  category: Category
  model_id: string
  model_layer: string
  model_level: string
  version: string
  description?: string
  implementation?: string
  scene_bindable?: boolean
  stateful?: boolean
  dynamic_ports?: DynamicPorts
  ports: { in?: PortSpec[]; out?: PortSpec[] }
  params: ParamSpec[]
}

/** `port_compat` 的一条：[from, to, ok] 或 [from, to, false, 理由]。 */
export type CompatRow = [PortType, PortType, boolean, string?]

export interface Catalog {
  schema_version: string
  engine_version: string
  port_types: PortType[]
  port_compat: CompatRow[]
  components: ComponentSpec[]
}

/** 六类的中文名与顺序（04 §8.1）。C-2 之后六类都有组件（D-051）；空分组仍要显示（09 §6.3）。 */
export const CATEGORIES: ReadonlyArray<{ key: Category; label: string }> = [
  { key: 'source', label: '辐射源' },
  { key: 'channel', label: '信道' },
  { key: 'antenna', label: '天线' },
  { key: 'receiver', label: '接收机' },
  { key: 'data', label: '数据' },
  { key: 'algorithm', label: '算法' },
]

/** 类别色（09 §6.3，浅色底上实算对比度不低于 4.45:1）。 */
export const CATEGORY_COLOR: Readonly<Record<Category, string>> = {
  source: '#1e40af',
  channel: '#7c2d12',
  antenna: '#0f766e',
  receiver: '#6d28d9',
  data: '#334155',
  algorithm: '#15803d',
}

/** 端口把手形状按类型区分，不只靠颜色（09 §6.3，色弱可辨）。 */
export const PORT_SHAPE: Readonly<Record<PortType, 'circle' | 'diamond' | 'square' | 'triangle'>> = {
  IQStream: 'circle',
  SceneParamFrame: 'diamond',
  ChannelPathSet: 'diamond',
  SpectrumFrame: 'square',
  DetectionList: 'triangle',
  FeatureVector: 'square',
  RecognitionList: 'triangle',
}

export function isCatalog(v: unknown): v is Catalog {
  if (!v || typeof v !== 'object') return false
  const c = v as Partial<Catalog>
  return Array.isArray(c.components) && Array.isArray(c.port_compat) && Array.isArray(c.port_types)
}

export function findComponent(cat: Catalog, type: string): ComponentSpec | null {
  return cat.components.find((c) => c.type === type) ?? null
}

/** 按目录顺序分组；空分组也返回，由界面标「本期无组件」。 */
export function byCategory(cat: Catalog): Array<{ key: Category; label: string; items: ComponentSpec[] }> {
  return CATEGORIES.map(({ key, label }) => ({
    key, label,
    items: cat.components.filter((c) => c.category === key),
  }))
}

export interface CompatVerdict { ok: boolean; reason: string }

/**
 * 两个端口类型能否相连。**判据只查目录的 port_compat**，画布不复制规则（09 §6.5）。
 * 不兼容时把目录给的理由原样带出；目录里查不到该对（理论上不会，49 条是全枚举）时保守拒绝。
 */
export function canConnect(cat: Catalog, from: PortType, to: PortType): CompatVerdict {
  for (const row of cat.port_compat) {
    if (row[0] === from && row[1] === to) {
      return { ok: row[2] === true, reason: row[2] === true ? '' : (row[3] ?? '端口类型不兼容') }
    }
  }
  return { ok: false, reason: `目录里没有 ${from} → ${to} 的兼容项` }
}

/**
 * 在目录理由之外补一句可操作建议（09 §6.5）。这是显示层的便利，不改变判据本身。
 * IQ 流与参数流不得直连是本系统最容易被误解的规则（D-013），单独给建议。
 */
export function connectionHint(from: PortType, to: PortType): string {
  const param = (t: PortType) => t === 'SceneParamFrame' || t === 'ChannelPathSet'
  if (from === 'IQStream' && param(to)) return '请在两者之间放置一个施加类组件，例如场景绑定信道'
  if (param(from) && to === 'IQStream') return '参数流要经施加类组件作用到 IQ 上，不能直接接进 IQ 输入口'
  if (from === to) return ''
  return '两端类型必须相同；需要跨类型时由显式组件承担'
}
