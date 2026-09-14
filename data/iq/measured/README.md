# data/iq/measured

实测 IQ。格式规范见 `docs/iq-format.md`；大文件不入 git，只入索引与元数据（D-027）。

## 现状（2026-09-14）

甲方数据待提供。两个公开数据集已转换入库、质检、冻结验收集（2026-09-03 / 04），共 4714 个产物：

| 批次 | 目录 | 产物 | 说明 |
|---|---|---|---|
| DroneRFb-DIR | `dronerfb/` | 4690 | 7 机型 × 3 个体（类码 `A1`–`G3`）+ 背景 `B`（62 片）；带视距 / 非视距与精确距离；验收集 `holdout.manifest.json` 2487 片 |
| DroneRFa | `dronerfa/` | 24 | 两机型（`T0010` / `T0011`）、两飞控器（`T10010` / `T10110`，915 MHz）与背景 `T0000`；只有距离区间；全部已用于探索，不作验收集 |

逐批 `index.manifest.json`（每产物一行：标识、来源、真值摘要、样点数、`content_sha256`、质量状态）与 `calibration.json`（D-047 的功率标定常数，原型阶段估算值）入库；逐产物清单与 `.iq` 留盘上不入库，由 `tools/iq_convert.py` 确定性重生成。质检与标定报告：`ds6-*`、`ds7-*`（原型阶段验证值，D-028）。

## 清单类别 → `signal_role` 标签（评价器 manifest 模式的真值映射，C-5，D-067）

评价器 `Evaluator` 在回放模式下按清单 `truth.class_code` 定真值（10 报告 §4.5）。**取值全部为 `assumed`**——公开数据集只有片级标签，
没有链路类型标注；映射写在 `engine/src/evaluator.cpp` 的 `label_for_class_code()` 与模型卡 `models/evaluation/README.md` §3，两处同表：

| 类码 | 批次 | 含义 | 帧真值 | 标签 |
|---|---|---|---|---|
| `B` | DroneRFb-DIR | 背景，现场无无人机开机 | 全片为假 | —（没有真值行） |
| `T0000` | DroneRFa | 背景（含蓝牙、WiFi） | 全片为假 | —（没有真值行） |
| `T1xxxx`（`T10010` FrSky X20、`T10110` Futaba T14SG） | DroneRFa | 飞控器 | 全片为真 | `rc_hopping` |
| `A1`–`G3` | DroneRFb-DIR | 无人机（DJI Mavic 3 Pro、Mini 4 Pro 等 7 型） | 全片为真 | `video_link` |
| `T0010`（DJI Phantom 4 Pro）、`T0011`（DJI MATRICE 200） | DroneRFa | 无人机 | 全片为真 | `video_link` |
| 其它 | — | 未知类码 | 全片为真 | `class:<code>`，并标 `degraded` |

回放模式全片一段、无频率：帧级指标只剩「命中率」（非背景片段没有负样本，Pfa 为 `null`；背景片段没有正样本，Pd 为 `null`），
突发级与识别指标对公开数据集意义有限（10 报告 §10「回放真值粗」）。甲方数据到货后按其标注重定此表并升版本。
