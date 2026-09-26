// 浅色 / 深色主题（D-078）。缺省浅色（Airports 底图，D-017）；深色取 em-demo 的深色观感。
//
// 主题是**每个浏览者自己的便利**，不是数据：存 localStorage（读写都包 try/catch，隐私窗口里可能抛），
// 不进主 store、不进任务、不进框图。地址栏 `?theme=dark|light` 优先于存着的偏好——端到端靠它
// 不受这台机器上一次选了什么的影响。
//
// 生效方式只有一处：`<html data-theme="…">`。CSS 令牌按它切换；画在 Canvas 与 MapLibre 里的颜色
// 不走 CSS，由各自的 apply 函数订阅本 store 重设（场景页的底图与态势层、信号页的画布）。

export type Theme = 'light' | 'dark'

const KEY = 'cuav.theme'
const subs = new Set<() => void>()

function fromUrl(): Theme | null {
  try {
    const v = new URLSearchParams(window.location.search).get('theme')
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null
  }
}

function fromStorage(): Theme | null {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null
  }
}

let theme: Theme = typeof window === 'undefined' ? 'light' : (fromUrl() ?? fromStorage() ?? 'light')

function apply(t: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = t
  document.documentElement.style.colorScheme = t
}

apply(theme)

export const themeStore = {
  get: (): Theme => theme,
  set(t: Theme): void {
    if (t === theme) return
    theme = t
    apply(t)
    try { window.localStorage.setItem(KEY, t) } catch { /* 存不下就只在本页生效 */ }
    for (const f of subs) f()
  },
  toggle(): void { themeStore.set(theme === 'dark' ? 'light' : 'dark') },
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f) } },
}

/**
 * 当前主题下某个 CSS 令牌的取值（画布用）。按主题缓存：getComputedStyle 每帧调代价不小，
 * 而令牌只在切换主题时变。
 */
const cache = new Map<string, string>()
let cachedFor: Theme | null = null
export function token(name: string, fallback = '#000000'): string {
  if (typeof document === 'undefined') return fallback
  if (cachedFor !== theme) { cache.clear(); cachedFor = theme }
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  cache.set(name, v)
  return v
}

/** #rrggbb 加不透明度 → rgba()。令牌一律写成 #rrggbb，这里不处理别的写法。 */
export function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  if (h.length !== 6) return hex
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`
}
