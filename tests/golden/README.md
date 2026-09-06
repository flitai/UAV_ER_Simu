# tests/golden 黄金基准

存放**不得静默变化**的基准数据（铁律 10）。超差即为发现，必须查根因，禁止调参使其通过。

| 文件 | 内容 | 由谁比对 |
|---|---|---|
| `component-catalog.json` | 引擎组件目录 `cuav-catalog/1`（`docs/component-catalog.md`），2026-09-05 由 `engine/build/cuav_run --catalog` 首次生成，八个组件。比较规则「已有条目不变」：基准里每个组件的 `type`、`ports`、`params` 与端口兼容矩阵必须与当前目录相同；新增组件允许。再生成：`engine/build/cuav_run --catalog > tests/golden/component-catalog.json`，并在 WORKLOG 记一条；已有条目变了先记决策 | `engine/tests/test_catalog_golden.cpp` |
| `product-window.json` | 视窗抽取（B-7）的归约基准：一份合成谱（37 行 × 64 bin，含 −300 底）与一份合成包络（23 桶，末桶 37 样点）上的 12 个查询用例。文件里**只存公式与输入的 sha256，不存输入本身**，比对方按同一公式再生成输入并核对哈希，因此比的确实是归约逻辑。判据：`max` / `min` / 包络三列逐位相同，`mean` 走 `pow` 与 `log10`，允许 1 个 float32 ulp（macOS 实测两侧逐位相同，容差是留给 Windows 的 libm）。再生成：`uv run --quiet python algos/reference/product_window.py --golden tests/golden/product-window.json` | `server/src/products/golden.test.ts` |
| `airports-basemap-style.json` | Airports 工程 `index.html` 的 `protomapsStyle()` 在 2026-09-04 求值得到的完整样式对象（60 层）。本项目的 `web/src/scene/style/protomaps.ts` 是它的 TypeScript 移植，必须逐层等价 | `web/src/scene/style/protomaps.test.ts` |

## `airports-basemap-style.json` 的来源与再生成

来源是 `/Users/zhiyu/CC/Airports/index.html`（本方自有工程，只读参考）。生成方式是把该文件里
`var PM = {` 到 `protomapsStyle()` 结束的整段抽出来，在 Node 里求值，用 `__PMTILES_URL__`
作占位的归档地址。

**基准一旦冻结就不随 Airports 的后续改动自动更新**：若确实要跟进上游的视觉调整，先记一条决策
（CLAUDE.md 决策日志），再重新生成基准并在提交信息里写明改了哪几层、为什么。
