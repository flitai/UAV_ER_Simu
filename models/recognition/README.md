# 识别模型卡：`TemplateClassifier` 与模板库 v1 / v2（C-4，2026-09-13；Q-4c，2026-10-09）

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

## 6. 模板库 v2（Q-4c，2026-10-09，D-094）

**用途**：分子带口径（`feature_basis = subband`）。检测器开了分子带，典型链路自动把特征、识别与评价切到分子带段、库取 v2；
关着仍是帧级突发、库 v1（v1 一个字节没动，守既有基准）。口径表、区间规则与判据写在 14 号报告 §8.6，动手前定死。

**格式 /2**：模板有唯一 `id`、标签可以重复——一个标签取它几个模板里似然最大的那个（不求和），后验与 `top_n` 按标签算，
识别行多一个 `template`。库声明 `feature_basis`，必须等于识别器的 `basis`（装库时核对），特征行逐行核对，装载器沿
det → feat → rec → eval 核对口径一致。

**怎么来的**：`scripts/gen_recognition_library.py` 由校准统计 `v2-calibration.json`（`algos/reference/q4c_feature_survey.py`，
只取校准集 `tests/regression/eval-dataset/calib-v1.json` 与 golden 场景，**不含试样集**）加 Q-0b 实测（预设出处点名的组、
可比的三项）按规则机械生成，`--check` 核对逐字节；统计表两次整跑逐字节相同。不手改。

| 标签 | 模板 | 来源 |
|---|---|---|
| `video_link` | `ofdm_video`、`noise_video` | Q-2 图传预设合成 + DroneRFb 六型与 Mavic 3 实测；golden-02 带限噪声 |
| `telemetry_burst` | `burst_fixed` | golden-03 定频突发 |
| `rc_hopping` | `ofdm_uplink`、`gfsk_fhss`、`burst_hopping` | Q-2 上行预设 + 实测；Q-3 FrSky / S-FHSS + FrSky X20 实测；golden-02 跳频突发 |
| `cw_beacon` | `tone` | golden-01 / 03 单音 |
| `droneid` | `droneid` | Q-2 DroneID 预设（无实测） |

各模板的区间与逐特征出处档（`S` / `S+M`）见 `library-v2.json` 本身。

**判决门限跟库走**：库 /2 可带 `decision.accept_threshold`，识别器的 `accept_threshold` 不再有目录缺省——框图给了用框图的，没给取库的，
库也没有取 0.5（v1 一字不变）。v2 取 **0.3**：五个标签里图传、上行、DroneID 三类 OFDM 突发在带宽与时长上相邻，正确类落在自己的区间里
（D = 0）时常有一两个邻类贴着，后验被摊到 0.38–0.49；「至多两个同样近的邻类也接受」= 1 / (3 + e^−2) ≈ 0.32。只在校准集上量过
（14 号报告 §8.6 有前后两组数）：图传 0.861 → 0.961、上行 0.825 → 0.999、DroneID 0.875 → 0.900、GFSK 0.996 → 1.000（标签准确率，校准集内）。

**试样集**（14 号报告 §8.7；判据只对单源视距 s02–s05，宽带与交付 S4 两种链路都 ≥ 0.9）：s02–s05 两种链路都是 **1.000**；
多源 s07 0.947 / 0.892、非视距 s09 0.910 / 0.740（宽带 / S4），只报数。库与试样集是同一批预设，这是回归护栏不是独立验证。

**已知边界**：

- **真实图传会被判成遥控**（实测回放，只报数）：真实 DJI 图传在本方特征提取下平坦度中位 0.67–0.88，库 v2 图传模板的平坦度区间只取了合成数据
  [0.93, 1]（本方合成图传太平，Q-2 记过的真实感差距），线性特征的尺度是半区间宽（0.035），差一点就是很大的距离。DroneRFb 六型十二片里
  ≥ 7 MHz 的段 375 个只有 160 个判成图传。修它要另立规则：用本方特征提取在实测训练片上量平坦度——下一版库的事。
- **虚警段也会被判上标签**：突发开关的频谱泼溅特征与旁边的真突发一样；它们不进混淆矩阵，但界面上「判成图传的段」里有它们。
- DroneID 与 10 MHz 图传同宽（9.015 MHz），只靠时长（0.643 对 ≥ 0.93 ms）分；检测器并掉的 DroneID 识别救不回来。
- 「占用相差不到 2 倍的上一段」是关联的粗代用；单突发分不清同频重发的跳频与定频突发。
- 连续发射的旧合成波形模板（单音、带限噪声图传）只有 2–4 行校准数据，区间很薄。
