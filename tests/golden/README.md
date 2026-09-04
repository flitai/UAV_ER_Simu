# tests/golden 黄金基准

存放**不得静默变化**的基准数据（铁律 10）。超差即为发现，必须查根因，禁止调参使其通过。

| 文件 | 内容 | 由谁比对 |
|---|---|---|
| `airports-basemap-style.json` | Airports 工程 `index.html` 的 `protomapsStyle()` 在 2026-09-04 求值得到的完整样式对象（60 层）。本项目的 `web/src/scene/style/protomaps.ts` 是它的 TypeScript 移植，必须逐层等价 | `web/src/scene/style/protomaps.test.ts` |

## `airports-basemap-style.json` 的来源与再生成

来源是 `/Users/zhiyu/CC/Airports/index.html`（本方自有工程，只读参考）。生成方式是把该文件里
`var PM = {` 到 `protomapsStyle()` 结束的整段抽出来，在 Node 里求值，用 `__PMTILES_URL__`
作占位的归档地址。

**基准一旦冻结就不随 Airports 的后续改动自动更新**：若确实要跟进上游的视觉调整，先记一条决策
（CLAUDE.md 决策日志），再重新生成基准并在提交信息里写明改了哪几层、为什么。
