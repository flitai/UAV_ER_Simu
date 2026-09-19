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
/**
 * 时长按量级选单位（µs / ms / s）。`fmtDelay` 恒用 µs 是给到达时间差用的（那是 ns–µs 量级），
 * 发现时延是 ms 量级，写成 14656.0 µs 读不出来。
 */
export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—'
  const a = Math.abs(s)
  if (a >= 1) return `${s.toFixed(3)} s`
  if (a >= 1e-3) return `${(s * 1e3).toFixed(1)} ms`
  return `${(s * 1e6).toFixed(1)} µs`
}

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

/**
 * ISO 时刻 → 本地时刻（U-4，D-075）。`timeZone` 可注入只为让单测能钉住一个时区——
 * 不注入的话这个函数的结果跟着跑测试那台机器的时区走，换台机器就红。
 * 解析不出来返回「—」，不拿当下时刻顶替（铁律 15）。
 */
export function fmtInstant(iso: string | null | undefined, opts: { timeZone?: string } = {}): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  const p = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: opts.timeZone,
  }).formatToParts(d)
  const g = (k: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === k)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`
}

/** ISO 时刻 → 「3 分钟前」。`now` 可注入。未来时刻按「刚刚」，不写负数。 */
export function fmtAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.floor((now - t) / 1000)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d} 天前` : `${Math.floor(d / 30)} 个月前`
}
