# web 目录

浏览器前端。TypeScript 加 React 19 加 Vite。

## 已冻结的技术选择

| 项 | 值 | 依据 |
|---|---|---|
| 地图库 | `maplibre-gl` 锁定 5.24.0 | 决策 D-008。当前上游最新是 6.7.0，此处是**有意锁定**，目的是与 em-demo 保持同一版本、避免版本分叉 |
| 瓦片库 | `pmtiles` 锁定 4.4.1 | 决策 D-008 |
| 地图样式 | 逐项照搬 Airports 的浅色手写样式 | 决策 D-017。**不采用** em-demo 的深色主题，也不引入 `protomaps-themes-base` |
| 浏览器基线 | 必须支持 WebGL2 | MapLibre GL 5 不支持 WebGL1 |
| 依赖形态 | 全部随包，运行时不联网 | 铁律 6 |

全部依赖写死精确版本号，不使用 `^` 或 `~` 前缀。

## 目录

| 子目录 | 用途 |
|---|---|
| `src/diagram/` | 框图画布与组件编辑。画布库选型未定（React Flow 或 AntV X6），决策时点是阶段 2 设计报告 |
| `src/signal/` | 信号视图：频谱、瀑布图、时域波形 |
| `src/scene/` | 地理场景视图：底图、建筑、无人机与电磁态势 |
| `src/api/` | 与应用服务通信：REST 客户端、WebSocket 客户端、类型定义 |

## 一条硬约束

**原始 IQ 不进浏览器**（铁律 7）。浏览器只接收控制、状态，以及按视窗（时间窗、频段、
像素宽度、统计量）抽取后的展示数据。浏览器不缓存原始 IQ。

## 命令

```
npm run dev        本地开发
npm run build      类型检查加打包，产物在 dist/
npm run typecheck  只做类型检查
```

## 目录（scene 已实现）

```
src/scene/
  SceneView.tsx        场景视图组件：读数据包清单 → 建图 → 挂图层 → 侧栏
  init.ts              协议注册（pmtiles + 离线字形）与建图参数
  probe.ts             只读探针 window.__probe()，供端到端测试
  scenePackage.ts      读 /api/v1/scenes 与数据包入口清单
  style/colors.ts      Airports 配色表，逐字节照搬
  style/protomaps.ts   底图样式 60 层，与 Airports 原函数逐层等价（有黄金基准守着）
  style/glyphs.ts      localglyphs 协议
  layers/hillshade.ts  山体阴影
  layers/buildings3d.ts 观测区域建筑三维拉伸，数据源是同源 GeoJSON（铁律 11）
public/vendor/glyphs.js  离线字形图集（Noto Sans Regular，SIL OFL，署名随包）
```

## 命令

```
npm run dev        本地开发（数据与接口经代理转给 server 的 8080 端口）
npm run build      类型检查加打包，产物在 dist/
npm test           样式黄金基准测试
```

端到端测试见 `tests/e2e/`：先起 server 与出 dist，再跑 `node tests/e2e/scene-smoke.mjs`。

## 现状（2026-09-04）

场景视图已可用：离线底图、山体阴影、47582 栋建筑的三维拉伸，全部经本地服务的 Range
请求取数，运行时不联网。框图与结果两个视图属阶段 2，尚未实现。
