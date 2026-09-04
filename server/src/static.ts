// 静态文件服务：支持 Range、HEAD、条件请求，禁止路径穿越。
//
// 只服务显式声明的根目录（见 index.ts 的 ROOTS），任何解析后落在根目录之外的请求一律 403。
// 这条不是可选项：本服务要暴露 137 GB 的底图与场景数据目录，一个 `..` 就能读到仓库之外。

import { createReadStream, promises as fsp } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseRange, rangeLength, contentRange, unsatisfiedContentRange } from './range.js'

/** 交付环境不联网，MIME 表只列本项目实际用到的类型，未知类型按二进制流下发。 */
const MIME: Record<string, string> = {
  '.pmtiles': 'application/octet-stream',
  '.geojson': 'application/geo+json',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.pbf': 'application/x-protobuf',
  '.map': 'application/json; charset=utf-8',
}

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 把 URL 路径解析成根目录内的绝对路径。
 *
 * **安全契约：返回值要么是 null，要么一定落在 root 之内，绝不逃逸。** 两种情形都算安全：
 *   - 绝对路径里的 `..`（如 `/../etc/passwd`）被 normalize 折掉，结果留在 root 内；
 *   - 相对路径逃逸（如 `../escape`）与非法编码、含空字节的路径，返回 null。
 * 先解码再规范化：`%2e%2e%2f` 这类编码过的穿越必须在解码后才能被 normalize 识别。
 */
export function resolveWithin(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null // 非法百分号编码
  }
  if (decoded.includes('\0')) return null
  const abs = resolve(join(root, normalize(decoded)))
  const base = resolve(root)
  if (abs !== base && !abs.startsWith(base + sep)) return null
  return abs
}

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.length),
    'accept-ranges': 'bytes',
  })
  res.end(buf)
}

/**
 * 下发一个文件，按需处理 Range。
 * @returns 是否命中文件（false 表示不存在，调用方可继续尝试其它根目录）
 */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  absPath: string,
): Promise<boolean> {
  let stat
  try {
    stat = await fsp.stat(absPath)
  } catch {
    return false
  }
  if (!stat.isFile()) return false

  const size = stat.size
  const head = req.method === 'HEAD'
  const common = {
    'content-type': mimeOf(absPath),
    'accept-ranges': 'bytes',
    'last-modified': stat.mtime.toUTCString(),
    // 数据包内容变了文件名或哈希也会变，这里不做长缓存，避免开发期取到旧瓦片
    'cache-control': 'no-cache',
  }

  const r = parseRange(req.headers.range, size)
  if (r.kind === 'unsatisfiable') {
    res.writeHead(416, { ...common, 'content-range': unsatisfiedContentRange(size), 'content-length': '0' })
    res.end()
    return true
  }
  if (r.kind === 'none') {
    res.writeHead(200, { ...common, 'content-length': String(size) })
    if (head) return res.end(), true
    createReadStream(absPath).pipe(res)
    return true
  }

  res.writeHead(206, {
    ...common,
    'content-range': contentRange(r, size),
    'content-length': String(rangeLength(r)),
  })
  if (head) return res.end(), true
  createReadStream(absPath, { start: r.start, end: r.end }).pipe(res)
  return true
}
