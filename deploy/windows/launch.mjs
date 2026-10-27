// 单机包启动器（W-2，D-099）。由同目录的 start.bat 用包内便携 Node 调起：
//   node\node.exe launch.mjs
//
// 做四件事：
//   1. 补环境变量的缺省值（已设的优先）：引擎在 bin\ 下、底图取随包的北京区域底图；
//   2. 先看端口上是不是已经有一份本系统在跑——是就只开浏览器，不起第二份
//      （第二份会在启动时对账，把第一份正在跑的任务当成「服务重启时任务未结束」）；
//   3. import 服务模块并调 start()，等它真正监听成功；
//   4. 用系统默认浏览器打开页面（CUAV_NO_BROWSER=1 时不开，冒烟测试与 Electron 外壳用）。
//
// 由 Electron 外壳（D-111，deploy/electron/main.js）经 IPC 通道调起时另做两件事：把「就绪 / 失败 /
// 已有一份在跑」报给外壳；收到 {type: 'stop'}（或外壳退出、通道断开）时走服务既有的停止处理——
// 运行中的任务落终态、引擎子进程一并结束。start.bat 调起时没有通道，这两件事都不发生。
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
const ipc = typeof process.send === 'function'

/** 报给 Electron 外壳；没有通道时什么也不做。 */
function notify(msg) {
  if (!ipc) return Promise.resolve()
  return new Promise((r) => {
    try { process.send(msg, () => r()) } catch { r() }
  })
}

/** 外壳要求停止：服务已经装了停止处理就走它（与关控制台窗口同一条路），否则直接退出。 */
function stopFromShell() {
  if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM', 'SIGTERM')
  else process.exit(0)
}
if (ipc) {
  process.on('message', (m) => { if (m && m.type === 'stop') stopFromShell() })
  process.on('disconnect', stopFromShell)
}

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
    if (ipc) {
      await notify({ type: 'already-running', url })
      process.exit(0)
    }
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
        ...(process.platform === 'win32'
          ? ['处理办法：用记事本打开本目录下的 start.bat，',
              `把 "set PORT=${port}" 里的 ${port} 改成别的端口（例如 8081），保存后再双击 start.bat。`]
          : ['处理办法：用「文本编辑」打开本目录下的 start.command，',
              `把 PORT="\${PORT:-${port}}" 里的 ${port} 改成别的端口（例如 8081），保存后再双击 start.command。`]),
      ])
      await notify({ type: 'error', code: 'EADDRINUSE', port })
      return 2
    }
    banner([`服务启动失败：${e && e.message ? e.message : String(e)}`])
    await notify({ type: 'error', code: 'START_FAILED', message: e && e.message ? e.message : String(e) })
    return 1
  }

  banner([
    '无人机电子信号侦察仿真系统已启动。',
    `浏览器地址：${url}`,
    ipc ? '关闭程序窗口即停止服务。' : '关闭本窗口即停止服务。',
  ])
  await notify({ type: 'ready', url })
  openBrowser()
  return 0
}

const code = await main()
// 成功启动时不退出：服务在跑，进程靠监听套接字活着。失败时带退出码结束，start.bat 据此停住窗口。
if (code !== 0) process.exit(code)
