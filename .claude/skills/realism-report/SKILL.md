---
name: realism-report
description: 本项目「无人机射频 IQ 信号仿真方法与可信性验证报告」（Q-5 真实感对照，交甲方）的配套说明：数据来源、用语约定、重出命令与自查清单。修改该报告或据其写交付文档（Q-7）时使用。
---

# 无人机射频 IQ 信号仿真方法与可信性验证报告

报告名称自 v1.2（2026-10-10，D-100）起如上；内部仍称「真实感对照报告」，文件名 `realism-report.html` 不变。
**当前版本 v1.3（2026-10-12，D-105）**：格子集 `realism-v2`（按机型预设 v2 生成），随正式集交付；v1.2 对应 `realism-v1`（按预设 v1，随样本集），留作记录、不再重出。

通用写法（章节结构、措辞、不符合项三段式、生成器、成稿检查）见用户级 skill `formal-tech-report`，句子级规则见 `tech-zh`；本文件只记本项目的事实。

## 文件

- 报告生成器：`algos/reference/realism_report.py`（只由 `realism_compare.py` 调用）。报告是 HTML，不是 Markdown；不走 pandoc。
- 唯一数字来源：`data/eval/<集合>/realism.json`（入库）与格子集 `tests/regression/eval-dataset/<集合>.json`，集合由 `--set` 选、缺省 `realism-v2`；
  第 2 章的机型预设表随集合读（v2：`presets-v2.json` + `gfsk-presets-v1.json`；v1：两张 v1 表；`realism_report.SETS`），出处等级取自每项 `provenance` 的字母前缀；
  图传数值结构那段文字由图传 20 MHz 档的出处等级决定（只有 A 写「假定」，含 M 写「实测核实」）。
- 章序：`CHAPTERS` 定义一次，标题与正文的「第 n 章 / 第 n.m 节」由 `ch()` 生成；不要在正文里写章节号字面量。
  报告里不手抄任何数字；原因段由 `findings()` 按结果生成。
- 产物：`data/eval/<集合>/realism-report.html`（不入库，单文件，图内嵌，离线可开）。
- 交付：v1.3 随正式集的配套文档包交付（Q-7，D-106）：`scripts/q7/pack_docs.py` 把 `realism-v2/realism-report.html` 拷进 `data/eval/formal-v1/docs/` 并核对封面版本是 v1.3。
  同包的另两份文档引用它时写正式名称（简称「可信性验证报告」），不写「真实感对照报告」；它们的自查多一条 `--forbid 真实感`。
- 口径与落地记录：14 号报告 §7.3（判定准则，比对前定）、§7.4（结果、查出的问题与 v1.2 / v1.3 的版本记录）；决策 D-096、D-097、D-098、D-100、D-105。

## 重出

```bash
uv run --quiet --with numpy --with scipy --with matplotlib python algos/reference/realism_compare.py            # 缺省 --set realism-v2
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

```bash
python3 ~/.claude/skills/formal-tech-report/scripts/check_report.py data/eval/realism-v2/realism-report.html \
  --ref-order any --ban-file .claude/skills/realism-report/ban-words.txt --forbid 'D-\d{3}' --forbid '\bQ-\d' --lint
node ~/.claude/skills/formal-tech-report/scripts/check_layout.mjs data/eval/realism-v2/realism-report.html --out data/tmp/realism/shots
```

`ban-words.txt` 是本项目的禁用词（内部说法与旧称）。v1.2 与 v1.3 在这套检查下都是错误 0、警告 0（v1.1 的五条警告：表图未在正文引用、
文献 [3] 未引用、负号用连字符、两处「明显」，已在 v1.2 一并改掉）。

- [ ] 表、图编号从 1 起连续，与版面顺序一致；没有残留占位符（生成器会报错）。
- [ ] 正文没有口语与内部说法（由 `ban-words.txt` 检查）。
- [ ] `realism.json` 在只改措辞时不变（`git diff --stat`）。
- [ ] 截图检查桌面与手机宽度（390 像素无横向溢出）。
- [ ] `tech-zh` 的 `ctc_lint.py` 对正文无硬错误；长句只出现在枚举与表格行。
