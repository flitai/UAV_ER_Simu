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

## 第四个坑：无头 Chrome 会周期性丢 WebGL 上下文（2026-09-19 实测，D4 / D-076）

页面开起来约 **8.5 秒**时 WebGL 上下文被丢一次，随后**自动恢复**（实测 6–20 秒后回来）；
之后还会再丢。单次导航就会发生，与本项目的代码无关，也与同时开着几个浏览器无关
（把机器上残留的 Chrome 全清掉照样复现）。

它的表现是：MapLibre 的 `_contextLost` 把 `map.style` 置为 null，于是

- `window.__probe()` 的 `layers` 与 `sources` 那一拍读成 **0**（`ready` 仍是 true，
  `map._removed` 仍是 false——**所以不是地图被拆了**）；
- `queryRenderedFeatures()` 那一拍返回空；
- `map.getSource(...)` 会抛「Cannot read properties of null」。

**任何按 `layers` / `sources` / 渲染要素计数写的断言都要想到它。** 两种写法：
盯着 `layers.length > 0` 等上下文回来再测（`slice2` 的 `waitAlive`），
或者只在上下文活着的那些采样之间比（`slice2` 的「探针不增删图层」那条，
30 次采样里通常有 14–20 次可比）。**别把它算成被测代码的副作用**——
D4 那条「探针无副作用」第一版就是这么写的，连红三轮才查出来跟探针毫无关系。

## 一条尚未查清的偶发（2026-09-19，D-077）

`slice1-smoke` 在**整批连跑**时出现过两次「39 项失败 2 项」，而单独跑、以及带完整日志连跑
都是 0 失败（各试了两到三轮）。**没能带着日志复现，所以不知道是哪两条**——
这里记一笔免得下次又从头查起。最像的嫌疑是上面第四条那个 WebGL 上下文丢失：
`slice1` 里有若干条按图层与渲染要素计数写的断言，正好是那件事会打中的。

下次再遇到，**第一件事是带完整日志跑整批**（`for f in …; do node tests/e2e/$f-smoke.mjs; done > 全量日志`），
别用 `| tail -2`——只截尾就只看得到「失败 2 项」，看不到是哪两项。
