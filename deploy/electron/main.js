'use strict';

// 单机包的 Electron 外壳（D-111）。B/S 不变：外壳只是一个窗口，打开的仍是本机应用服务的
// http://127.0.0.1:<端口>/；服务、引擎、前端与数据都是包里同一份。
//
// 做六件事：
//   1. 找到包根目录（向上找 launch.mjs 与 server/dist/index.js），并确认 data/ 可写；
//   2. 端口上已经是本系统就直接用，不另起（判据与 launch.mjs 相同），退出时也不去停它；
//   3. 否则用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE）以子进程运行包里的 launch.mjs，
//      经 IPC 等它报「就绪」；服务不放进外壳主进程，免得一次几十毫秒的抽取或导出卡住窗口；
//   4. 窗口按屏幕工作区宽度定初始缩放：界面在视口宽度小于 1920 时收起左右两栏（加载时判一次）；
//   5. 外部链接交给系统浏览器，窗口只停在本机地址上；
//   6. 退出时给服务发 stop，走服务既有的停止处理（运行中的任务落终态、引擎子进程一并结束），
//      Windows 与 Mac 同一条路；等不到就强制结束。
//
// CUAV_SHELL_SMOKE=1：页面加载完即自检并退出，标准输出最后一行是 SHELL-SMOKE <JSON>，退出码 0 / 1（冒烟用）。
// CUAV_SHELL_CAPTURE=<文件>：与冒烟同用，退出前把窗口内容存成 PNG。
// CUAV_DEVTOOLS=1：菜单里多一项开发者工具（内部诊断用，交付时不设）。

const { app, BrowserWindow, Menu, dialog, shell, screen } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TITLE = '无人机电子信号侦察仿真系统';
const SMOKE = process.env.CUAV_SHELL_SMOKE === '1';
const PORT = Number(process.env.PORT || 8080);
const URL_BASE = `http://127.0.0.1:${PORT}/`;

let win = null;
let server = null;        // 我们起的服务子进程；端口上已有一份时为 null
let serverExit = null;    // 子进程退出码
let stopping = null;
let initialZoom = 1;
const smoke = { ok: false, steps: [] };

const log = (...a) => console.log('[shell]', ...a);

function fail(msg) {
  log(msg);
  if (SMOKE) {
    smoke.error = msg;
    finishSmoke(1);
    return;
  }
  dialog.showErrorBox(TITLE, msg);
  app.exit(1);
}

/** 包根目录：从外壳所在位置向上找。开发时可用 CUAV_ROOT 指定。 */
function findRoot() {
  if (process.env.CUAV_ROOT) return path.resolve(process.env.CUAV_ROOT);
  let d = app.getAppPath();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'launch.mjs')) && fs.existsSync(path.join(d, 'server', 'dist', 'index.js'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function rootProblem() {
  const where = app.getAppPath();
  if (process.platform === 'darwin' && where.includes('/AppTranslocation/')) {
    return '系统把程序隔离到了临时位置运行（下载来的文件带有隔离属性），找不到同目录下的服务与数据。\n\n' +
      '处理办法：打开「终端」，执行\n  xattr -dr com.apple.quarantine <解压出的整个目录>\n然后重新打开程序。';
  }
  return '找不到服务与数据（launch.mjs、server/）。请保持解压后的目录结构不变，从包里运行本程序。';
}

/** data/ 必须可写：任务结果与导出都写在这里。 */
function checkWritable(root) {
  const probe = path.join(root, 'data', 'tmp', `.write-test-${process.pid}`);
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** 端口上是不是本系统：任务列表端点按约定的形状应答（与 launch.mjs 同一判据）。 */
async function alreadyRunning() {
  try {
    const r = await fetch(`${URL_BASE}api/v1/tasks?limit=1`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return Array.isArray(j.tasks) && typeof j.total === 'number';
  } catch {
    return false;
  }
}

/** 以子进程起服务，等它报就绪。返回 'ready' | 'already-running'，失败时抛出可以照着做的说明。 */
function startServer(root) {
  const logFile = path.join(root, 'data', 'tmp', 'server.log');
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  out.write(`\n==== ${new Date().toISOString()} 外壳启动服务\n`);
  server = fork(path.join(root, 'launch.mjs'), [], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUAV_NO_BROWSER: '1', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  server.stdout.pipe(out, { end: false });
  server.stderr.pipe(out, { end: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务 90 秒内没有就绪。日志在 data/tmp/server.log`)), 90000);
    server.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') { clearTimeout(timer); resolve('ready'); }
      else if (m.type === 'already-running') { clearTimeout(timer); server = null; resolve('already-running'); }
      else if (m.type === 'error') {
        clearTimeout(timer);
        reject(new Error(m.code === 'EADDRINUSE'
          ? `端口 ${PORT} 已被其他程序占用，服务没有启动。\n\n请关闭占用该端口的程序后重新打开；` +
            '或改用包里的备用启动方式（Windows：start.bat；Mac：start.command），它们可以改端口。'
          : `服务启动失败：${m.message || m.code}\n\n日志在 data/tmp/server.log`));
      }
    });
    server.on('exit', (code) => {
      serverExit = code;
      clearTimeout(timer);
      reject(new Error(`服务进程意外退出（退出码 ${code}）。日志在 data/tmp/server.log`));
    });
  });
}

/** 停服务：发 stop，等它自己退出；6 秒等不到就强制结束。 */
function stopServer() {
  if (!server || serverExit !== null) return Promise.resolve();
  if (stopping) return stopping;
  stopping = new Promise((resolve) => {
    const done = () => resolve();
    server.once('exit', (code) => { serverExit = code; done(); });
    const t = setTimeout(() => { try { server.kill(); } catch { /* 已退出 */ } }, 6000);
    t.unref();
    try { server.send({ type: 'stop' }); } catch { try { server.kill(); } catch { /* 已退出 */ } }
  });
  return stopping;
}

function splash(text) {
  const html = `<!doctype html><meta charset="utf-8"><title>${TITLE}</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f2ee;
font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#3a3f47">
<div style="text-align:center"><div style="font-size:26px;font-weight:700;letter-spacing:2px">${TITLE}</div>
<div style="margin-top:14px;font-size:15px;color:#6b7280">${text}</div></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function buildMenu() {
  const zoomItems = [
    { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => win && win.webContents.setZoomFactor(initialZoom) },
    { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => win && win.webContents.setZoomFactor(Math.min(2, win.webContents.getZoomFactor() + 0.1)) },
    { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => win && win.webContents.setZoomFactor(Math.max(0.5, win.webContents.getZoomFactor() - 0.1)) },
    { type: 'separator' },
    { role: 'togglefullscreen', label: '全屏' },
  ];
  if (process.env.CUAV_DEVTOOLS === '1') zoomItems.push({ type: 'separator' }, { role: 'toggleDevTools', label: '开发者工具' });
  const template = [];
  if (process.platform === 'darwin') {
    template.push({ label: TITLE, submenu: [
      { role: 'about', label: '关于' }, { type: 'separator' },
      { role: 'hide', label: '隐藏' }, { role: 'hideOthers', label: '隐藏其他' }, { type: 'separator' },
      { role: 'quit', label: '退出' },
    ] });
  } else {
    template.push({ label: '文件', submenu: [{ role: 'quit', label: '退出' }] });
  }
  // 编辑菜单不能省：Mac 上没有它，输入框里的复制粘贴快捷键不起作用
  template.push({ label: '编辑', submenu: [
    { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
    { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
    { role: 'selectAll', label: '全选' },
  ] });
  template.push({ label: '视图', submenu: zoomItems });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  initialZoom = Math.min(1, Math.max(0.75, wa.width / 1920));
  win = new BrowserWindow({
    width: wa.width, height: wa.height, show: false, title: TITLE, backgroundColor: '#f4f2ee',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { zoomFactor: initialZoom, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(URL_BASE) || url.startsWith('data:')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  // 冒烟时窗口不显示；要截画面时必须显示（从没显示过的窗口不出帧，截图会一直等下去）
  const visible = !SMOKE || Boolean(process.env.CUAV_SHELL_CAPTURE);
  if (visible) win.maximize();
  win.once('ready-to-show', () => { if (visible) win.show(); });
  win.loadURL(splash('正在启动服务…'));
}

async function finishSmoke(code) {
  await stopServer();
  smoke.server_exit = serverExit;
  console.log(`SHELL-SMOKE ${JSON.stringify(smoke)}`);
  app.exit(code);
}

async function runSmoke() {
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  for (let i = 0; i < 600; i++) {
    const ok = await js(`Boolean(window.__probe && window.__probe().app && document.querySelector('[data-view-btn="scene"]'))`).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  smoke.page = await js(`({ href: location.href, innerWidth, view: window.__probe ? window.__probe().app.view : null,
    hasViewButtons: document.querySelectorAll('[data-view-btn]').length })`).catch((e) => ({ error: String(e) }));
  smoke.zoom = wc.getZoomFactor();
  // CUAV_SHELL_CAPTURE=<文件>：等地图瓦片加载完，把窗口内容存成 PNG（冒烟时留一张画面作证据）
  if (process.env.CUAV_SHELL_CAPTURE) {
    for (let i = 0; i < 300; i++) {
      const ok = await js(`(() => { const p = window.__probe && window.__probe(); return Boolean(p && p.loaded && p.tilesLoaded) })()`).catch(() => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 1500));
    const img = await wc.capturePage();
    fs.writeFileSync(process.env.CUAV_SHELL_CAPTURE, img.toPNG());
    smoke.capture = img.getSize();
  }
  smoke.ok = Boolean(smoke.page && smoke.page.hasViewButtons >= 3 && smoke.page.href.startsWith(URL_BASE));
  await finishSmoke(smoke.ok ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    buildMenu();
    const root = findRoot();
    if (!root) return fail(rootProblem());
    smoke.steps.push('root');
    if (!checkWritable(root)) {
      return fail(`程序所在目录不可写（${root}）。任务结果要写在包里的 data 目录下。\n\n` +
        '请把整个目录解压或拷贝到可写的位置（如桌面、D 盘根目录），不要放在 Program Files 或「应用程序」等系统目录下。');
    }
    smoke.steps.push('writable');
    createWindow();
    try {
      if (await alreadyRunning()) {
        smoke.owned = false;
        log(`端口 ${PORT} 上已有本系统在运行，直接使用`);
      } else {
        const r = await startServer(root);
        smoke.owned = r === 'ready';
      }
    } catch (e) {
      return fail(e.message);
    }
    smoke.steps.push('server');
    if (SMOKE) win.webContents.once('did-finish-load', () => runSmoke());
    win.loadURL(URL_BASE);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (e) => {
    if (!server || serverExit !== null) return;
    e.preventDefault();
    stopServer().then(() => app.quit());
  });
}
