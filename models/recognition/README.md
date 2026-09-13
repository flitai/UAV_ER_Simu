# 识别模型卡：`TemplateClassifier` 与模板库 v1（C-4，2026-09-13）

**定位**：EM-S-04 信号识别的 **E2 工程模板加权匹配**基线（04 §7.9 「传统或轻量学习识别基线」取传统），M2 裁决件，
只吃 `FeatureExtractor` 出的突发特征（观测量），不碰原始 IQ（02 §8.5）。标签只到 EM-S-04 §10.2 三层里的
**`signal_role` 层**：`video_link` / `telemetry_burst` / `rc_hopping` / `cw_beacon`；型号级（`signal_template`）随 T 线的
辐射源模板与 P3 数据校准。溯源：`model_id = TemplateClassifier`（概念模型 EM-S-04）、`M2` / `E2` / **`V2`**、
`parameter_version = library-<version>`。

## 1. 算法（10 报告 §4.4；引擎 `engine/src/recognition.cpp`，参考 `algos/reference/classify.py`）

对每行特征、每个模板 `k`：

1. 逐特征取**区间外距离**（EM-S-04 §10.5 区间形式）。对数域特征（带宽、时长、跳频差、间隔）：
   `d = (ln l − ln x) / s_log`（x < l）或 `(ln x − ln u) / s_log`（x > u），`s_log = 0.3`，x 先按 `log_floor` 钳住，
   下界 0 与缺上界视为不设界；线性特征（占空比、平坦度）：`d = (l − x) / s` 或 `(x − u) / s`，`s` = 半区间宽。
2. 综合距离 `D_k = Σ_i w_ik·m_i·d_ik / Σ_i w_ik·m_i`，`m_i` 为该特征在这一行里是否可用（带宽要有信号 bin，
   跳频差与间隔要有上一段）；没有任何可用特征的模板不参与。
3. 似然 `L_k = exp(−D_k / 2)`，未知假设 `L_u = exp(−unknown_distance / 2)`，先验均匀，后验 `p_k = L_k / (Σ_j L_j + L_u)`。
4. 判决：`max p ≥ accept_threshold` 且领先次大 `≥ ambiguity_margin` → `known`；领先不足 → `ambiguous`（仍给 Top-1）；
   否则 `unknown`——最近模板距离 `> unknown_distance` 为 `unknown_novel`，否则 `unknown_ambiguous`。
   特征质量低于 `min_quality` 的行直接 `unknown_low_quality`，不算后验（EM-S-04 §10.9 的 `evidence_quality` 门）。

每行输出 `label / posterior / top_n（≤ 3）/ distance / result / unknown_kind / evidence_quality / library_version` 加溯源，
落 `recognitions.jsonl`（`docs/display-products.md` §5.3）。

## 2. 参数（缺省值）

| 参数 | 缺省 | 说明 |
|---|---|---|
| `library_version` | `v1` | 库文件 `models/recognition/library-<version>.json`，路径由装载器注入（内部参数 `library_path`，D-037），版本号先过 `^v[0-9]+$` |
| `accept_threshold` | 0.5 | 最大后验的接受门限（10 报告 §4.4 写 0.6，改 0.5 的理由见下） |
| `ambiguity_margin` | 0.2 | known 要求的领先量 |
| `unknown_distance` | 4.0 | 未知假设的等效综合距离 |
| `min_quality` | `short` | 低于此档的特征行直接 `unknown_low_quality` |

**两条实测发现（10 报告 §4.4 的缺省值 0.6 / 0.2 改为 0.5 / 0.2，记入 §11）**：
① 未知假设恒占一份似然 `exp(−4/2) ≈ 0.135`，四个模板下正确类即使 `D = 0` 后验也常只有 0.55–0.8——链路测试里一段 0.5 s 的
单音对 `cw_beacon` 的 `D = 0`、后验 0.59（`telemetry_burst` / `rc_hopping` 只在时长与带宽上各差一个量级，`D ≈ 2.5 / 3.3`，
似然 0.28 / 0.19 仍在分母里），0.6 会把它判成 `unknown`；② 0.6 / 0.2 下 `ambiguous` **不可达**（`p1 ≥ 0.6` 蕴含 `p2 ≤ 0.4`，
领先必 ≥ 0.2）。接受门限改 0.5 两条一起解决：正确类过门限，`p1 ∈ [0.5, 0.6)` 且次大贴近时才出 `ambiguous`。
单测另用 0.4 / 0.3 覆盖 `ambiguous` 那一支。

## 3. 模板库 v1（`library-v1.json`，取值**全部为假定值**，`source = assumed`）

| 标签 | 带宽 Hz | 时长 s | 占空比 | 平坦度 | 跳频差 Hz | 间隔 s | 权重要点 |
|---|---|---|---|---|---|---|---|
| `video_link` | [1e6, 40e6] | [0.5, ∞) | [0.8, 1] | [0.6, 1] | 不计 | 不计 | 带宽、占空比 ×2 |
| `telemetry_burst` | [20e3, 500e3] | [0.5e-3, 50e-3] | [0.02, 0.6] | [0.1, 1] | [0, 20e3] | [5e-3, 1] | 带宽、间隔 ×2 |
| `rc_hopping` | [20e3, 2e6] | [0.5e-3, 20e-3] | [0.05, 0.8] | [0.1, 1] | [200e3, ∞) | [1e-3, 0.1] | 跳频差 ×3 |
| `cw_beacon` | [0, 20e3] | [0.5, ∞) | [0.8, 1] | [0, 0.5] | 不计 | 不计 | 带宽 ×3 |

**平坦度区间与 10 报告附录 D 不同（实施时的发现）**：附录 D 写 cw `[0, 0.2]`、burst 类 `[0.3, 1]`，落地时第一次对着
合成波形的真实特征就对不上。平坦度按 EM-S-03 的定义是**检测频段内**原始 PSD 的几何均值 / 算术均值，对占带内一小部分
bin 的窄信号它随信噪比变：设信号占带内 bin 的比例 `f`、每 bin 信噪比 `ρ`，`flatness ≈ ρ^f / (1 − f + f·ρ)`——单音在 51 bin
的频段里（`f ≈ 0.06`）20 dB 时约 0.3、10 dB 时约 0.7；100 kHz 的窄带突发在 450 kHz 频段里（`f ≈ 0.22`）16 dB 时约 0.2。
所以 cw 的区间放宽到 `[0, 0.5]` 且权重降为 1（带宽升为 3，它才是分辨率级带宽的判据），burst 类下界放到 0.1；
`video_link` 占满频段、平坦度稳定在 0.9 以上，不动。这不是调参使某次演示通过（库本来就是假定值、第一次落地），
是把区间对到定义的实际取值范围上；甲方数据到货后一并按实测分布重标。

`background` 不作显式模板：不匹配任何一类时由开放集给 `unknown`。库与场景波形的对应（`scenario_waveform_map`）：
`noise` 且 `bw ≥ 1 MHz` → `video_link`、`burst` 无 hop → `telemetry_burst`、`burst` 有 hop（G-6）→ `rc_hopping`、`tone` → `cw_beacon`；
这张表是评价器（C-5）取真值用的反查，不进识别器。

## 4. 适用范围与已知边界

- **只对本项目现有合成波形有效**，不代表任何真实机型的参数分布；甲方数据到货后按 04 §11.3 用实测特征分布标定区间与尺度，
  升 `library_version` 并记决策；不得为让某次演示通过而改库里的数（铁律 10）。
- 第一个突发没有「上一段」，跳频差与间隔缺失：`telemetry_burst` 与 `rc_hopping` 在其余特征上区间重叠，后验分摊、常落 `unknown_ambiguous`；
  要分清跳频与定频至少要两个突发。
- `rc_hopping` 一类本期没有生成器（G-6 未做），库里保留、验收留 C-8 / G-6（06 §9G C-4）。
- 特征本身的边界（噪声闸、Hann 主瓣、占空比窗）见 `FeatureExtractor` 的头注与 `docs/display-products.md` §5.2。
- 可信度 V2：黄金基准只证明与参考实现同算法，四类合成波形的准确率断言（C-4 步骤 3）是原型阶段验证值（D-028）。

## 5. 验证

- 黄金基准 `engine/tests/golden/recognition.json`（`classify.py --write-golden`）：12 行手造特征，后验与距离 rel ≤ 1e-9，标签逐字。
- 单测 `engine/tests/test_components.cpp`：四类中心 → 各自标签；谁都不像 → `unknown_novel`；低质量 → `unknown_low_quality`；
  非缺省参数下的 `ambiguous`；坏库（未知键、区间颠倒、缺权重、版本不符）被拒。
- 装载器 `engine/tests/test_diagram_json.cpp`：`library_version` → `library_path` 注入；非法版本号被拒（路径穿越口）。
