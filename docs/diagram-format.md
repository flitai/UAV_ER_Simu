# 框图文件格式

**状态**：骨架，字段已冻结（2026-09-04，决策 D-030、D-032）。引擎装载器（B-2）与框图画布（U-2）
尚未实现，实现时以本文为准；要改字段先改本文并记决策。机器可读版本：`docs/schemas/diagram.schema.json`。

**依据**：04 §8.2（框图能力：端口兼容性检查、中间观测点、错误定位到模型与端口）、§8.4（组件
声明）、§8.6（错误码映射到框图、模型、端口）；决策 D-013（连线校验）、D-030、D-032；
06 备忘录 §9A B-2、§9B U-2。

---

## 1. 用途与消费者

| 消费者 | 动作 |
|---|---|
| 框图画布（U-2） | 保存 / 载入 / 提交；连线合法性查组件目录的 `port_compat`（`docs/component-catalog.md`），不手抄规则 |
| 应用服务（B-5） | `POST /api/v1/tasks` 的载荷；只做 schema 校验与落盘，不解释语义 |
| 引擎 `cuav_run --validate` / `--run`（B-2、B-4） | 装成 `Graph`，执行连线校验、拓扑排序与运行；错误定位到 `node_id + port` |
| 回归测试（P1-7） | 算例框图入 `tests/regression/diagrams/`，与黄金结果配对 |

同一份文件三处消费，**语义只在引擎一处解释**。画布与服务的校验是引擎规则的投影，冲突以引擎为准。

## 2. 顶层字段（已冻结）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | string | 是 | 固定 `cuav-diagram/1` |
| `diagram_id` | string | 是 | `[a-z0-9_-]{1,64}`，稳定标识，改名不改 id |
| `name` | string | 是 | 显示名，可含中文 |
| `nodes` | array | 是 | 节点，第 3 节 |
| `edges` | array | 是 | 连线，第 4 节 |
| `observation_points` | array | 否 | 观测点，第 5 节；缺省为空 |
| `run` | object | 是 | 运行参数，第 6 节 |
| `scenario_ref` | object | 否 | 场景引用，第 7 节；任一节点带 `scene_binding` 时必填 |
| `trace` | object | 否 | `{created_by, created_at, parent_diagram_id, notes}` |

未知键一律拒绝，引擎、服务、画布三处同规则，避免「写了没生效」。

## 3. 节点 `nodes[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 框图内唯一，`[a-z0-9_-]{1,64}` |
| `type` | string | 是 | 组件类型名，必须存在于组件目录 `components[].type` |
| `label` | string | 否 | 显示名 |
| `params` | object | 是 | 参数名到值；名与类型按目录 `params[]` 校验；单位在目录不在框图；缺省值由目录补，框图里不写 |
| `position` | `{x, y}` | 否 | 仅画布使用，引擎忽略 |
| `scene_binding` | object | 否 | `{scenario_id, entity_id}` 或 `{scenario_id, site_id}`；只有目录 `scene_bindable = true` 的组件可带；回放源永远不可带（06 防线二、三） |

参数值只有四种类型：`number` / `string` / `enum`（string，取值受目录 `enum[]` 限制）/ `bool`。
数组与嵌套对象不允许；需要时拆成多个参数，或用版本号引用随组件包走的外部数据（如 FIR
系数用 `fir_version`）。

源组件的 `total_samples` 若未写，由装载器按 `run.duration_s × sample_rate_Hz` 补；显式写了以
显式值为准，且不得超过全局时长。

**参数值不得是服务器路径**（04 §8.6；决策 D-037）。对实测数据的引用一律用数据索引里的标识
`data_id`（`data/iq/measured/<batch>/index.manifest.json`，如 `dronerfb_0_CH0_S4`），由服务端在任务装载时
解析成文件位置并以**内部参数**（目录里 `internal: true`，如 `manifest_path`）注入组件；框图文件里出现
任何内部参数即校验失败。回放节点写法：

```json
{ "id": "replay", "type": "FileReplaySource", "params": { "data_id": "dronerfb_0_CH0_S4" } }
```

## 4. 连线 `edges[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | |
| `from` | `{node, port}` | 是 | 输出口 |
| `to` | `{node, port}` | 是 | 输入口 |

规则（引擎 `Graph::connect` 与 `can_connect()`，画布读 `port_compat` 得到同一结果）：

1. 端口类型兼容按目录 `port_compat`。
2. 一个输入口只能接一条边。
3. `IQStream` 与 `SceneParamFrame` / `ChannelPathSet` 不得直连，中间必须经"施加"类组件（D-013）。
4. 有环拒绝。

错误报文 `{code, node_id, port, message}`，画布据此高亮节点与端口。

## 5. 观测点 `observation_points[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 产品目录名 `data/runs/<task_id>/<id>/` |
| `node`、`port` | string | 是 | 必须是 `IQStream` 类型的**输出口** |
| `products` | array | 是 | `spectrum` / `envelope` / `iq` 的子集，至少一项 |
| `label` | string | 否 | 显示名 |
| `params` | object | 否 | 观测点组件 `ObservationTap` 的参数（nfft、窗、桶长），缺省由目录补 |

引擎装载时在该输出口后并联一个 `ObservationTap` 节点，不改用户的边。产品格式见
`docs/display-products.md`。

## 6. 运行参数 `run`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `seed` | integer ≥ 0 | 是 | 铁律 9；框图内全部随机源由此派生 |
| `duration_s` | number > 0 | 是 | 逻辑仿真时长 |
| `block_size` | integer | 否 | 调度块长，缺省由引擎定；组件不得假设块长 |
| `time_basis` | string | 是 | 首期固定 `LogicalSim`（铁律 3）；回放源的文件采集时间在产物元数据里另记 |
| `max_rounds` | integer | 否 | 调度轮数上限，防死循环 |

## 7. 场景引用 `scenario_ref`

`{scenario_id, sha256}`。引擎装载时核对场景文件哈希，不一致则任务 `invalid`。场景文件格式见
`docs/scenario-format.md`。

## 8. 示例（切片 ① 的框图）

参数名以引擎组件目录（`cuav_run --catalog`）为准；下面的名字取自现有源码
`engine/src/{sources,processing}.cpp`。`SpectrumAnalyzer` 是 P1-4a 待实现的组件。

```json
{
  "schema_version": "cuav-diagram/1",
  "diagram_id": "slice1-tone-noise-psd",
  "name": "单音加噪声到功率谱",
  "nodes": [
    { "id": "tone",  "type": "ToneSource",  "params": { "sample_rate_Hz": 1e6, "offset_Hz": 100e3, "amplitude": 0.5 } },
    { "id": "noise", "type": "NoiseSource", "params": { "sample_rate_Hz": 1e6, "power": 1.0 } },
    { "id": "mix",   "type": "AddMixer",    "params": {} },
    { "id": "psd",   "type": "SpectrumAnalyzer", "params": { "nfft": 1024, "window": "hann" } }
  ],
  "edges": [
    { "id": "e1", "from": { "node": "tone",  "port": "out" }, "to": { "node": "mix", "port": "a" } },
    { "id": "e2", "from": { "node": "noise", "port": "out" }, "to": { "node": "mix", "port": "b" } },
    { "id": "e3", "from": { "node": "mix",   "port": "out" }, "to": { "node": "psd", "port": "in" } }
  ],
  "observation_points": [
    { "id": "s4", "node": "mix", "port": "out", "products": ["spectrum", "envelope"], "label": "S4 观测点" }
  ],
  "run": { "seed": 20260904, "duration_s": 2.0, "time_basis": "LogicalSim" }
}
```

## 9. 待写

- [ ] 首版组件目录生成后，把示例里的参数名与目录逐一核对（B-4）
- [ ] 画布序列化的黄金基准 `tests/golden/diagram-slice1.json`（U-2）
- [ ] 子系统封装与模板（04 §8.2，P2）
