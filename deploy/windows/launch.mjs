// 单机包启动器（W-2，D-099）。由同目录的 start.bat 用包内便携 Node 调起：
//   node\node.exe launch.mjs
//
// 做四件事：
//   1. 补环境变量的缺省值（已设的优先）：引擎在 bin\ 下、底图取随包的北京区域底图；
//   2. 先看端口上是不是已经有一份本系统在跑——是就只开浏览器，不起第二份
//      （第二份会在启动时对账，把第一份正在跑的任务当成「服务重启时任务未结束」）；
//   3. import 服务模块并调 start()，等它真正监听成功；
//   4. 用系统默认浏览器打开页面（CUAV_NO_BROWSER=1 时不开，冒烟测试用）。
//
// 包的根目录与仓库同构：服务按 server/dist/../.. 找根、引擎子进程的工作目录是根（D-042 ②），
// 所以本文件必须放在包根目录。经 import 引入时，server/dist/index.js 末尾的「直接运行才启动」判定不成立，
// 不会重复启动。

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const env = process.env

env.CUAV_RUN ??= join(ROOT, 'bin', process.platform === 'win32' ? 'cuav_run.exe' : 'cuav_run')
env.CUAV_BASEMAP ??= 'beijing'
env.PORT ??= '8080'
env.HOST ??= '127.0.0.1'

const port = Number(env.PORT)
const host = env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST
const url = `http://${host}:${port}/`
const noBrowser = env.CUAV_NO_BROWSER === '1'

function openBrowser() {
  if (noBrowser) return
  let cmd
  let args
  const opts = { detached: true, stdio: 'ignore', windowsHide: true }
  if (process.platform === 'win32') {
    // start 的第一个带引号参数是窗口标题，所以先给一个空标题
    cmd = 'cmd.exe'
    args = ['/d', '/s', '/c', `start "" "${url}"`]
    opts.windowsVerbatimArguments = true
  } else if (process.platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }
  try {
    const p = spawn(cmd, args, opts)
    p.on('error', () => console.log(`没能自动打开浏览器，请手动在地址栏输入 ${url}`))
    p.unref()
  } catch {
    console.log(`没能自动打开浏览器，请手动在地址栏输入 ${url}`)
  }
}

/** 端口上是不是本系统：任务列表端点按约定的形状应答（{tasks: [], total: n}）。 */
async function alreadyRunning() {
  try {
    const r = await fetch(`${url}api/v1/tasks?limit=1`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return false
    const j = await r.json()
    return Array.isArray(j.tasks) && typeof j.total === 'number'
  } catch {
    return false
  }
}

function banner(lines) {
  const bar = '='.repeat(60)
  console.log(bar)
  for (const l of lines) console.log(`  ${l}`)
  console.log(bar)
}

async function main() {
  if (await alreadyRunning()) {
    banner([
      `本系统已经在端口 ${port} 上运行，这次只打开浏览器。`,
      `浏览器地址：${url}`,
    ])
    openBrowser()
    return 0
  }

  const { start } = await import(pathToFileURL(join(ROOT, 'server', 'dist', 'index.js')).href)
  try {
    await start()
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      banner([
        `端口 ${port} 已被其他程序占用，服务没有启动。`,
        '处理办法：用记事本打开本目录下的 start.bat，',
        `把 "set PORT=${port}" 里的 ${port} 改成别的端口（例如 8081），保存后再双击 start.bat。`,
      ])
      return 2
    }
    banner([`服务启动失败：${e && e.message ? e.message : String(e)}`])
    return 1
  }

  banner([
    '无人机电子信号侦察仿真系统已启动。',
    `浏览器地址：${url}`,
    '关闭本窗口即停止服务。',
  ])
  openBrowser()
  return 0
}

const code = await main()
// 成功启动时不退出：服务在跑，进程靠监听套接字活着。失败时带退出码结束，start.bat 据此停住窗口。
if (code !== 0) process.exit(code)
