# algos 目录

算法与评价基线，以及用户插件接口。对应 04 号方案的 WP6。

用户算法插件的处理流程是 04 §15.2 十二项标准算例的第 12 项，必须可验证。

## 现状（2026-09-14）

`reference/` 是参考实现与黄金向量生成器，Python numpy，作为 MATLAB 之外的独立第二实现（D-036）：

| 文件 | 作用 |
|---|---|
| `energy_detector.py` | 能量检测器参考实现与检测概率解析式；引擎 C++ 版须复现且不共用代码 |
| `gen_engine_golden.py` | 复刻引擎随机源，生成 `engine/tests/golden/energy_detector.json`（`--mode probe`）、`energy_detector_sliding.json`（`--mode sliding`，C-3）、`features.json`（`--mode features`，C-4） |
| `features.py`、`classify.py` | 突发特征提取与模板匹配识别的参考实现（C-4，D-066）；`classify.py --write-golden` 生成 `engine/tests/golden/recognition.json` |
| `evaluate.py` | 真值与评价的参考实现（C-5，D-067）：`evaluate.py <run_dir>` 从 `detections / recognitions / truth` 三个 JSONL 独立重算并与 `metrics.json` 逐节逐值对拍；`--write-golden` 生成 `engine/tests/golden/metrics.json`。**只用标准库、显式循环累加** |
| `ds6_sliding_check.py` | DS-6 分半标定在滑动噪声估计下的复跑（C-3，D-063：失配在干扰尾部，记为发现） |
| `aoa_fix.py`、`tdoa_fix.py` | AOA 交叉定位与 TDOA 的独立第二实现（L 线，D-053）：读 `bearings.jsonl` 重算，与 `positions.jsonl` 逐值对拍并核 2σ 覆盖率 |
| `gen_spectrum_golden.py` | 闭式确定性信号 + Welch 功率谱，生成 `engine/tests/golden/spectrum_welch.json`（三方互证的 Python 一方） |
| `ds6_false_alarm.py`、`ds7_pd_curves.py` | 真实背景虚警率标定与检测概率曲线（原型阶段验证值，D-028） |
| `product_window.py` | 显示产品视窗抽取的参考实现（B-7 / D-046）：与服务端 `server/src/products/` 逐行对译，两侧对同一产品文件必须逐值一致；`--golden` 生成 `tests/golden/product-window.json`。**只用标准库、显式循环累加**——`sum()` 与 numpy 的求和都不是顺序累加，会与 JavaScript 逐位不同 |

评价基线自 C-5 起有了：引擎 `Evaluator` 与 `reference/evaluate.py`（帧级 / 突发级 / ROC / 混淆矩阵）；跨层一致性算例 ① 的典型链路实例在 `tests/regression/crosslayer_pd_chain.py`。用户插件接口（04 §15.2 第 12 项）尚未开始。
