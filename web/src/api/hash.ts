// Idempotency-Key：框图文本的 sha-256 加时间戳（09 附录 A.2）。127.0.0.1 与 localhost 算安全上下文，
// crypto.subtle 可用；没有时退到 FNV-1a，只求同一文本同一键。

export function fnv1a32(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export async function sha256hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function idempotencyKey(text: string, now: () => number = Date.now): Promise<string> {
  const h = (await sha256hex(text)) ?? fnv1a32(text)
  return `${h}-${now()}`
}
