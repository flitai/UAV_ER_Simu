# 模型卡：真值与评价 `Evaluator`（C-5，2026-09-14，D-067）

**定位**。评价不是模型，是「检测与识别对不对」的账本：把能量检测的逐帧判决（`detections.jsonl`）与模板识别的逐段结论（`recognitions.jsonl`）对照真值，出帧级 Pd / Pfa / precision / recall / F1、突发级检出与发现时延、ROC（对每帧的统计量扫门限，不重跑）、识别混淆矩阵与每类 P / R / F1。依据 10 报告 §4.5 与附录 C、04 §7.9「混淆矩阵、ROC、检出率、虚警率和 F1 等评价」与 §11.4 任务层指标、EM-S-02 §10.18。真值**只进这里**（04 §5.2「可供评价使用但不向被测算法泄漏」）：检测器、特征提取器与识别器都不接参数帧、不读场景。消费真值的组件按 11 报告 §1.3 的约束声明：`model_layer = M2`、`model_level = E2`、`credibility = V2`，产物带 `truth_consumed = true`；溯源 `model_id = eval-baseline`、`model_version 0.1.0`、`parameter_version eval-baseline-0.1`、`trace_id = Evaluator:<site_id>`。

实现：引擎组件 `engine/src/evaluator.cpp`（攒行、构造真值区间）与纯函数层 `engine/src/evaluation.cpp`（指标）；参考实现 `algos/reference/evaluate.py`，黄金基准 `engine/tests/golden/metrics.json`。产物：`truth.jsonl`（每段真值一行）与 `metrics.json`（`cuav-metrics/1`，`sites[]` 每个评价器一节即按站分节，D-053），格式见 `docs/display-products.md` §5.4 / §5.5。

## 1. 绑站与输入

评价器**绑站**（D-053 对 10 §4.5 的修正）：一个站的检测器看到的是 N 个源叠加后的信号，真值区间是这 N 条链路的并集，绑单个源会把其它源的发射算成虚警。多站下每站一个 `eval__<site>`，只收本站的参数帧（帧自带 `site_id`）。输入口：`det`（必连，本站检测器）、`rec`（可选，本站识别器；未接则识别一栏 `not_applicable`）、`scene1..scene8`（可选，本站对各源的链路参数帧；真值来源为 `scenario` 时至少一路）。

它是引擎里第一个**接受部分输入**的节点（`accepts_partial_inputs()`，D-067）：三路输入不同拍，任一路有数据就收下；上游全结束、缓冲全空才在 `flush()` 里算。没有这一条，识别器在收尾时才出的最后一段（demo-01 里就是**唯一**一段）到不了双输入节点。

## 2. 真值的三种来源

| `truth_source` | 帧真值 | 突发真值（`truth.jsonl` 的行） | 类别 |
|---|---|---|---|
| `scenario`（全合成、混合） | 活动级 `tx_on` 连续段（`tx_center_Hz` 变即切）∩ 波形门控 ∩ 检测频段 | `tone` / `noise` 一段一行；`burst` **每个导通窗一行**，门控在样点域与 `SceneEmitterSource` 同式：`period_n = ⌊period·fs + 0.5⌋`、`on_n = ⌊duty·period_n + 0.5⌋`、样点 `idx % period_n < on_n` | 按场景波形反查（§3 表一） |
| `manifest`（回放） | 清单 `truth.class_code` 非背景即全片为真，背景类全片为假 | 全片一行（`emitter_id` 与频率为 `null`）；背景类没有行 | 按清单类别映射（§3 表二） |
| `none` | 无 | 无 | 指标 `not_applicable`，只有计数 |

`in_band`：`[center ± bw/2]` 与检测频段 `[f_lo, f_hi)` 相交才算（带宽取场景 `emission.bw_Hz`——参数帧里没有带宽，评价器为此读场景文件，与 `DirectionFinder` 同法）。频段外的行照样落盘、只计 `truth_out_of_band`，不进分母（EM-S-02 §10.18 的 `not_observed`：没观测到不算漏检）。混合增强模式下 `data_id` 是背景片段：清单类别不是背景即 `degraded`「背景片段含目标，真值不完整」。

**为什么要把波形门控算进真值**：场景帧的 `tx_on` 是活动级开关（图传开 / 关），`burst` 波形的 80% 关断期在帧里仍是「开」。只看 `tx_on` 会把关断期都算成有信号，突发源的帧级 Pd 就没有意义；关断期是 H0，检测器在那里报警就是虚警。

## 3. 映射表（取值全部为 `assumed`）

**表一 场景波形 → `signal_role`**（10 报告 §4.5；只是「场景怎么造的」的反查，不是识别算法的一部分）：

| 波形 | 条件 | 标签 |
|---|---|---|
| `tone` | — | `cw_beacon` |
| `burst` | 该源无 `hop` 活动 | `telemetry_burst` |
| `burst` | 该源有 `hop` 活动（G-6） | `rc_hopping` |
| `noise` | `bw_Hz ≥ 1 MHz` | `video_link` |
| `noise` | `bw_Hz < 1 MHz` | `noise`（库里没有的额外标签，如实写出，混淆矩阵为它扩一行一列） |

**表二 清单类别 → `signal_role`**（两批公开数据集，`data/iq/measured/README.md`）：

| 类码 | 含义 | 标签 |
|---|---|---|
| `B`（DroneRFb-DIR）、`T0000`（DroneRFa） | 背景，现场无无人机 | 全片为假 |
| `T1xxxx`（DroneRFa） | 飞控器（FrSky X20、Futaba T14SG，915 MHz） | `rc_hopping` |
| 其余（DroneRFb-DIR `A1`–`G3`，DroneRFa `T0010` / `T0011`） | 无人机机载链路 | `video_link` |

回放模式全片一段、无频率——帧级指标只剩「命中率」（非背景片段没有负样本，Pfa 为 `null`；背景片段没有正样本，Pd 为 `null`），突发级与识别指标对公开数据集意义有限（10 报告 §10 风险表「回放真值粗」）。

## 4. 指标口径（C++ 与 Python 共同的契约，改动即基准变化，铁律 10）

- **帧真值**：帧中点 `t_s + nfft/(2·fs)` 落在任一 `in_band` 真值区间（先取并集）内。中点规则 = 「多数样点有信号」，导通窗与关断窗都长于一帧时与逐样点计数等价。
- **帧级**：`pd = tp/(tp+fn)`、`pfa = fp/(fp+tn)`、`precision = tp/(tp+fp)`、`recall = pd`、`f1 = 2PR/(P+R)`（P+R = 0 时 0）。
- **突发级**：检测段 = 命中帧按 `segment_id` 归组的 `[首帧 t_s, 末帧 t_s + dt)`；与真值段匹配当 `overlap / min(len_det, len_truth) ≥ match_overlap`（缺省 0.5）；`pd_segment` = 匹配上的真值段 / 频段内真值段；`false_segments` = 没匹配上任何真值的检测段；发现时延 = 首个匹配检测段起点 − 真值段起点，钳到 ≥ 0，给均值与最大。
- **ROC**：统计量升序，门限取 `sorted[⌊i·(n−1)/(P−1)⌋]`（`P = roc_points`，去重），判决用**严格大于**（与检测器同）；工作点取行里的门限，其 pd / pfa 与帧级逐位相同。ROC 不重跑：滑动噪声估计与命中的耦合（命中帧不入环）在扫门限时不再变化，曲线是「同一份噪声估计下换门限」。
- **识别**：只对匹配上真值段的检测段计；真值标签取重叠最大的真值段（并列取 `t_s` 早者、再 `emitter_id` 字典序）；标签序 = `[video_link, telemetry_burst, rc_hopping, cw_beacon]` + 其它（字典序）+ `unknown` 末位，方阵；`result = unknown` 计 `unknown` 列，`ambiguous` 计其 Top-1 列；`accuracy = Σ_{l≠unknown} C[l][l] / evaluated`；未匹配真值的识别行计 `unmatched`，不进矩阵。
- **分母为零**的比值一律 `null`，不用 0 顶替（铁律 15）。
- **状态**：`none` → `not_applicable`；没有检测行 → `invalid`；门限在运行中变化、命中帧无段号、参数帧里出现场景文件没有的源、混合模式背景含目标、scenario 模式一帧参数帧都没收到 → `degraded` 并记原因。

参数：`truth_source`（缺省 `scenario`）、`data_id`（回放 = 真值来源；混合 = 背景片段）、`nfft`（须等于检测器，装载器核对）、`match_overlap` 0.5、`roc_points` 32。典型链路里前三项都由框图页派生（模式 → 真值来源；检测器 → nfft；信号源 / 背景 → data_id），用户只改后两项。

## 5. 已知边界（不是缺陷，是口径）

1. **源按块起点门控 `tx_on`**（`SceneEmitterSource`，缺省块长 65536 样点 = 131 ms @ 500 kS/s），真值按场景帧（50 ms）算：每个开关边沿有至多一块的错位。demo-01 的 `tx_on` 在 3.000 s，IQ 从 3.014656 s 起——7 帧漏检、发现时延 14.7 ms，就是它。
2. **`in_band` 用的是声明带宽** `emission.bw_Hz`，不是波形实际占用（单音实际只占一个 bin）。
3. **`noise_stale_frames` 为 `null`**：检测摘要不在端口上，评价器拿不到，不编；要看它去 `detections.index.json`。
4. **EM-S-02 §10.18 的七类细分**（`missed_due_to_scan / energy / noise`、`background_detection`…）本期只做 tp / fp / fn / tn 四格与 `truth_out_of_band`，细分留后置。
5. **回放模式**突发级与识别指标对公开数据集意义有限（§3）。
6. **连续发射从 t = 0 起会被滑动删截的环吸收**（检测模型卡 §4）——这是检测器的行为，评价器如实记成漏检；demo-03 两站因此 Pd 接近 0。要比对解析式，用突发源（§6 第三条）。

## 6. 验证（macOS，原型阶段验证值，D-028）

- **黄金基准** `engine/tests/golden/metrics.json`：`evaluate.py --write-golden` 用 64 位 LCG 造 600 帧——含漏检、虚警、一段频段外真值、额外标签 `noise`、unknown 与 ambiguous、四个不与帧边界对齐的突发窗、两段重叠的同类真值；C++ 侧 `evaluate()` 经 `metrics_section_json()` 与 `expected` 逐值比（整数逐位、浮点 rel ≤ 1e-9、null 对 null），222 条断言全过（`engine/tests/test_evaluation.cpp`）。
- **组件级**（`engine/tests/test_evaluator.cpp`）：`tx_on` 连续段成区间、`tx_off` 断开、中心频率变化切段、频段外只标记、不在场景里的源记降级、突发按门控切窗、manifest 两类、跨轮重发的帧去重、持续到结束的单音段的识别行到得了评价器、`init()` 不碰随机流。
- **典型链路**（demo-01 6 s，`cuav_run` 与 `slice4-smoke`）：真值一行 `[3, 6)`；2929 帧 tp 1457 / fp 1 / fn 7 / tn 1464，Pd 0.9952、Pfa 0.00068、F1 0.9973；一段匹配、时延 14.7 ms；识别 1 段准确率 1.0；ROC 32 点；`evaluate.py` 逐值一致；`task.json.metrics_summary` 与之相等。
- **跨层一致性算例 ①**（`tests/regression/crosslayer_pd_chain.py`）：定点 `burst` 源、带内信噪比 −8.99 dB、M = 921 bin、η = 1.104928——解析确定型 Pd **0.7164**，典型链路蒙特卡洛 Pd **0.7026**（19531 帧，真值帧 3931），**差 0.0138 ≤ 0.05**（04 §16.3 建议 0.05–0.10 取严者），偏低方向与预期一致（漏检的导通帧进噪声环，估计略偏高）；Pfa 0.00147 对目标 0.001；突发级 78 / 79。参数在跑之前按解析预测冻结，首跑即过、未调参。
- **多站**（demo-03，`slice6-smoke`）：三节按站分节、`uav-2` 每站两段（30 s 关、40 s 开）、`uav-3` 突发按导通窗切行；两站 Pd 接近 0 是检测器吸收连续发射的真实后果，如实记，不作判据。
