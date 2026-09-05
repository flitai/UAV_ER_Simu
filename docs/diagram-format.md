# 框图文件格式

**状态**：字段已冻结（2026-09-04，决策 D-030、D-032）。**引擎装载器 B-2 已实现**（2026-09-05，
`engine/include/cuav/diagram_json.h`，四项口子见决策 D-040）；框图画布（U-2）尚未实现，实现时以本文为准；
要改字段先改本文并记决策。机器可读版本：`docs/schemas/diagram.schema.json`。

**依据**：04 §8.2（框图能力：端口兼容性检查、中间观测点、错误定位到模型与端口）、§8.4（组件
声明）、§8.6（错误码映射到框图、模型、端口）；决策 D-013（连线校验）、D-030、D-032；
06 备忘录 §9A B-2、§9B U-2。

---

## 1. 用途与消费者

| 消费者 | 动作 |
|---|---|
| 框图画布（U-2） | 保存 / 载入 / 提交；连线合法性查组件目录的 `port_compat`（`docs/component-catalog.md`），不手抄规则 |
| 应用服务（B-5） | `POST /api/v1/tasks` 的载荷；只做最小结构检查、内部参数拒绝、`data_id` 解析与落盘，随后同步调 `cuav_run --validate`，不解释语义（`docs/api-versions.md` §3.1a） |
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

源组件的 `total_samples` 若未写，由装载器按 `run.duration_s × sample_rate_Hz` 补（四舍五入到整数样点，
不足一个样点即错 `duration`）；显式写了以显式值为准，且不得超过全局时长（超过即错 `duration`）。
`run.block_size` 若给，则作为所有带 `block_samples` 参数且框图未写该参数的节点的块长。回放源的采样率要读
清单后才知道，`run.duration_s` 对回放节点暂不生效（整片回放或显式 `max_samples`），B-4 / P1-3 余项补。

**参数值不得是服务器路径**（04 §8.6；决策 D-037）。对实测数据的引用一律用数据索引里的标识
`data_id`（`data/iq/measured/<batch>/index.manifest.json`，如 `dronerfb_0_CH0_S4`），由服务端在任务装载时
解析成文件位置并以**内部参数**（目录里 `internal: true`，如 `manifest_path`）注入组件；框图文件里出现
任何内部参数即校验失败（错误码 `internal_param`，引擎与服务都拒，没有「信任副本」的例外）。解析结果如何交给
引擎见第 9 节。回放节点写法：

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

错误报文 `{code, node_id, port, message}`，画布据此高亮节点与端口。`node_id` 是出错的框图节点 id；观测点
自身的错误填观测点 id；与节点无关时为空。错误码首版（引擎 `DiagramError.code`，D-040）：

| code | 含义 | 定位 |
|---|---|---|
| `json_parse` | 文件打不开或不是合法 JSON | — |
| `schema` | 结构错误：缺必填、未知键、类型或正则不符、id 重复、`run` 取值越界、`products` 非法 | 有节点或观测点时给 id |
| `unknown_type` | `type` 不在组件目录 | 节点 |
| `internal_param` | 框图里出现内部参数（D-037） | 节点或观测点 |
| `param` | 参数未知、类型错位、越界、缺必填、跨参数约束不满足（组件 `configure()` 的报文原样携带） | 节点或观测点 |
| `data_id` | 没有数据解析器、`data_id` 解析不到、或引用数据的组件构造失败（清单打不开等） | 节点 |
| `duration` | `total_samples` 与 `run.duration_s × sample_rate_Hz` 的关系不成立 | 节点 |
| `scene_binding` | 组件不可绑定场景，或带 `scene_binding` 却无 `scenario_ref` | 节点 |
| `node_missing` | 连线或观测点引用的节点不存在 | 被引用的 id 与端口 |
| `port_missing` | 节点没有该输出口 / 输入口 | 节点与端口 |
| `port_incompatible` | 端口类型不允许直连（D-013，`can_connect()`） | 起点节点与输出口，报文含两端 |
| `input_occupied` | 一个输入口连了两条边 | 终点节点与输入口 |
| `input_unconnected` | 输入口悬空 | 节点与输入口 |
| `cycle` | 有环（含自环） | 自环时给节点 |
| `observation_port` | 观测点不在 `IQStream` 输出口上 | 节点与端口 |
| `product_unsupported` | 观测点要求本版本未实现的产品（`iq`） | 观测点 |
| `graph` | 兜底：引擎内部一致性错误，正常路径不可达 | — |

规则只在引擎 `Graph::connect / validate` 一处解释；装载器拿它们的失败分类（`LinkFault` / `GraphFault`）映射成
上表的码，不猜报文。

## 5. 观测点 `observation_points[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 产品目录名 `data/runs/<task_id>/<id>/` |
| `node`、`port` | string | 是 | 必须是 `IQStream` 类型的**输出口** |
| `products` | array | 是 | `spectrum` / `envelope` / `iq` 的子集，至少一项 |
| `label` | string | 否 | 显示名 |
| `params` | object | 否 | 观测点组件 `ObservationTap` 的参数（nfft、窗、桶长），缺省由目录补 |

引擎装载时在该输出口后并联一个 `ObservationTap` 节点（图内名字 `op:<id>`），不改用户的边。产品格式见
`docs/display-products.md`。`products` 映射到 `ObservationTap` 的 `spectrum` / `envelope` 开关；**`iq` 本版本明确
拒绝**（`product_unsupported`），不静默忽略（铁律 15），观测点 IQ 产品实现后放开。`params` 里不得写 `op_id`、
`spectrum`、`envelope`（由观测点字段派生，写了即 `schema`）与 `out_dir`（内部参数，运行器注入，写了即
`internal_param`）。只校验（`cuav_run --validate`）时不注入 `out_dir`，观测点照常构造并校验参数，不落盘。

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

## 9. 数据解析旁挂 `cuav-resolved/1`（D-040）

`data_id` 的解析结果**不写进框图副本**，而是另存一份解析旁挂，引擎装载时经 `IDataResolver` 注入：

```json
{ "schema_version": "cuav-resolved/1",
  "diagram_sha256": "<所配框图文件的 sha256，可选>",
  "data": { "dronerfb_0_CH0_S4": "data/iq/measured/dronerfb/dronerfb_0_CH0_S4.manifest.json" } }
```

机器可读版本 `docs/schemas/resolved.schema.json`。**路径相对引擎的工作目录、`/` 分隔、纯 ASCII**（B-5，决策 D-042）：应用服务以仓库根为
cwd 拉起 `cuav_run`，旁挂里写 `<索引所在目录>/<data_id>.manifest.json` 的仓库相对形式，与 `IndexDataResolver` 的定位规则相同；
引擎的窄字符 `main()` 因此永远见不到可能含中文或空格的绝对根目录。单机手工运行时 cwd 也应是仓库根。

| 消费者 | 动作 |
|---|---|
| 应用服务（B-5） | 提交时按 `index.manifest.json` 解析，写 `data/runs/<task_id>/diagram.resolved.json`；框图副本 `diagram.json` 原样落盘（缩进 2 重排）；随后同步 `cuav_run --validate --resolved` 校验，失败即 400 并删目录 |
| 引擎 `cuav_run --run … --resolved <旁挂>`（B-4） | `MapDataResolver::load_file()` 读入 |
| 引擎单机 / 回归 `cuav_run --run … --data-index <索引>...` | `IndexDataResolver` 直接读索引，按 `<索引目录>/<data_id>.manifest.json` 定位并核对存在 |

这样框图文件永远只含 `data_id`，路径只在服务端、旁挂与引擎进程里出现；引擎对框图里的内部参数无条件拒绝，
D-037 的「引擎装载器同样拒绝」没有例外。

## 10. 待写

- [x] 示例参数名与现有组件目录逐一核对（B-2，2026-09-05：示例逐字作装载器夹具
      `engine/tests/diagrams/slice1_tone_noise_psd.json`，装载运行通过）；目录黄金基准 `tests/golden/component-catalog.json` 仍待 B-4
- [x] `docs/schemas/resolved.schema.json`（`cuav-resolved/1`），2026-09-05 随 B-5 写出
- [ ] 画布序列化的黄金基准 `tests/golden/diagram-slice1.json`（U-2）
- [ ] 子系统封装与模板（04 §8.2，P2）
