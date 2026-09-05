// D1 的端到端验收：前端在离线条件下把底图、山体阴影与观测区域建筑渲染出来。
//
// 跑法（先 `cd server && npm run build && node dist/index.js` 起服务，或用 --url 指到别处）：
//     node tests/e2e/scene-smoke.mjs [--url http://127.0.0.1:8080/] [--out 截图路径]
//
// 断言的是**可观察的结果**，不是"应该能跑"：图层齐、瓦片加载完、有可见要素、无地图错误、
// 相机落在观测区域、WebGL2 可用。判据取自页面的只读探针 window.__probe()（里程碑 D1-5）。

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChrome, Page } from './cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) =>
  v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a, []))
const URL_ = args.url ?? 'http://127.0.0.1:8080/'
const OUT = args.out ?? join(tmpdir(), 'cuav-scene-smoke.png')

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); }

let chrome, page, dir
try {
  dir = await mkdtemp(join(tmpdir(), 'cuav-e2e-'))
  chrome = await launchChrome({ userDataDir: dir })
  console.log(`浏览器 ${chrome.browser}`)
  page = await Page.open(chrome.port, URL_)

  const st = await page.waitFor((s) => s.ready && s.loaded && s.tilesLoaded,
    { label: '地图加载完成', timeoutMs: 120000 })

  check('探针可用且无副作用接口', st.ready === true)
  check('WebGL2 可用（MapLibre GL 5 不支持 WebGL1）', st.webgl2 === true)
  check('样式图层齐全（底图 60 层 + 建筑 + 山体阴影 = 62）', st.layers.length === 62,
    `实际 ${st.layers.length} 层`)
  check('底图数据源已挂载', st.sources.includes('pm'))
  check('高程数据源已挂载', st.sources.includes('dem'))
  check('观测区域建筑数据源已挂载', st.sources.includes('aoi-buildings'))
  check('建筑三维拉伸图层存在', st.layers.includes('aoi-buildings-3d'))
  check('山体阴影图层存在', st.layers.includes('hillshade'))
  check('瓦片全部加载完成', st.tilesLoaded === true)
  check('画面有可见要素', st.renderedFeatures > 100, `${st.renderedFeatures} 个`)
  check('地图无错误', st.errors.length === 0, st.errors.join(' | '))
  check('相机落在观测区域内',
    st.center[0] > 116.28 && st.center[0] < 116.53 && st.center[1] > 39.89 && st.center[1] < 40.09,
    `中心 ${st.center}`)

  const panel = await page.evaluate(
    "({title: document.querySelector('.scene-panel h1')?.textContent, text: document.querySelector('.scene-panel')?.textContent ?? '', devBits: document.querySelectorAll('[data-dev]').length})")
  check('侧栏显示观测区域名称', !!panel.title, panel.title ?? '')
  // D-042：正常界面不解释建筑高度来源；来源分色与占比只在 ?dev=1 出现
  check('界面不解释估算高度（D-042）', !/估算|est:|osm:/.test(panel.text) && panel.devBits === 0,
    panel.devBits ? `有 ${panel.devBits} 个开发者元素` : '')

  await page.screenshot(OUT)
  console.log(`截图 ${OUT}`)
  console.log(`探针：${st.layers.length} 层，${st.renderedFeatures} 个可见要素，画布 ${st.canvas.join('x')}，中心 ${st.center}，缩放 ${st.zoom}`)
} catch (e) {
  check('端到端流程未抛异常', false, String(e))
} finally {
  if (page && chrome) await page.close(chrome.port)
  if (chrome) chrome.proc.kill()
  if (dir) await rm(dir, { recursive: true, force: true })
}

let bad = 0
for (const c of checks) {
  console.log(`${c.ok ? '通过' : '失败'}  ${c.name}${c.detail ? `  —— ${c.detail}` : ''}`)
  if (!c.ok) bad++
}
console.log(`\n共 ${checks.length} 项，失败 ${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
