# 辐射源模板规范（实测数据集驱动的特定无人机信号再生）

**状态**：草案（2026-09-05，决策 D-045）。模板的定位、三种模式、字段名与进入仿真链的规则已定；
提取口径中的阈值（占用判据、突发门限、裕度）待 T-0 探针在真实数据上跑过后冻结（06 备忘录 §9F）。
本文件只定义「模板」这一数据产物与它进入仿真链的规则，不定义生成组件的实现。

**依据**：04 号方案 §7.2（三类辐射源模型）、§4.3（混合增强）、§11.2（四组数据）、§11.3（标定流程）、
§11.4（七层比较指标）、§11.5（混合建模建议）；02 号方案 §7.1、§7.2（模板支持实测片段引用，波形来源含
实测片段）；03 号方案 §12.2.2（实测回放 / 实测特征驱动 / 协议机理三层）；概念模型 EM-B-09 §11.3 与
EM-T-03 §11.3 的参数名；`CLAUDE.md` 铁律 8、9、14、15；决策 D-018、D-019、D-028、D-037、D-038、D-039、
D-042、D-043、D-045。

---

## 1. 模板是什么，不是什么（已定）

1. **模板是从实测数据集提取的、与位置无关的辐射源描述**。特征模式下它是一组参数（频段、谱形、突发
   节律、峰均比等）；回放模式下它是对若干实测片段的引用（`data_id` 与内容哈希）加归一化与拼接规则。
2. **模板归一化到单位功率，不含任何功率标定信息。** 绝对电平由场景配置（辐射源 `tx_power_dBm`、
   天线增益、链路预算、接收增益）经链路预算得出。数据集未记录的发射功率、位置与方位、天线增益、
   噪声系数、接收增益都是场景与设备的配置项，按实际情况设置即可（用户 2026-09-05 确认）。配置值
   带来源字段随产物走，界面不显示（铁律 8、14；D-042）。
3. **模板不是 IQ 产物。** 生成 IQ 的是 M3 组件 `TemplateSource`（06 §9F T-4），模板只是它的参数。
   概念模型库「不生成 IQ」的边界不变（`docs/concept-model-extensions.md` §1）。
4. **公开数据集片段不得绑定地理场景（06 防线二、三）不变。** 模板可以绑定，因为绑定场景的是合成
   辐射源，模板本身与位置无关。`FileReplaySource.scene_bindable = false` 保持；`TemplateSource`
   可 `scene_bindable = true`，溯源必带 `template_id → source.data_ids`。

## 2. 三种模式（已定，三种都要）

| 模式 | 04 出处 | 数据集提供 | 模型提供 | 等效档 | 适用边界 |
|---|---|---|---|---|---|
| `replay` 回放模板 | §7.2 之 ② | 高信噪比片段本身（DroneRFb 10 m 视距片；DroneRFa 20–40 m 档） | 循环拼接、单位功率归一化、频移、重采样、施加信道、新背景与噪声 | 波形 E4 / L3 | 能呈现的**信噪比有上限**（第 6 节）；片段短（DroneRFb 50 ms）须循环，拼接缝要处理 |
| `feature` 特征等效 | §7.2 之 ③ | 中心频率、占用带宽、谱形、突发长度 / 周期 / 占空比、频段切换、峰均比 | 按参数再生的类别级波形：带限成形噪声 + 突发门控；跳频用音跳；P3 换 OFDM / FHSS 参考（M-5） | 波形 L2，参数 L3 | 信噪比与距离不受限；无协议内容、无个体指纹（04 §7.2 本来就暂缓这些） |
| 混合增强背景 | §4.3 / §7.8 | 62 + 3 片真实背景 | 合成目标（上两种任一）+ `AddMixer` | 背景 E4 | DS-7 已在谱域证明可行；引擎 `AddMixer` + `FileReplaySource` 已能在 IQ 域做 |

**首选 `feature` 为主线**：演示时能讲清「模板参数从实测拟合，波形按参数再生，传播与接收机按模型施加」，
且不受回放模式的信噪比上限约束。`replay` 作近距离高保真对照，混合增强作背景。

## 3. 链路七个环节各由谁供给（已定）

| 环节 | 数据集能给 | 数据集未记录，由场景与设备配置给 | 承接的步骤 |
|---|---|---|---|
| 波形模板 | 中心频率、占用带宽、谱形、突发统计、频段切换、峰均比 | 协议内容、符号率、调制方式（本期不做） | T-0 / T-3 |
| 发射功率 | 无 | `emitters[].emission.tx_power_dBm`，默认取机型规格书并记来源 | 场景配置 |
| 几何 / 距离 / 方位 | DroneRFa 三档距离区间（只作参考距离） | 场景航线；方位只经天线方向图进入，首期 `omni` 时方位对结果无影响 | G-1 / G-2 |
| 传播 | 路损粗档 n ≈ 2（D-019）；视距 / 非视距附加损耗分布可实测（DroneRFb 同距 10 m 成对片） | 自由空间路损、遮挡、双径 | G-1 / G-3 / D3 |
| 天线 | DroneRFa 3 dBi（论文） | `sites[].antenna`、`emission.antenna_gain_dBi`，方向图表 | 场景配置 / EM-B-07 |
| 接收机与噪声 | 底噪（dBFS）、正交不平衡样本、约 12 有效位、真实背景 | 噪声系数、增益、AGC、满量程对应的 dBm | P1-3 / M-2 / M-5 |
| 观测与检测 | 环境代价（DS-7 已测） | — | 已有组件 |

## 4. 文件与字段 `cuav-emitter-template/1`（字段名已定，取值口径待 T-0）

文件位置：`data/iq/templates/<template_id>.template.json`。模板是小文件（谱形一百余个数），**可入库**；
回放模式模板只登记 `data_id` 与内容哈希，不复制样点。`template_id` 匹配 `[a-z0-9_-]{1,64}`，例如
`dronerfb_d_mini4pro_2g4_feature_v1`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | string | 是 | 固定 `cuav-emitter-template/1` |
| `template_id` | string | 是 | 见上 |
| `mode` | enum | 是 | `replay` / `feature` |
| `drone_class` | object | 是 | `{dataset_class_code, class_name, platform_type}`；`platform_type` 取 `docs/scenario-format.md` §4 的枚举 |
| `source` | object | 是 | `{dataset, split, data_ids[], content_sha256[], holdout_checked_utc}`。`replay` 模式列出被回放的片；`feature` 模式列出拟合所用的片。`split` 必须是训练集或与验收集无交集的片（`tools/freeze_holdout.py --check`） |
| `band` | object | 是 | `{center_Hz, obw_Hz, channel_set[{center_Hz, count}]}`，绝对频率。`channel_set` 是源片段里观察到的信道集合（按 1 MHz 取整的频段中心与片数），对应 EM-T-03 `frequency_plan_profile` |
| `psd_shape` | object | 是 | `{f0_Hz, step_Hz, values_dB[]}`，带内平均功率谱按 1 MHz 栅格、峰值归一到 0 dB，对应 EM-B-09 `psd_shape_template` |
| `burst` | object | 是 | `{state, duty, len_s_median, period_s_median, gap_s_median}`，`state ∈ {continuous, bursty, absent}`，对应 EM-B-09 `duty_cycle_profile` 与 EM-T-03 `temporal_pattern_profile` |
| `hop` | object | 否 | `{dwell_s, set_summary}`，只在遥控链路（跳频）模板出现，对应 EM-B-09 `hop_set_summary`；真实跳频序列不记录（04 §7.2 暂缓项） |
| `papr_dB` | number | 是 | 带内信号在活动帧上的峰均比 |
| `headroom_dB` | number | 是 | 模板余量：源片段带内功率高出底噪的分贝数，即 04 §11.2 A 组「高信噪比参考」的量化 |
| `contamination_dB` | number | 是 | 同频背景污染：同站背景在该频段内高出底噪的分贝数 |
| `d_ref_m` | object | 是 | `{value, source}`；DroneRFb 为 10（`paper`），DroneRFa 为区间中点（`assumed`，D-019） |
| `snr_ceiling_dB` | number | `replay` 必填 | 回放模式能呈现的最大带内信噪比 = `headroom_dB − margin_dB`（第 6 节） |
| `tx_power_default` | object | 是 | `{eirp_dBm, source, note}`，`source ∈ {measured, paper, assumed}`；只是默认值，场景 `tx_power_dBm` 覆盖它 |
| `model_layer` / `model_level` / `credibility` / `equivalence_level` | enum | 是 | 铁律 8 的分级：`M3`；`replay` 为 `E4` / `L3`，`feature` 为 `E2`（参数 E4 标定）/ `L2`；`credibility` 按 V1–V5 |
| `model_id` / `model_version` / `parameter_version` / `confidence` / `trace_id` | — | 是 | 铁律 8 六件套的其余字段 |
| `quality` | object | 是 | `{status, reasons[]}`，四态 `valid / degraded / invalid / not_applicable`（铁律 15）；来自公开数据集的模板一律至少 `degraded`，原因写「采集参数来自论文」 |
| `trace` | object | 是 | `{producer, created_utc, params_hash, inputs_hash}`；`producer` 是提取器名与版本 |

## 5. 提取口径（草案，阈值待 T-0 冻结）

以下口径与既有工具保持一致，改动须同步 `tools/iq_survey.py` 与 `scripts/da6_pathloss.py` 的注释。

1. **功率谱**：8192 点汉宁窗、不重叠、线性域平均；底噪取平均功率谱在频率维的第 10 百分位
   （`tools/iq_survey.py` `NOISE_FLOOR_PCT`）。
2. **频段定位**：相对**同站背景的中位功率谱**求超出量，按 1 MHz 平滑，取高出 6 dB 的最强连通段
   （宽度不小于 2 MHz）作为该片的无人机频段。不用固定频段：2026-09-05 抽样看到图传信道在片与片
   之间切换（WORKLOG 同日条目），模板须按片定位并汇总成 `band.channel_set`。
3. **模板余量与污染**：带内平均功率谱减底噪为 `headroom_dB`；背景中位谱在同一频段内减底噪为
   `contamination_dB`。
4. **突发统计**：约 50 µs 帧（80 MS/s 时 4096 点）的带内功率序列，门限为带内噪声功率加 6 dB；
   占空比 < 2% 判 `absent`，> 98% 判 `continuous`，其余 `bursty` 并给突发长度、间隔与周期的中位数。
5. **谱形与峰均比**：带内谱按 1 MHz 栅格、峰值归一；峰均比在活动帧上按带内滤波后的样点计。
6. **视距 / 非视距**：同机型视距片与非视距片的 `headroom_dB` 之差给遮挡附加损耗分布（均值与
   标准差），供跨层一致性算例 ② 的量级核对（06 §12）。
7. **验收集拦截**：任何进入模板的片必须先过 `tools/freeze_holdout.py --check`，命中即中止。
8. **数字口径**：全部标「原型阶段验证值」（D-028），甲方数据到货后按同一脚本重跑。

## 6. 回放模式的信噪比上限（已定）

实测片段 = 无人机信号 + 采集站底噪 + 同频背景（WiFi 等）。回放时把片段按链路预算缩放 ΔL 分贝再
加入场景接收机的新噪声，三者一起缩放。于是：

- 片段自带的底噪与背景在缩放后落在新底噪之下 `ΔL − contamination_dB` 分贝处；当
  `ΔL ≥ contamination_dB + margin_dB` 时可忽略，**往远处推反而越干净**。
- 片段无法向比录制更高的信噪比推：带内信噪比不可能超过 `headroom_dB`，扣除裕度后
  `snr_ceiling_dB = headroom_dB − margin_dB`。场景里要求更高信噪比的情形（近距离、高增益接收）
  只能用 `feature` 模式。
- 引擎在运行时比较场景链路预算给出的带内信噪比与 `snr_ceiling_dB`，超出即把结果标 `degraded`
  并写原因，不静默（铁律 15）。
- 拼接缝：DroneRFb 每片 50 ms，回放须循环；拼接处的相位与突发节律不连续是已知残差，T-4 定处理
  办法（在突发间隙处拼接，或按突发周期整数倍截取）。

`margin_dB` 首期取 10 dB（自带噪声对新底噪的贡献小于 0.5 dB），待 T-0 回填。

## 7. 进入仿真链的规则（已定，实现待 T-3 / T-4）

1. 场景文件 `emitters[].emission.waveform` 增加类型 `{type: "template", template_id}`
   （`docs/scenario-format.md` §4、§9）。模板文件路径是内部参数，画布与框图只见 `template_id`
   （与 D-037 的 `data_id` 同法）。
2. `TemplateSource` 是 M3 源组件：`feature` 模式按参数再生，`replay` 模式循环拼接源片段；两种模式
   输出都归一到单位功率，再由场景绑定信道（G-3 `SceneBoundChannel`）按 `SceneParamFrame` 施加路损、
   时延与多普勒。模板不绕过 M1/M2 自行硬编码传播或噪声参数（CLAUDE.md「向下参数注入」）。
3. 溯源：产物的六件套里 `trace_id` 带 `template_id`，模板文件的 `source.data_ids` 指回实测片段，
   于是任何再生产物都能追到它依据的实测片。再生产物进 `data/iq/synthetic`（纯合成）或
   `data/iq/mixed`（叠了实测背景）时，`origin` 引 `template_id`（`docs/iq-format.md` §9）。
4. 界面不解释模板来自哪个数据集、是否估算（D-042、D-043）；这些信息只在数据层与文档里。

## 8. 验证与校准

- 再生波形与源片段按 04 §11.4 七层比较（数据层、频域层、时域层、时频层、复统计层、趋势层、
  任务层），比较工具与模型卡图表在 MATLAB 内部生成（06 §9D M-5）。
- 跨层一致性算例 ④（实测背景 + 合成目标）以模板再生的目标重跑 DS-7，与 M2 预测比对。
- 独立验证用 04 §11.2 的 D 组：DroneRFb 验收集（2487 片，含 6 架从未参与拟合的个体）。

## 9. 待写

- [ ] T-0 探针回填：占用判据、突发门限、`margin_dB`、各机型的 `headroom_dB` / `contamination_dB`
      分布、视距 / 非视距附加损耗分布、DroneRFa 三档与 DA-6 的交叉核对、按论文参数的量级核对
- [ ] `docs/schemas/emitter-template.schema.json`
- [ ] `feature` 模式 P3 扩展字段：OFDM / FHSS 参考波形的参数（随 M-5）
- [ ] 回放拼接缝的处理规则（T-4）
- [ ] 甲方数据到货后的模板重生成与版本冻结（04 §11.3 第 8 步）
