# tools —— 内部数据工具

**定位**：数据入库前的转换与质检工具，**不是系统运行时依赖，不进交付包**（与 `matlab/` 同类）。
交付系统里对应的能力将来由 `server/` 与 `engine/` 提供，本目录只服务研发阶段的数据资产建设。

| 工具 | 对应步骤 | 作用 |
|---|---|---|
| `iq_convert.py` | 06 §11.4 DS-2 / DS-3、§11.5 DA-2 / DA-3 | 把公开数据集的 HDF5 转成本项目的复 int16 交织格式加旁挂清单 |
| `iq_survey.py` | 06 §11.4 DS-5、§11.5 DA-5 | 04 §10.6 八项质检 + 频谱与突发摘要，结论落四态语义 |
| `iq_format/` | — | 两者共用的清单 schema、写盘器、源适配器 |
| `iq_export_sigmf.py` | 06 §9K Q-1（D-087） | 把一次运行的观测点原始样点（`iq.cf32`）导出成 SigMF：S3 无损、S4 / S5 一次重量化，真值写 annotations。交付给甲方的数据由它成形，工具本身不进交付包 |

格式规范是 `docs/iq-format.md` 第 3、4 节，**工具是规范的实现，不是规范本身**；两者不一致时
以规范为准，改工具。

## 用法

```bash
# 转换（源自动识别；DroneRFa 默认只转 RF0，理由见 D-018 与 WORKLOG 2026-09-03）
uv run --project tools python tools/iq_convert.py <源文件.mat> -o data/iq/measured/<batch>/

# 质检（读 .iq 与同名 .manifest.json）
uv run --project tools python tools/iq_survey.py data/iq/measured/<batch>/<stem>.iq

# 质检整个目录，输出汇总报告
uv run --project tools python tools/iq_survey.py data/iq/measured/<batch>/ --report survey-report.md

# 观测点原始样点导出 SigMF（运行目录里有 diagram.json 时可省 --diagram；--validate 要 sigmf 包，开发期工具）
uv run --quiet --with numpy --with sigmf python tools/iq_export_sigmf.py data/runs/<task_id> -o <输出目录> --validate
```

## 两条不能违反的规矩

1. **缺元数据判 `degraded`，不崩溃、也不拿默认值顶替**（铁律 15）。两个公开数据集文件内零
   元数据，正是这条路径的测试用例。
2. **无损断言失败就中止**：源浮点数据若不是满量程倒数的整数倍，说明它不是 16 位整数底层，
   四舍五入会静默改变数据（铁律 10），此时中止转换并报错，不写出任何文件。
