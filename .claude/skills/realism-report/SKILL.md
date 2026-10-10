---
name: realism-report
description: 本项目「生成 IQ 数据真实感验证报告」（交甲方）的配套说明：数据来源、用语约定、重出命令与自查清单。修改该报告或据其写交付文档（Q-7）时使用。
---

# 生成 IQ 数据真实感验证报告

通用写作方法见用户级 skill `research-report-workflow` 与 `tech-zh`；本文件只记本项目的事实。

## 文件

- 报告生成器：`algos/reference/realism_report.py`（只由 `realism_compare.py` 调用）。报告是 HTML，不是 Markdown；不走 pandoc。
- 唯一数字来源：`data/eval/realism-v1/realism.json`（入库）与格子集 `tests/regression/eval-dataset/realism-v1.json`。
  报告里不手抄任何数字；原因段由 `findings()` 按结果生成。
- 产物：`data/eval/realism-v1/realism-report.html`（不入库，单文件，图内嵌，离线可开）。
- 口径与落地记录：14 号报告 §7.3（判定准则，比对前定）、§7.4（结果与查出的问题）；决策 D-096、D-097、D-098。

## 重出

```bash
uv run --quiet --with numpy --with scipy --with matplotlib python algos/reference/realism_compare.py
```

只改 `realism_report.py` 时分析缓存仍有效，约 10 秒；改了 `realism_compare.py`、格子集或引擎则整轮重算约 14 分钟。
带缓存两次生成的 HTML 逐字节相同；`--check` 不用缓存重算并核对 `realism.json`。

## 用语约定（读者是甲方）

- 判定：符合 / 不符合 / 不可判定；仅列出的统计量写「仅列出」。
- 归因等级：已确认 / 推断 / 未查明。每个不符合项写「观测 / 分析 / 归因」三段。
- 结论分级：充分验证（≥ 80%）/ 初步支持（≥ 50%）/ 未验证；分级只用于汇总。
- 数据集合：验证集、实测样本集；出版方的划分写全「出版方训练集 / 出版方测试集」。实测数据不叫「录音」。
- 编号：对照组 P1–P8；结构核查 K1、K2（不用 S1 / S2，避开观测点名）；观测点 S0–S5。
- 正文不出现决策编号、内部步骤号、机器路径、仓库文件路径；参考文献编号 [n]，表图编号「表 n」「图 n」，
  正文先用占位符引用、全文生成后统一替换。中文与拉丁字母、数字之间留空格。
- 本报告全部数值标「原型阶段验证结果」。

## 自查

- [ ] 表、图编号从 1 起连续，与版面顺序一致；没有残留占位符（生成器会报错）。
- [ ] 正文没有口语与内部说法（「像不像」「尺子」「照实」「同源」「角色窗」「录音」「验收集」「训练部分」）。
- [ ] `realism.json` 在只改措辞时不变（`git diff --stat`）。
- [ ] 截图检查桌面与手机宽度（390 像素无横向溢出）。
- [ ] `tech-zh` 的 `ctc_lint.py` 对正文无硬错误；长句只出现在枚举与表格行。
