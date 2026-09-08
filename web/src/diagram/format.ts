// 参数值的工程计数法显示与解析（09 §12、§6.6）。
// 输入接受 `2.44G`、`20M`、`1e6`，底层一律存 SI 基本单位。

// 一律按**十进制指数**构造数值，不做浮点乘除：`6.1 * 1e-6` 得 6.099999999999999e-6，
// 而 `Number('6.1e-6')` 是精确的。显示侧同理，先取 toExponential 再移小数点。

const PREFIX: Array<[string, number]> = [
  ['T', 12], ['G', 9], ['M', 6], ['k', 3],
  ['m', -3], ['µ', -6], ['n', -9], ['p', -12],
]
/** 输入时额外接受的等价写法。 */
const ALIAS: Record<string, string> = { K: 'k', u: 'µ' }

/** 解析工程计数法输入。返回 null 表示不是合法数值。 */
export function parseEng(raw: string): number | null {
  const t = raw.trim().replace(/\s+/g, '')
  if (!t) return null
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([TGMkKmuµnp]?)$/.exec(t)
  if (!m) return null
  const mant = m[1]!
  if (!Number.isFinite(Number(mant))) return null
  const sym = m[2] ? (ALIAS[m[2]] ?? m[2]) : ''
  if (!sym) return Number(mant)
  const f = PREFIX.find(([p]) => p === sym)
  if (!f) return null
  // 指数相加而不是乘以 10^exp，避免 6.1 * 1e-6 这类误差
  return Number(`${mant}e${f[1]}`)
}

/** 按工程计数法显示，三到四位有效数字（09 §12）。单位单独给，不并进字符串。 */
export function formatEng(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (v === 0) return '0'
  const [mant, expStr] = v.toExponential(9).split('e')
  const e = Number(expStr)
  let pick: [string, number] | null = null
  for (const f of PREFIX) if (e >= f[1] && e - f[1] < 3) { pick = f; break }
  const exp = pick ? pick[1] : 0
  const scaled = Number(`${mant}e${e - exp}`)
  return trim(scaled) + (pick ? ' ' + pick[0] : '')
}

function trim(v: number): string {
  const a = Math.abs(v)
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)
  // 只在有小数点时去尾零，否则 "500" 会被削成 "5"
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/** 节点卡片上的参数摘要：挑最能说明该节点在做什么的一两项。 */
export function summarize(params: Record<string, unknown>, unitOf: (k: string) => string | undefined): string[] {
  const KEY_ORDER = [
    'center_frequency_Hz', 'offset_Hz', 'level_dBm', 'power_dBm', 'amplitude', 'power',
    'data_id', 'scenario_id', 'distance_m', 'nfft', 'band_lo_Hz', 'sample_rate_Hz',
  ]
  const out: string[] = []
  for (const k of KEY_ORDER) {
    if (!(k in params)) continue
    const v = params[k]
    const u = unitOf(k)
    if (typeof v === 'number') out.push(`${formatEng(v)}${u ? ' ' + u : ''}`.replace(/  +/g, ' '))
    else if (typeof v === 'string') out.push(v)
    if (out.length >= 2) break
  }
  return out
}
