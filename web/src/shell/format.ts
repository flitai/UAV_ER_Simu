// 工程计数法与坐标格式（09 §12）。

export function fmtSeconds(t: number): string {
  if (!Number.isFinite(t)) return '—'
  if (t < 1) return `${(t * 1000).toFixed(0)} ms`
  if (t < 100) return `${t.toFixed(1)} s`
  return `${t.toFixed(0)} s`
}

export function fmtFactor(f: number | null): string {
  if (f === null || !Number.isFinite(f)) return '×—'
  return f >= 10 ? `×${f.toFixed(0)}` : `×${f.toFixed(1)}`
}

export function fmtHz(f: number): string {
  const a = Math.abs(f)
  if (a >= 1e9) return `${(f / 1e9).toFixed(4).replace(/\.?0+$/, '')} GHz`
  if (a >= 1e6) return `${(f / 1e6).toFixed(3).replace(/\.?0+$/, '')} MHz`
  if (a >= 1e3) return `${(f / 1e3).toFixed(1).replace(/\.?0+$/, '')} kHz`
  return `${f.toFixed(0)} Hz`
}

export function fmtLngLat(lng: number, lat: number): string {
  return `${Math.abs(lng).toFixed(5)}°${lng >= 0 ? 'E' : 'W'} ${Math.abs(lat).toFixed(5)}°${lat >= 0 ? 'N' : 'S'}`
}

export function fmtInt(n: number): string { return n.toLocaleString('en-US') }

/** dB 读数：一位小数，非有限给「—」。 */
export function fmtDb(v: number | null | undefined, unit = 'dB'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${v.toFixed(1)} ${unit}`
}

/** 带符号的差值读数（Δ）。 */
export function fmtDelta(v: number | null | undefined, fmt: (x: number) => string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))}`
}

/** 距离：小于 1 km 用米，否则用千米（09 §12 工程计数法）。 */
export function fmtMeters(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—'
  return Math.abs(m) < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`
}

/** 角度，一位小数带度号。 */
export function fmtDeg(d: number | null | undefined): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return '—'
  return `${d.toFixed(1)}°`
}

/** 时延：秒太小，一律用微秒。 */
export function fmtDelay(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—'
  return `${(s * 1e6).toFixed(1)} µs`
}

/**
 * 解析带 SI 前缀的输入（09 §5.3：输入接受 `2.44G`、`20M`，底层存 SI 基本单位）。
 * 认不出来返回 null——不拿 0 顶替（铁律 15）。
 */
export function parseSi(text: string): number | null {
  const m = /^\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([kKMGmuµn]?)\s*$/.exec(text)
  if (!m) return null
  const v = Number(m[1])
  if (!Number.isFinite(v)) return null
  const mul: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9 }
  return v * (mul[m[2]] ?? 1)
}
