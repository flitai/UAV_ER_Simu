# 组件目录格式

**状态**：字段已冻结（2026-09-04，决策 D-030、D-036）。目录由引擎 `cuav_run --catalog` 生成（B-1、B-4），
黄金基准 `tests/golden/component-catalog.json` 已于 2026-09-05 由它首次生成（八个组件），
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

单位在目录不在框图；画布右侧参数面板显示 `unit`、`min`、`max`、`description` 与校验状态。

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

现有八个组件的归属：

| 组件 | 类别 | M / E | 实现 |
|---|---|---|---|
| `ToneSource` 单音源 | source | M3 / E2 | cpp |
| `NoiseSource` 复高斯噪声源 | source | M3 / E2 | cpp |
| `AddMixer` 加法混合 | source | M3 / E2 | cpp |
| `FileReplaySource` 文件回放源 | data | M3 / E4 | cpp，`scene_bindable = false`；用户参数 `data_id`，内部参数 `manifest_path`（D-037） |
| `EnergyDetector` 能量检测 | algorithm | M2 / E2 | cpp |
| `DetectionSink` 检测汇聚 | algorithm | M2 / E1 | cpp |
| `SpectrumAnalyzer` 频谱分析 | algorithm | M3 / E2 | cpp；Welch 功率谱 dBFS，`SpectrumFrame` 首个生产者（P1-4a），与 Python、MATLAB `pwelch` 三方互证 |
| `ObservationTap` 观测点 | algorithm | M3 / E2 | cpp；用户参数 `op_id`，内部参数 `out_dir`；写 `spectrum.f32` / `envelope.f32` 与索引（B-3） |

## 7. 待写

- [x] 首版目录黄金基准 `tests/golden/component-catalog.json`（2026-09-05，`cuav_run --catalog` 生成，21763 字节）
- [ ] Coder 产物组件的 `source_ref` 填写示例（M-2）
