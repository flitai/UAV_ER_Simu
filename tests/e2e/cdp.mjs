// 浏览器调试协议（CDP）的极简客户端，零依赖：只用 Node 内置的 fetch 与 WebSocket。
//
// 为什么不用 Puppeteer 之类：交付环境不联网、依赖要随包，端到端测试只需要"开页面、等状态、
// 取截图"三件事，为此引入一整套浏览器自动化框架不划算。
//
// 无头截图的三个坑（2026-09-03 实测，见 WORKLOG）：
//   1. `--screenshot` / `--dump-dom` 在页面 load 事件时就动手，那时瓦片还没拉，截出来是空白。
//   2. `--virtual-time-budget` 下瓦片网络请求不推进。
//   3. 合成器截图拿不到 WebGL 内容，除非建图时开 preserveDrawingBuffer。
// 用调试协议轮询页面状态可以绕开前两条；第三条由 Page.captureScreenshot 走渲染管线解决。

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]

export async function launchChrome({ port = 9333, userDataDir, windowSize = '1400,900' } = {}) {
  const { existsSync } = await import('node:fs')
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!bin) throw new Error('找不到 Chrome 或 Chromium，端到端测试需要其中之一')
  const proc = spawn(bin, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    `--window-size=${windowSize}`, '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return { proc, port, browser: (await r.json())['Browser'] }
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  proc.kill()
  throw new Error('Chrome 调试端口在 20 秒内没有就绪')
}

export class Page {
  #ws; #id = 0; #pending = new Map(); #targetId

  static async open(port, url) {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!r.ok) throw new Error(`新建标签页失败：HTTP ${r.status}`)
    const t = await r.json()
    const p = new Page()
    p.#targetId = t.id
    p.#ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      p.#ws.addEventListener('open', res, { once: true })
      p.#ws.addEventListener('error', rej, { once: true })
    })
    p.#ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      const w = p.#pending.get(m.id)
      if (w) { p.#pending.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result) }
    })
    return p
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里求值，返回 JSON 化后的结果。 */
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `JSON.stringify(${expr})`, awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(`页面求值出错：${JSON.stringify(r.exceptionDetails)}`)
    const v = r.result?.value
    return v === undefined ? undefined : JSON.parse(v)
  }

  /** 轮询直到 check(state) 为真；state 由页面的 window.__probe() 提供。 */
  async waitFor(check, { timeoutMs = 90000, everyMs = 500, label = '条件' } = {}) {
    const t0 = Date.now()
    let last
    while (Date.now() - t0 < timeoutMs) {
      last = await this.evaluate('(window.__probe ? window.__probe() : {ready:false})')
      if (check(last)) return last
      await sleep(everyMs)
    }
    throw new Error(`等待${label}超时（${timeoutMs} 毫秒）。最后状态：${JSON.stringify(last)}`)
  }

  async screenshot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, Buffer.from(r.data, 'base64'))
    return path
  }

  async close(port) {
    try { this.#ws.close() } catch { /* 忽略 */ }
    try { await fetch(`http://127.0.0.1:${port}/json/close/${this.#targetId}`) } catch { /* 忽略 */ }
  }
}
