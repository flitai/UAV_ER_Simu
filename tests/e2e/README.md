# tests/e2e 端到端测试

在真实浏览器里驱动前端，断言**可观察的结果**，不是"应该能跑"。

| 文件 | 作用 |
|---|---|
| `cdp.mjs` | 浏览器调试协议（CDP）的极简客户端，零依赖，只用 Node 内置的 `fetch` 与 `WebSocket` |
| `scene-smoke.mjs` | D1 验收：底图、山体阴影、观测区域建筑在离线条件下渲染出来，14 项断言 |
| `pngdiff.py` | 两张 PNG 的逐像素比较，只用标准库 `zlib`；用于与 Airports 的并排比对 |

## 跑法

```
cd server && npm run build && node dist/index.js &     # 起应用服务
cd web && npm run build                                # 出前端产物
node tests/e2e/scene-smoke.mjs [--url http://127.0.0.1:8080/] [--out 截图路径]
```

退出码 0 表示全过。判据取自页面的只读探针 `window.__probe()`（里程碑 D1-5），
探针不改相机、不增删图层、不触发请求。

## 为什么不用浏览器自动化框架

交付环境不联网、依赖要随包（铁律 6），而端到端只需要"开页面、等状态、取截图"三件事，
为此引入一整套框架不划算。`cdp.mjs` 一百多行覆盖了这三件事。

## 无头截图的三个坑（2026-09-03 实测）

1. `--screenshot` 与 `--dump-dom` 在页面 `load` 事件时就动手，那时瓦片还没拉，截出来是空白。
2. `--virtual-time-budget` 下瓦片的网络请求不推进，探针会一直停在 `loaded: false`。
3. 合成器截图与 `canvas.toDataURL()` 都拿不到 WebGL 内容，除非建图时开 `preserveDrawingBuffer`。

用调试协议轮询探针可以绕开前两条；第三条由 `Page.captureScreenshot` 走渲染管线解决，
不需要动应用代码。
