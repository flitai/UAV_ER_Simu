# 场景文件格式

**状态**：骨架，字段已冻结（2026-09-04，决策 D-030、D-033）。场景编辑器、`geo/` 运动学库与
引擎组件 `ScenarioSource` 尚未实现，实现时以本文为准；要改字段先改本文并记决策。

**依据**：决策 D-001（场景视图 = 仿真的场景设置与环境背景）、D-013（慢变参数只经"施加"类
组件进入 IQ）、D-033（运动学与链路预算在 `geo/`，参数帧按样点序号推进）；铁律 1（坐标）、
2（高程）、3（时间）、9（种子）、14（合成数据显式标注）；05 §6.2.3（坐标与姿态语义）；
06 备忘录 §9C（G 线）。

**定位**：本格式描述的是**合成场景**：站点、无人机辐射源、航线与业务活动时间线。04 号方案
没有场景编辑条款，本格式是 D-001 兑现的 PROVISIONAL 扩展，须进阶段 0 冻结清单。两个公开
数据集的回放**不得**与任何场景绑定（06 备忘录防线二、防线三）。

---

## 1. 文件位置与消费者

- 位置：`data/scene/<aoi>/scenarios/<scenario_id>.scenario.json`。同一观测区域可有多个场景。
  场景文件是小文件，可入库；不受 `data/` 大文件规则约束。
- 消费者：

| 消费者 | 动作 |
|---|---|
| 场景编辑器（G-4） | 读写；浏览器内只做直线插值预览，不做物理 |
| 应用服务 `GET/PUT /api/v1/scenarios/{id}`（G-4） | 按 `docs/schemas/scenario.schema.json` 校验后落盘 |
| `cuav_run --scenario-track`（G-1） | 只跑运动学，输出航迹，作黄金基准与预览对拍 |
| 引擎组件 `ScenarioSource`（G-2） | 每条链路输出 `SceneParamFrame`，实体状态经观察者回调上报 |
| 框图 `scenario_ref`（`docs/diagram-format.md` §7） | 引用并核对 `sha256` |

## 2. 顶层字段（已冻结）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | string | 是 | 固定 `cuav-scenario/1` |
| `scenario_id` | string | 是 | `[a-z0-9_-]{1,64}`，稳定标识 |
| `name` | string | 是 | 显示名，可含中文 |
| `synthetic` | boolean | 是 | **必须为 `true`**。只作数据层标记，随场景文件与由它派生的产物溯源走（铁律 14）；界面不据此显示任何标记（D-043） |
| `aoi` | object | 是 | `{id, manifest_sha256}`：所属场景数据包及其入口清单哈希；不一致时场景状态 `invalid` |
| `coordinate` | object | 是 | `{crs: "EPSG:4326", alt_ref: "AGL" \| "MSL", terrainHeight_m, coord_version}`。首期 `alt_ref` 固定 `AGL`（离地高），`terrainHeight_m` 是显式平地假设常数（铁律 2） |
| `time` | object | 是 | `{basis: "LogicalSim", duration_s}`。首期只允许 `LogicalSim`（铁律 3） |
| `seed` | integer | 是 | 场景内随机量（若有）的种子；与框图 `run.seed` 独立，两者都进溯源 |
| `sites` | array | 是 | 站点，至少 1 个。首期单站，多站只作结构预留 |
| `emitters` | array | 是 | 辐射源（无人机），至少 1 个 |
| `routes` | array | 是 | 航线；每个辐射源至多一条，没有航线的辐射源静止在 `emitters[].position` |
| `activities` | array | 否 | 业务活动时间线；缺省为空，表示辐射源自 t = 0 起持续发射 |
| `trace` | object | 否 | `{created_by, created_at, notes}` |

未知键一律拒绝。

## 3. 站点 `sites[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | `[a-z0-9_-]{1,64}` |
| `name` | string | 是 | |
| `position` | object | 是 | `{lon, lat, alt_m}`，`alt_m` 按 `coordinate.alt_ref` 解释 |
| `antenna` | object | 是 | `{gain_dBi, pattern: "omni"}`；首期只有全向 |
| `receiver` | object | 是 | `{fs_Hz, center_Hz, bw_Hz, nf_dB}`；对应场景绑定接收机节点的默认参数 |

## 4. 辐射源 `emitters[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | |
| `name` | string | 是 | |
| `platform_type` | enum | 是 | `multirotor` / `fixed_wing` / `racing` / `medium`（沿用 em-demo 分类）；只作显示与默认参数，不进物理 |
| `position` | object | 是 | 初始位置 `{lon, lat, alt_m}`；有航线时以航线第一个航点为准 |
| `emission` | object | 是 | `{center_Hz, bw_Hz, tx_power_dBm, antenna_gain_dBi, waveform}` |
| `emission.waveform` | object | 是 | `{type: "tone" \| "noise" \| "burst", ...}`：`tone` 带 `offset_Hz`；`noise` 无附加字段；`burst` 带 `period_s, duty, offset_Hz`。P3 再扩 `ofdm` / `fhss` |

## 5. 航线 `routes[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `emitter_id` | string | 是 | 指向 `emitters[].id` |
| `waypoints` | array | 是 | `[{position{lon, lat, alt_m}, speed_mps, loiter_s?}]`，至少 1 个 |
| `loop` | boolean | 否 | 缺省 `false`：到末航点后停住；`true` 时回到首航点循环（em-demo 语义） |

运动学语义（与 em-demo `simulation/engine.ts` 的 `moveAlongPlan` 一致，在 `geo/` 用 C++ 重写并注明来源）：

1. 从第一个航点起始；相邻航点之间直线插值，经度、纬度、高度各自线性。
2. 段速度取该段起点航点的 `speed_mps`。
3. 到达航点后若 `loiter_s > 0` 则悬停该时长，位置与航向不变。
4. 越过段末的剩余时间续推到下一段，不丢时间。
5. 航向 = 当前段的真北顺时针方位（铁律 1）；速度单位 m/s；只有 1 个航点即静止。

## 6. 活动时间线 `activities[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `emitter_id` | string | 是 | |
| `t_s` | number | 是 | 相对场景 t = 0 的时刻，单位秒 |
| `event` | enum | 是 | `takeoff` / `cruise` / `hover` / `land` / `tx_on` / `tx_off` / `hop` |
| `args` | object | 否 | `hop`：`{center_Hz}` 或 `{sequence: [Hz...], dwell_s}`；其余事件无参数 |

语义：`tx_on` / `tx_off` 控制该辐射源是否发射；`hop` 改中心频率；`takeoff` / `cruise` /
`hover` / `land` 首期只改状态标签与显示，不改航线运动（航线已含悬停）。事件按 `t_s` 排序，
同一时刻按数组顺序。

## 7. 从场景到参数帧（G-1 / G-2 的契约）

每条（站点, 辐射源）链路产生一个帧序列，结构即 `engine/include/cuav/types.h` 的
`SceneParamFrame{valid_from_s, valid_to_s, update_rate_Hz, path_loss_dB, noise_floor_dBm_per_Hz,
line_of_sight, doppler_Hz, delay_s, state, trace}`。

- 帧边界**按样点序号**：第 k 帧 `valid_from_s = k / update_rate_Hz`，帧内零阶保持；不按墙钟（铁律 9，D-033）。
- `update_rate_Hz` 取值范围 [10, 100]，越界拒绝。
- 首期 `path_loss_dB` = 自由空间路损（`c = 299792458`，D-009）；`line_of_sight` 在平地假设下恒为真；
  D3 落地后换刀口衍射附加损耗，帧结构不变。
- `doppler_Hz = -f · (dr/dt) / c`（远离为负）；`delay_s = d / c`。
- 实体状态 `EntityState{t_s, id, lon, lat, alt_m, heading_deg, speed_mps, tx_on, center_Hz}`
  经引擎观察者回调上报，不做端口类型（端口只承载数据流）。

## 8. 示例（骨架，坐标取观测区域中心附近）

```json
{
  "schema_version": "cuav-scenario/1",
  "scenario_id": "demo-01",
  "name": "亚运村上空单机直飞",
  "synthetic": true,
  "aoi": { "id": "beijing-yayuncun", "manifest_sha256": "<manifest.json 的 sha256>" },
  "coordinate": { "crs": "EPSG:4326", "alt_ref": "AGL", "terrainHeight_m": 0, "coord_version": "wgs84-2026-09" },
  "time": { "basis": "LogicalSim", "duration_s": 120 },
  "seed": 20260904,
  "sites": [
    { "id": "site-1", "name": "侦察站", "position": { "lon": 116.405, "lat": 39.990, "alt_m": 30 },
      "antenna": { "gain_dBi": 3, "pattern": "omni" },
      "receiver": { "fs_Hz": 20e6, "center_Hz": 2.44e9, "bw_Hz": 16e6, "nf_dB": 6 } }
  ],
  "emitters": [
    { "id": "uav-1", "name": "多旋翼-1", "platform_type": "multirotor",
      "position": { "lon": 116.385, "lat": 39.975, "alt_m": 80 },
      "emission": { "center_Hz": 2.44e9, "bw_Hz": 10e6, "tx_power_dBm": 27, "antenna_gain_dBi": 0,
                    "waveform": { "type": "burst", "period_s": 0.01, "duty": 0.5, "offset_Hz": 0 } } }
  ],
  "routes": [
    { "emitter_id": "uav-1", "waypoints": [
        { "position": { "lon": 116.385, "lat": 39.975, "alt_m": 80 }, "speed_mps": 12 },
        { "position": { "lon": 116.405, "lat": 39.990, "alt_m": 80 }, "speed_mps": 12, "loiter_s": 20 },
        { "position": { "lon": 116.425, "lat": 40.005, "alt_m": 100 }, "speed_mps": 15 } ] }
  ],
  "activities": [
    { "emitter_id": "uav-1", "t_s": 0, "event": "takeoff" },
    { "emitter_id": "uav-1", "t_s": 5, "event": "tx_on" },
    { "emitter_id": "uav-1", "t_s": 60, "event": "hop", "args": { "center_Hz": 2.46e9 } }
  ]
}
```

## 9. 待写

- [ ] 示例文件 `data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json` 与 schema 的一致性测试（G-0）
- [ ] 多站、阵列与设备字段（05 P0，只作命名预留）
- [ ] P3 波形类型 `ofdm` / `fhss` 的字段
