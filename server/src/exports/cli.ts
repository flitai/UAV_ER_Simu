// 服务端 SigMF 导出的命令行入口（D-090）：只给一致性核对用（tests/regression/export_parity.py），
// 界面走 routes.ts。参数与 tools/iq_export_sigmf.py 对齐：
//   node server/dist/exports/cli.js <运行目录> -o <输出目录> [--op <id>]... [--stem <前缀>] [--scenario <场景文件>]
// 组件目录取引擎 `cuav_run --catalog`（环境变量 CUAV_RUN，缺省 engine/build/cuav_run），与服务端同一份来源。

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExportError, exportRun, type CatalogDoc } from './sigmf.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function main(argv: string[]): Promise<number> {
  const pos: string[] = []
  const ops: string[] = []
  let out = ''
  let stem: string | undefined
  let scenario: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-o' || a === '--out') out = argv[++i]
    else if (a === '--op') ops.push(argv[++i])
    else if (a === '--stem') stem = argv[++i]
    else if (a === '--scenario') scenario = argv[++i]
    else pos.push(a)
  }
  if (pos.length !== 1 || !out) {
    console.error('用法：cli.js <运行目录> -o <输出目录> [--op <id>]... [--stem <前缀>] [--scenario <场景文件>]')
    return 1
  }
  const bin = process.env.CUAV_RUN ?? join(ROOT, 'engine', 'build', 'cuav_run')
  const catalog = JSON.parse(execFileSync(bin, ['--catalog'], { cwd: ROOT, maxBuffer: 64 << 20 }).toString('utf8')) as CatalogDoc
  try {
    const res = await exportRun({
      root: ROOT, runDir: resolve(pos[0]), outDir: resolve(out), catalog, ops: ops.length ? ops : undefined,
      stemPrefix: stem, scenarioPath: scenario ? resolve(scenario) : undefined,
    })
    for (const r of res) {
      console.log(`${r.stem}：${r.point} ${r.samples} 样点，${r.state}，${r.lossless ? '无损' : `重量化余量 ${r.requant_margin_dB} dB`}；注记 ${r.annotations} 条`)
    }
    return 0
  } catch (e) {
    if (e instanceof ExportError) {
      console.error(`导出中止：${e.message}`)
      return 2
    }
    throw e
  }
}

main(process.argv.slice(2)).then((c) => process.exit(c))
