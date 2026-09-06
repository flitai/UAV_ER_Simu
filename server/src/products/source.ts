// 产品文件的行源：按偏移读定长行（06 备忘录 §9A B-7；决策 D-046）。
//
// 与 ws/events.ts 的 RowReader 是两种用法：那边按事件读**一行**推实时帧，这边按视窗读**一段连续行**
// 做归约。两者共用同一前提：行定长、小端 float32、偏移 = row_index × row_len × 4（D-041）。
//
// 行数在**打开时**由文件长度定死，之后不追随引擎的追加：一次响应必须对应一个确定的快照，
// 否则同一请求的 rows 与实际读到的行会对不上（docs/display-products.md §1.1）。

import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { HttpError } from '../tasks/manager.js'
import { type RowSource, chunkRows } from './window.js'

export interface FileRowSource extends RowSource {
  close(): Promise<void>
}

/**
 * 打开产品文件。`rows` 由调用方按文件长度算好（meta.ts），这里只按它读。
 * 短读一律报 500：文件在读的过程中被截断，不是客户端能修正的情况。
 */
export async function openFileRowSource(path: string, rowLen: number, rows: number): Promise<FileRowSource> {
  const fh: FileHandle = await fsp.open(path, 'r')
  const maxRows = chunkRows(rowLen)
  return {
    rows,
    rowLen,
    async read(row0: number, count: number): Promise<Float32Array> {
      if (count > maxRows) {
        // 调用方按 chunkRows 分块；真读到这里说明调用方没分块，直接拒绝而不是悄悄分配大块内存
        throw new HttpError(500, { error: 'internal', message: `一次读 ${count} 行超过分块上限 ${maxRows}` })
      }
      // 直接分配 Float32Array 再包成 Buffer：它的 buffer 必然 4 字节对齐，不必再判 byteOffset
      const out = new Float32Array(count * rowLen)
      const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength)
      const r = await fh.read(buf, 0, buf.length, row0 * rowLen * 4)
      if (r.bytesRead !== buf.length) {
        throw new HttpError(500, {
          error: 'short_read',
          message: `产品文件第 ${row0} 行起短读：${r.bytesRead} / ${buf.length} 字节`,
        })
      }
      return out
    },
    close(): Promise<void> {
      return fh.close()
    },
  }
}
