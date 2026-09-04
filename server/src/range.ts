// 支持 HTTP Range 的文件读取。
//
// 为什么必须实现：PMTiles 通过 Range 请求按需读取瓦片。若服务端对 Range 请求返回整个文件，
// 底图会失效或极慢——本项目的底图是 137 GB 的整份全球文件（决策 D-022），每取一块瓦片回传
// 整个文件等于完全不可用。这是继承自既有项目的已知坑：Python 标准库的 `http.server`
// 对 Range 就是返回整文件。
//
// 参考实现：/Users/zhiyu/CC/Airports/serve.py 的 RangeHandler（本方自有代码）。
//
// 语义对齐 RFC 9110 §14：
//   - 单区间 `bytes=start-end`、开区间 `bytes=start-`、后缀区间 `bytes=-suffix`
//   - 越界返回 416 并带 `Content-Range: bytes */size`
//   - 不带 Range 的普通请求返回 200 与完整内容
//   - 一律返回 `Accept-Ranges: bytes`
//   - **多区间不支持**：与参考实现一致，形如 `bytes=0-9,20-29` 的请求按无 Range 处理，
//     返回 200 与完整内容。这是允许的降级（服务端可以忽略 Range），但必须显式写明，
//     不能让调用方以为拿到的是部分内容。
//
// 依据：04 §8.6；决策 D-003；docs/api-versions.md 第 2 节。

/** 单区间解析结果。`unsatisfiable` 表示语法合法但越界，应答 416。 */
export type RangeResult =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/

/**
 * 解析 Range 请求头。
 * @param header 请求头原文，缺省时传 undefined
 * @param size   文件字节数
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' }
  const m = SINGLE_RANGE.exec(header.trim())
  if (!m) return { kind: 'none' } // 多区间或语法不认识：按无 Range 处理，返回整文件
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return { kind: 'none' }

  if (rawStart === '') {
    // 后缀区间：最后 N 个字节。N 为 0 时无法满足。
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' }
    if (size === 0) return { kind: 'unsatisfiable' }
    const start = Math.max(0, size - suffix)
    return { kind: 'range', start, end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return { kind: 'unsatisfiable' }
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end }
}

/** 区间字节数。 */
export function rangeLength(r: { start: number; end: number }): number {
  return r.end - r.start + 1
}

/** `Content-Range` 响应头的值。 */
export function contentRange(r: { start: number; end: number }, size: number): string {
  return `bytes ${r.start}-${r.end}/${size}`
}

/** 416 应答的 `Content-Range` 值。 */
export function unsatisfiedContentRange(size: number): string {
  return `bytes */${size}`
}
