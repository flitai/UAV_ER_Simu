# algos 目录

算法与评价基线，以及用户插件接口。对应 04 号方案的 WP6。

用户算法插件的处理流程是 04 §15.2 十二项标准算例的第 12 项，必须可验证。

## 现状（2026-09-14）

`reference/` 是参考实现与黄金向量生成器，Python numpy，作为 MATLAB 之外的独立第二实现（D-036）：

| 文件 | 作用 |
|---|---|
| `energy_detector.py` | 能量检测器参考实现与检测概率解析式；引擎 C++ 版须复现且不共用代码 |
| `gen_engine_golden.py` | 复刻引擎随机源，生成 `engine/tests/golden/` 下的七份基准：`energy_detector.json`（`--mode probe`）、`energy_detector_sliding.json`（`sliding`，C-3）、`features.json`（`features`，C-4）、`scene_noise_bandlimit.json`（`scene_noise`，C-8）、`ddc.json`（`ddc`，M-2）、`channelizer.json` 与 `rx_filter.json`（`channelizer` / `rx_filter`，M-3）。**改这个脚本时既有 mode 的输出必须逐字节不变**，提交前 `git diff --exit-code` 守着 |
| `ddc.py` | 数字下变频的独立第二实现（M-2，D-070）：NCO 相位**以圈计不以弧度计**、FIR 点积按抽头**升序**累加 —— 这两条契约换来与引擎 float32 输出逐位相同。`--selftest` 跑物理自检 |
| `channelizer.py` | 多相 FFT 信道化的独立第二实现（M-3，D-071）。**有意写成直接式**（逐路乘 `exp(+j2πkn/M)` 再求和），不走多相也不走 FFT —— 第二实现要独立才有意义。`--selftest` 六项物理自检（中心增益 / 常数相位 / 邻道抑制 / 群时延 / 块长无关 / 功率和） |
| `rx_filter.py` | 接收滤波的独立第二实现（M-3，D-071）：自带历史缓冲的卷积，按 `bw_rel` 以 1e-9 相对容差查冻结表，群时延照扣。`--selftest` 同法 |
| `features.py`、`classify.py` | 突发特征提取与模板匹配识别的参考实现（C-4，D-066）；`classify.py --write-golden` 生成 `engine/tests/golden/recognition.json` |
| `evaluate.py` | 真值与评价的参考实现（C-5，D-067）：`evaluate.py <run_dir>` 从 `detections / recognitions / truth` 三个 JSONL 独立重算并与 `metrics.json` 逐节逐值对拍；`--write-golden` 生成 `engine/tests/golden/metrics.json`。**只用标准库、显式循环累加** |
| `ds6_sliding_check.py` | DS-6 分半标定在滑动噪声估计下的复跑（C-3，D-063：失配在干扰尾部，记为发现） |
| `aoa_fix.py`、`tdoa_fix.py` | AOA 交叉定位与 TDOA 的独立第二实现（L 线，D-053）：读 `bearings.jsonl` 重算，与 `positions.jsonl` 逐值对拍并核 2σ 覆盖率 |
| `gen_spectrum_golden.py` | 闭式确定性信号 + Welch 功率谱，生成 `engine/tests/golden/spectrum_welch.json`（三方互证的 Python 一方） |
| `ds6_false_alarm.py`、`ds7_pd_curves.py` | 真实背景虚警率标定与检测概率曲线（原型阶段验证值，D-028） |
| `product_window.py` | 显示产品视窗抽取的参考实现（B-7 / D-046）：与服务端 `server/src/products/` 逐行对译，两侧对同一产品文件必须逐值一致；`--golden` 生成 `tests/golden/product-window.json`。**只用标准库、显式循环累加**——`sum()` 与 numpy 的求和都不是顺序累加，会与 JavaScript 逐位不同 |

评价基线自 C-5 起有了：引擎 `Evaluator` 与 `reference/evaluate.py`（帧级 / 突发级 / ROC / 混淆矩阵）；跨层一致性算例 ① 的典型链路实例在 `tests/regression/crosslayer_pd_chain.py`。用户插件接口（04 §15.2 第 12 项）尚未开始。
