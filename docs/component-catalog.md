# 组件目录格式

**状态**：字段已冻结（2026-09-04，决策 D-030、D-036）。目录由引擎 `cuav_run --catalog` 生成（B-1、B-4），
黄金基准 `tests/golden/component-catalog.json` 于 2026-09-05 首次生成（八个组件），
**2026-09-06 随切片 ② 增到十二个**（新增四个场景运行时组件，按第 5 节「已有条目不变」的规则重生成）；
`engine/tests/test_catalog_golden.cpp` 按第 5 节规则比对。

**依据**：04 §8.1（组件库六类）、§8.4（组件至少声明的字段）；决策 D-013（连线规则）、
D-036（实现形态 Coder / 手写）；06 备忘录 §9A B-1。

---

## 1. 单一来源

组件目录**只由引擎生成**。框图画布（U-2）、应用服务 `GET /api/v1/components`（B-5，缓存）、
参数表单、连线校验全部读目录，不手抄规则。`port_compat` 由 C++ `can_connect()` 枚举导出，
画布上的连线合法性与引擎 `--validate` 的判定因此必然一致。

## 2. 顶层字段（已冻结）

| 字段 | 说明 |
|---|---|
| `schema_version` | 固定 `cuav-catalog/1` |
| `engine_version` | 引擎版本 |
| `generated_at` | 生成时间。**引擎库与 `cuav_run --catalog` 都不写它**（输出确定性，黄金基准才能逐字节比较）；应用服务缓存目录时自行记录取得时间 |
| `port_types[]` | 端口类型名清单，与 `engine/include/cuav/types.h` 的 `PortType` 一致 |
| `port_compat[]` | `[from_type, to_type, ok, reason?]` 全枚举 |
| `components[]` | 见第 3 节 |

## 3. `components[]`

| 字段 | 说明 |
|---|---|
| `type` | 组件类型名，框图 `nodes[].type` 引用它 |
| `category` | `source` / `channel` / `antenna` / `receiver` / `data` / `algorithm`（04 §8.1 六类：辐射源、信道、天线、接收机、数据、算法） |
| `display_name`、`description` | 显示名与说明 |
| `model_layer`、`model_level` | M1 / M2 / M3；E1 – E4 |
| `model_id` | 对应概念模型编号，可空 |
| `version` | 组件版本 |
| `ports` | `{in: [{name, type}], out: [{name, type}]}` |
| `dynamic_ports` | 可选，`{pattern: "link:<emitter_id>", type, source: "scene_binding"}`；场景绑定组件的端口按绑定生成 |
| `params[]` | 参数描述，见第 4 节 |
| `scene_bindable` | 是否允许 `scene_binding`；回放源永远为 `false` |
| `stateful` | 是否保持状态及复位语义 |
| `implementation` | `cpp`（手写）或 `coder`（MATLAB Coder 产物，D-036） |
| `source_ref` | Coder 产物必填：来源 `.m` 路径、MATLAB 与 Coder 版本、codegen 参数哈希 |

## 4. `ParamSpec`

| 字段 | 说明 |
|---|---|
| `name` | 参数名，框图 `params` 的键 |
| `type` | `number` / `string` / `enum` / `bool` |
| `unit` | SI 单位字符串（`Hz`、`dBm`、`s`、`m`……），无单位为空 |
| `min`、`max` | 数值范围，越界拒绝 |
| `default` | 缺省值；框图里不写的参数由此补 |
| `enum[]` | `type = enum` 时的取值 |
| `required` | 是否必填 |
| `description` | 说明 |
| `constraint` | 可选，跨参数约束的文本描述（如 `|offset_Hz| + bw_Hz/2 < fs_Hz/2`），校验在引擎实现 |
| `internal` | 可选，`true` 表示内部参数：由装载器解析注入（如按 `data_id` 解析出的 `manifest_path`），画布不显示，框图文件里出现即拒绝（04 §8.6，D-037） |
| `excludes[]` | 可选，互斥参数名：与本参数不能同时给出（如 `level_dBm` 与 `amplitude`）。注册表校验先拒，组件 `configure()` 再守一道，装载器映射为 `param_conflict`（2026-09-06，D-047） |

单位在目录不在框图；画布右侧参数面板显示 `unit`、`min`、`max`、`description` 与校验状态。

功率类参数的单位约定（D-047）：引擎内部 `|x|² = 功率 / mW`，`ToneSource.amplitude` 与 `NoiseSource.power` 是线性值（1.0 = 0 dBm），同组件另有 `level_dBm` / `power_dBm` 直接按 dBm 给，二者互斥。

## 5. 黄金基准规则

`tests/golden/component-catalog.json` 的比较规则是「**已有条目不变**」：已有组件的 `type`、
`ports`、`params` 任一改动即基准变化，必须记决策；新增组件允许，更新黄金基准时在 WORKLOG 记
一条。

## 6. 实现落点（2026-09-04，B-1）

- 参数描述：`engine/include/cuav/param_spec.h`（`ParamSpec` 与链式构造）；组件自描述 `ComponentInfo` 与
  `IComponent::describe()` 在 `engine/include/cuav/component.h`。
- 注册表与校验：`engine/include/cuav/registry.h`、`engine/src/registry.cpp`；`validate_params()` 按描述挡未知参数、
  缺必填、越界与枚举取值错误，报错文本一定含参数名；`Registry::create_configured()` = 构造 + 校验 + `configure()`。
- 目录导出：`engine/include/cuav/catalog.h`、`engine/src/catalog.cpp` 的 `catalog_json()`，输出确定性（组件按类型名排序，
  不含 `generated_at`）；`validate_catalog_entry()` 拒绝类别不在六类、Coder 产物缺 `source_ref`、参数既必填又带默认值。
- 一致性测试：`engine/tests/test_registry.cpp`，只给必填项即可构造、去掉任一必填两道闸都拒绝、默认值在自己的范围内。

首批八个组件的归属：

| 组件 | 类别 | M / E | 实现 |
|---|---|---|---|
| `ToneSource` 单音源 | source | M3 / E2 | cpp |
| `NoiseSource` 复高斯噪声源 | source | M3 / E2 | cpp |
| `AddMixer` 加法混合 | source | M3 / E2 | cpp |
| `FileReplaySource` 文件回放源 | data | M3 / E4 | cpp，`scene_bindable = false`；用户参数 `data_id`，内部参数 `manifest_path`（D-037） |
| `EnergyDetector` 能量检测 | algorithm | M2 / E2 | cpp；自 C-3（2026-09-12，D-063）起 `noise_mode ∈ {probe, sliding}`（缺省 `probe` 即既有算法；`sliding` = 带删截的滑动中位数噪声估计，D-026 交付形态）、`noise_window_frames` / `merge_gap_frames` / `band_power_dBm`；`scene_bindable`，绑站只为把 `site_id` 注入检测行（内部参数 `scenario_path / scenario_id / site_id`，不读场景文件）；逐帧经观察者上报 `detections.jsonl`，模型卡 `models/detection/README.md` |
| `DetectionSink` 检测汇聚 | algorithm | M2 / E1 | cpp |
| `SpectrumAnalyzer` 频谱分析 | algorithm | M3 / E2 | cpp；Welch 功率谱 dBFS，`SpectrumFrame` 首个生产者（P1-4a），与 Python、MATLAB `pwelch` 三方互证 |
| `ObservationTap` 观测点 | algorithm | M3 / E2 | cpp；用户参数 `op_id`，内部参数 `out_dir`；写 `spectrum.f32` / `envelope.f32` 与索引（B-3） |

切片 ② 新增四个（2026-09-06，G-2 / G-3，D-049）：

| 组件 | 类别 | M / E | 实现 |
|---|---|---|---|
| `ScenarioSource` 场景参数源 | data | M2 / E2 | cpp，`scene_bindable`，绑站点；**动态输出口** `link:<emitter_id>`，每条链路一路 `SceneParamFrame`；内部参数 `scenario_path` / `scenario_id` / `site_id`；实体与链路读数经观察者上报；**传播效应的十五个参数在这里声明**（D-058，见 §8） |
| `SceneEmitterSource` 场景辐射源 | source | M3 / E2 | cpp，`scene_bindable`，绑辐射源；按场景 `emission.waveform` 生成 tone / noise / burst，**归一化到发射期间单位功率（0 dBm）**；守铁律 4 |
| `SceneBoundChannel` 场景绑定信道 | channel | M3 / E2 | cpp，`scene_bindable`；施加增益、整数样点时延、多普勒相位斜坡；帧内零阶保持；拒回放数据（防线二、三） |
| `FreeSpaceChannel` 自由空间信道 | channel | M3 / E2 | cpp，定参 FSPL，原 P1-3 欠项，供解析锚点与标准算例用 |

切片 ④a 新增三个（2026-09-07，C-2，D-051 / D-050）：

| 组件 | 类别 | M / E | 实现 |
|---|---|---|---|
| `AntennaGain` 天线增益 | antenna | M3 / E1 | cpp，`scene_bindable = false`；解析式方向图（全向 / 高斯主瓣 `12·(Δ/θ)²` 截于副瓣底）+ 指向（固定或随航向）+ 五档极化失配表 + 馈线损耗；`scene` 是**可选输入口**，接了按帧里的离开角 / 到达角逐样点施加，不接按 `aspect_*` 常量方向；极化与馈线只在 `role = rx` 端各计一次 |
| `ReceiverFrontEnd` 接收机前端 | receiver | M3 / E2 | cpp；噪声系数生等效输入热噪声（与 `geo/link_budget.cpp` 共用 −174 dBm/Hz 常数）、增益、本振频偏、IQ 幅相不平衡、直流偏置；私有随机子流；`noise_mode = none` 供混合增强模式 |
| `AdcQuantizer` ADC 量化 | receiver | M3 / E2 | cpp；`bits` / `full_scale_dBm` / 削顶；**削顶是数据标记不是降级**，逐块进 `clip_count` 与 `state_reasons`，全程比例超 `degrade_clip_ratio` 才在 `flush()` 降级 |

同批给两个既有组件加参数（**缺省保持旧行为**，既有示例与产品基准一个字未改）：
`SceneEmitterSource.emit_at_tx_power`（真时按场景 `tx_power_dBm` 出电平，使 S0 读到发射功率本身）、
`SceneBoundChannel.gain_mode`（`link_budget` 为原口径，`path_loss_only` 只施加路损，
发射功率与两端天线增益由各自组件负责）。两种口径在真场景上给出同一电平，
对拍见 `engine/tests/test_channel.cpp` 的「增益口径等价」。

**动态端口**：`ScenarioSource` 是 `dynamic_ports` 的第一个使用者。`describe()` 在**未 configure**
的实例上调用，那时端口还不知道，所以目录里只有 `dynamic_ports` 的声明；`Graph::connect` 在
`configure()` 之后调用，那时 `outputs()` 已按场景的辐射源给出具体端口。画布据此生成端口列表。

## 7. 待写

- [x] 首版目录黄金基准 `tests/golden/component-catalog.json`（2026-09-05，`cuav_run --catalog` 生成，21763 字节）
- [ ] Coder 产物组件的 `source_ref` 填写示例（M-2）
- [ ] `AddMixer` 的类别现标 `source`，它其实是两路 IQ 相加的处理件；改动要记决策（08 报告 §15 ⑤）
- [x] D-053 的接口部分（L-1，2026-09-09）：端口类型 `BearingReport` / `ToaReport` / `PositionReport`（`port_types` 7 → 10、`port_compat` 49 → 100，既有 49 行逐字未变，仍是纯对角）；`SceneBoundChannel` 加内部参数 `site_id`（多站绑定，单站可省略即取唯一站，旧行为不变）；`IComponent::check_wiring()` 与错误码 `port_optional` 启用。黄金基准据此更新一次，差异逐项见 11 报告 §7.3
- [x] D-051 的接口部分（C-1，2026-09-07）：端口类型 `RecognitionList`（`port_types` 6 → 7、`port_compat` 36 → 49，既有 36 行逐字未变）；`PortSpec.optional`（为假时不输出，既有条目字节不变）。黄金基准 `tests/golden/component-catalog.json` 据此更新一次，WORKLOG 有记录
- [x] D-051 的天线与接收机（C-2，2026-09-07）：新增 `AntennaGain` / `ReceiverFrontEnd` / `AdcQuantizer`，`SceneEmitterSource.emit_at_tx_power` 与 `SceneBoundChannel.gain_mode` 加参；组件 12 → 15，黄金基准更新一次
- [x] D-051 / D-063 的检测升级（C-3，2026-09-12）：`EnergyDetector` 加 `noise_mode / noise_window_frames / merge_gap_frames / band_power_dBm` 与三个内部参数、`scene_bindable = true`（缺省保旧行为，`energy_detector.json` 黄金基准逐字节不变）。黄金基准据此更新一次，差异经脚本逐项核对只有这一条
- [ ] D-051 的其余组件（C-4 / C-5 / C-10 分批）：`FeatureExtractor` / `TemplateClassifier` / `Evaluator` / `DDC` / `Channelizer`
- [x] D-058 的传播效应（R-1，2026-09-10）：`ScenarioSource` 新增十五个参数（见 §8），组件数与端口表不变。黄金基准据此更新一次，差异经脚本逐项核对**只有这十五个参数**，其余组件的 `ports` 与 `params` 逐字未变

## 8. 传播效应参数（D-058，声明在 `ScenarioSource` 上）

传播效应的计算落在帧生产端（`geo::link_budget()`），所以参数声明在 `ScenarioSource` 的目录条目里；
**界面上它们显示在「传播信道」卡片的右栏**——靠典型链路槽位表的代理机制（`SlotDef.proxy`，12 报告 §5.3），
不是第二份声明。自由画布上它们照常出现在 `ScenarioSource` 节点的参数面板里。

| 参数 | 类型 | 缺省 | 含义 |
|---|---|---|---|
| `prop_level` | 枚举 `E1 / E2 / E3` | `E1` | 精度档（01 的 E1–E4），直接写进溯源的 `model_level`。**`E3` 收到即报错**，待 D3（切片 ⑤） |
| `prop_primary` | 枚举 `free_space / two_ray / urban_empirical` | `free_space` | 替代型主模型，**至多一个**（EM-P-13 §10.9 防重复计损） |
| `prop_shadow` | 布尔 | `false` | 统计阴影（EM-P-08） |
| `prop_weather` | 布尔 | `false` | 大气与降雨（EM-P-07） |
| `env_class` | 枚举 `open / suburban / urban / dense_urban` | `urban` | 环境类别：决定城市经验的 `n` 与偏置、阴影的 σ |
| `ground_type` | 枚举 `paved / grass / water / dirt / unknown` | `unknown` | 地面反射面材质，查 `εr / σ / 粗糙度` 表 |
| `ground_roughness_m` | 数值 m | `-1` | RMS 粗糙度；`-1` = 按 `ground_type` 取表值 |
| `coherence_rho` | 数值 [0, 1] | `1.0` | 双径的相干因子 `ρ_c` |
| `max_fade_depth_dB` | 数值 dB | `20` | 双径相消的限幅 |
| `path_loss_exponent` | 数值 | `-1` | 城市经验的 `n`；`-1` = 按 `env_class` 取表值 |
| `ref_distance_m` | 数值 m | `100` | 城市经验的参考距离 `d0` |
| `urban_loss_mode` | 枚举 `mean / mean_with_shadow_margin` | `mean` | 城市经验给均值还是「均值 + 90% 分位阴影裕度」 |
| `shadow_sigma_dB` | 数值 dB | `-1` | 阴影标准差；`-1` = 按 `env_class` × 视距取表值 |
| `shadow_corr_distance_m` | 数值 m | `50` | 阴影的空间相关距离 |
| `rain_rate_mmh` | 数值 mm/h | `0` | 降雨率 |

**三处哨兵用 `-1` 不用 `0`**：`0` 在 `ground_roughness_m`（理想光滑面）、`shadow_sigma_dB`（不起伏）、
`path_loss_exponent`（无意义但可判别）上都是字面取值，不能同时当「按表取」的标记。

**跨参数约束**在 `PropagationConfig::validate()` 一处（`geo/src/propagation.cpp`）：
`E3` 未实现即拒；`E1` 却选了主模型或效应即拒（不静默忽略）；城市经验取 `mean_with_shadow_margin`
再开 `prop_shadow` 即同源双计而拒。**`FreeSpaceChannel`（自由空间定参）不参与这套档位**：它不吃场景参数帧。
D-059（2026-09-10）把它从典型链路的槽位表里撤掉——那个页面上能跑的配置一定有场景，
手填固定距离永远是错的选择；组件保留供标准算例与手写框图用。
自由画布里仍可把它与高档位搭在一起，此时链路读数与实际施加的 IQ 不一致，属高级用法自负其责
（12 报告 §4.5）。

模型公式、参数来源与适用范围见模型卡 `models/channel/README.md`。
