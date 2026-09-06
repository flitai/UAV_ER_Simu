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
