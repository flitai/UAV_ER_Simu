# data/iq 目录

IQ 数据。格式规范见 `docs/iq-format.md`。

| 子目录 | 内容 | 现状 |
|---|---|---|
| `measured/` | 实测 IQ | 空。甲方实测数据待提供；公开数据集 DroneRFb-DIR 已摸底，尚未转换入库 |
| `synthetic/` | 合成 IQ，参数完全已知，用于验证仿真链条上游 | 空 |
| `mixed/` | 混合增强：实测背景加合成目标 | 空 |

## 关于 DroneRFb-DIR

公开数据集，64 GB，暂放在项目根目录的 `Datasets1-DroneRFb-DIR/`，**已在 `.gitignore` 中排除**。

摸底结论见 `WORKLOG.md` 的 2026-09-03 条目。入库前必须完成的五件事列在该条目第 7 节，
其中「确认许可条款，特别是能否随交付系统分发」是阻塞项。
