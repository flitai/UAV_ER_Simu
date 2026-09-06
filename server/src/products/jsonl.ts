// 时间窗 JSONL 读取（06 备忘录 §9A B-7；docs/display-products.md §1、§3；决策 D-046）。
//
// track.jsonl（EntityState，docs/scenario-format.md §7）、links.jsonl（链路帧读数，docs/api-versions.md §4）、
// detections.jsonl（检测列表）三者的结构不同，但取法完全一样：按 t_s 取时间窗、按键抽稀、返回 JSON 数组。
// 因此这里只做一个读取器，由调用方给出抽稀的分组键与可选过滤器。
//
// 三条与事件补取一致的纪律（B-6 踩过的坑）：
//   1. 按字节切行复用 splitLines（去尾 \r、多字节字符可跨 chunk）；
//   2. **末尾没有换行的残片一律丢弃**——生产者可能正在写这一行；
//   3. 不可解析的行、缺 t_s 的行跳过并计数，不让一行坏数据毁掉整个响应。
//
// 首期这三个文件都还没有生产者（G-2 的 ScenarioSource 与 G-5 才写），端点先行，
// 生产者落地后不必改这一层。

import { createReadStream } from 'node:fs'
import { splitLines } from '../tasks/engine.js'

export type JsonlRecord = Record<string, unknown>

export interface JsonlQuery {
  /** 秒，闭区间 t0 ≤ t_s ≤ t1；null = 不限 */
  t0: number | null
  t1: number | null
  /** 抽稀：每个键保留第 0、stride、2·stride… 条；1 = 不抽稀 */
  stride: number
  /** 抽稀的分组键；不给则全局计数 */
  strideKey?: (r: JsonlRecord) => string
  /** 附加过滤（如按 link_id）；在时间窗之后、抽稀之前生效 */
  filter?: (r: JsonlRecord) => boolean
}

export interface JsonlWindow {
  records: JsonlRecord[]
  /** 不可解析或缺 t_s 而跳过的行数 */
  skipped: number
}

/** 文件不存在返回 null（由调用方按运行态决定 409 还是 404）。 */
export function readJsonlWindow(path: string, q: JsonlQuery): Promise<JsonlWindow | null> {
  return new Promise((resolve) => {
    const records: JsonlRecord[] = []
    const seen = new Map<string, number>()
    const stride = Math.max(1, Math.floor(q.stride))
    let skipped = 0
    let carry: Buffer = Buffer.alloc(0)
    let missing = false
    let settled = false

    const take = (line: string) => {
      if (!line.length) return
      let j: unknown
      try {
        j = JSON.parse(line)
      } catch {
        skipped++
        return
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) {
        skipped++
        return
      }
      const r = j as JsonlRecord
      const t = r.t_s
      if (typeof t !== 'number' || !Number.isFinite(t)) {
        skipped++
        return
      }
      if (q.t0 !== null && t < q.t0) return
      if (q.t1 !== null && t > q.t1) return
      if (q.filter && !q.filter(r)) return
      const key = q.strideKey ? q.strideKey(r) : ''
      const n = seen.get(key) ?? 0
      seen.set(key, n + 1)
      if (n % stride === 0) records.push(r)
    }

    const stream = createReadStream(path)
    const finish = () => {
      if (settled) return
      settled = true
      resolve(missing ? null : { records, skipped })
    }
    stream.on('data', (chunk) => {
      const r = splitLines(chunk as Buffer, carry)
      carry = r.carry
      for (const line of r.lines) take(line)
    })
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') missing = true
      else skipped++ // 其它读错误：返回已读到的部分并计数，不抛
      finish()
    })
  })
}
