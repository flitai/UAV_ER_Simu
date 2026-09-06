# algos 目录

算法与评价基线，以及用户插件接口。对应 04 号方案的 WP6。

用户算法插件的处理流程是 04 §15.2 十二项标准算例的第 12 项，必须可验证。

## 现状（2026-09-06）

`reference/` 是参考实现与黄金向量生成器，Python numpy，作为 MATLAB 之外的独立第二实现（D-036）：

| 文件 | 作用 |
|---|---|
| `energy_detector.py` | 能量检测器参考实现与检测概率解析式；引擎 C++ 版须复现且不共用代码 |
| `gen_engine_golden.py` | 复刻引擎随机源，生成 `engine/tests/golden/energy_detector.json` |
| `gen_spectrum_golden.py` | 闭式确定性信号 + Welch 功率谱，生成 `engine/tests/golden/spectrum_welch.json`（三方互证的 Python 一方） |
| `ds6_false_alarm.py`、`ds7_pd_curves.py` | 真实背景虚警率标定与检测概率曲线（原型阶段验证值，D-028） |
| `product_window.py` | 显示产品视窗抽取的参考实现（B-7 / D-046）：与服务端 `server/src/products/` 逐行对译，两侧对同一产品文件必须逐值一致；`--golden` 生成 `tests/golden/product-window.json`。**只用标准库、显式循环累加**——`sum()` 与 numpy 的求和都不是顺序累加，会与 JavaScript 逐位不同 |

用户插件接口与评价基线（04 §15.2 第 12 项）尚未开始。
