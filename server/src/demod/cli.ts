// 解调的命令行入口（D-107）：供 tests/regression/demod_parity.py 与 Python 参考对拍。
//   node server/dist/demod/cli.js <运行目录> --op s3 --emitter uav-1 --t 0.004
// 输出一行 JSON（含全部点），只给对拍用，不经过频带与重叠判断（那两样在端点里）。

import { promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demod, loadPresetDocs, openIq, type TruthRow } from './core.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function main(): Promise<number> {
  const a = process.argv.slice(2)
  const runDir = a[0]
  const get = (k: string): string | undefined => {
    const i = a.indexOf(k)
    return i >= 0 ? a[i + 1] : undefined
  }
  const op = get('--op') ?? 's3'
  const emitter = get('--emitter')
  const t = Number(get('--t'))
  if (!runDir || !emitter || !Number.isFinite(t)) {
    process.stderr.write('用法：cli.js <运行目录> --op s3 --emitter <辐射源> --t <起始时刻>\n')
    return 1
  }
  const rows = (await fsp.readFile(join(runDir, 'truth.jsonl'), 'utf8')).split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TruthRow).filter((r) => r.emitter_id === emitter)
  if (!rows.length) {
    process.stderr.write(`真值里没有 ${emitter}\n`)
    return 1
  }
  const row = rows.reduce((b, r) => (Math.abs(r.t_s - t) < Math.abs(b.t_s - t) ? r : b))
  const res = await demod(await openIq(join(runDir, op)), row, await loadPresetDocs(ROOT))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(res)) {
    if (k === 'points') {
      const p = v as { re: Float64Array; im: Float64Array }
      out.points = Array.from(p.re, (re, i) => [re, p.im[i]])
    } else if (v instanceof Float64Array) out[k] = Array.from(v)
    else out[k] = v
  }
  if (out.trace instanceof Array) {
    const tr = out.trace as number[]
    out.trace = Array.from({ length: tr.length / 2 }, (_, i) => [tr[2 * i], tr[2 * i + 1]])
  }
  process.stdout.write(JSON.stringify(out) + '\n')
  return 0
}

// 不用 process.exit：管道上的 stdout 是异步写的，提前退出会把超过 64 KiB 的输出截断
main().then((c) => { process.exitCode = c }, (e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`)
  process.exitCode = 2
})
