# 场景文件格式

**状态**：字段已冻结（2026-09-04，决策 D-030、D-033）；**2026-09-06 全部落地**（切片 ②，D-049）：
`geo/` 运动学与链路预算、引擎组件 `ScenarioSource` / `SceneEmitterSource` / `SceneBoundChannel`、
场景编辑器与 `GET/PUT /api/v1/scenarios/{id}` 都按本文实现。要改字段先改本文并记决策。

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
  场景文件是小文件，**可入库**；不受 `data/` 大文件规则约束（`.gitignore` 有一条对应的放行）。
- **规范序列化形式：`JSON.stringify(doc, null, 2)` 加一个末尾换行。** 框图 `scenario_ref.sha256`
  核对的是文件**原始字节**的哈希，重排缩进就换哈希；把盘上的文件写成编辑器保存时的形态，
  「不改内容直接保存」才是逐字节的空操作。服务端 `PUT` 的响应回传落盘字节的哈希，前端据此更新框图——
  两端各自序列化再各自算哈希必然对不上（08 报告 §9）。
- 消费者：

| 消费者 | 动作 |
|---|---|
| 场景编辑器（G-4） | 读写；浏览器内只做直线插值预览，不做物理 |
| 应用服务 `GET/PUT /api/v1/scenarios/{id}`（G-4） | 按 `docs/schemas/scenario.schema.json` 校验后落盘 |
| `cuav_run --scenario-track <场景> [--track-rate Hz] [--scene-root <目录>]`（G-1） | 只跑运动学，输出 `entity` 事件流；不发 progress、不按墙钟节流，因此 stdout 逐字节可复现，既是黄金基准的生成器，也是服务端 `PUT` 的语义校验器（只看退出码） |
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
| `seed` | integer | 是 | 场景内随机量的种子，与框图 `run.seed` 独立，两者都进溯源。**截至 2026-09-20 它没有任何消费者**：引擎解析并校验它（必填、非负整数），但驱动全部随机量的是框图的 `run.seed`——接收机热噪声、统计阴影、测向误差抽样、站钟抖动的子流都从那一个派生（各组件 `init()` 里 `sub_rng_ = Xoshiro256pp(rng.next_u64())`）。字段保留是因为场景侧将来会有自己的随机量（如按场景重抽的阴影实现），**但在那之前界面上不显示它**，免得让人以为换了它结果就会变（同 `antenna.pattern` 与 `receiver.bw_Hz` 两次先例：声明了、校验了、没人用）|
| `sites` | array | 是 | 站点，至少 1 个。**多站自 D-053（2026-09-09）起启用**（纯软件多站，05 §3.2）：一条任务可以同时跑 K 个站的接收链。约束是同一框图里参与的各站 `receiver.fs_Hz` 与 `center_Hz` 必须一致（与装载器的跨节点同采样率约束同口径，`engine/src/diagram_json.cpp`）。阵列与多通道仍不做 |
| `emitters` | array | 是 | 辐射源（无人机），至少 1 个 |
| `routes` | array | 是 | 航线；每个辐射源至多一条，没有航线的辐射源静止在 `emitters[].position` |
| `activities` | array | 否 | 业务活动时间线；缺省为空，表示辐射源自 t = 0 起持续发射 |
| `zones` | array | 否 | 圆形告警区（2026-09-12，D-061；§6.1）。**只作显示语义，不进物理**：目标进圈即地图图标变红环、卡片加「告警区内」徽标，判定在前端按几何做；引擎收下并原样保存，不解释（与 `equipment_model` 同一先例）。缺席即没有告警区 |
| `trace` | object | 否 | `{created_by, created_at, notes}` |

未知键一律拒绝。

## 3. 站点 `sites[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | `[a-z0-9_-]{1,64}` |
| `name` | string | 是 | |
| `equipment_model` | string | 否 | 设备型号，1–64 字符（2026-09-09，D-054）。**只作参数分组与显示，不进物理**：框图页按它把同型号的站归成一组共用一套接收链参数，用户仍可为单个站单独设置。缺席即「未标型号」，与其它未标型号的站同组。引擎收下并原样保存，不解释 |
| `position` | object | 是 | `{lon, lat, alt_m}`，`alt_m` 按 `coordinate.alt_ref` 解释 |
| `antenna` | object | 是 | `{gain_dBi, pattern: "omni"}`；首期只有全向。`pattern` 自 2026-09-07（D-051）起真正入库，供装载器注入天线组件的缺省方向图，此前解析后即丢弃 |
| `receiver` | object | 是 | `{fs_Hz, center_Hz, bw_Hz, nf_dB}`；对应场景绑定接收机节点的默认参数 |
| `clock` | object | 否 | 站钟与时统（D-053）：`{sync_sigma_ns（必填，≥ 0）, bias_ns, rx_delay_ns, rx_delay_sigma_ns, sync_state ∈ locked \| holdover \| unsynced}`。**在 `time.basis = "LogicalSim"` 下这些是「建模的」同步误差，不是任何真实设备的时统指标**；真实站钟与卫星驯服属 05 P2 的 `DeviceStatus`。`ToaReport` 每一行的 `sync_state` 与 `time_quality` 是它的体现，把 05 §6.2.2「失锁、补零、重对齐不得当作连续数据」落到行级。缺省即缺席：时差定位相关组件遇到没有 `clock` 的站必须报错，**不得默认一个完美时钟**（铁律 15）|

## 4. 辐射源 `emitters[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | |
| `name` | string | 是 | |
| `platform_type` | enum | 是 | `multirotor` / `fixed_wing` / `racing` / `medium`（沿用 em-demo 分类）；只作显示与默认参数，不进物理 |
| `equipment_model` | string | 否 | 设备型号，1–64 字符（2026-09-09，D-054）。与站点同义；**缺席时框图页回退用 `platform_type` 作分组键**，所以既有场景文件不写它也能按机型分组 |
| `position` | object | 是 | 初始位置 `{lon, lat, alt_m}`；有航线时以航线第一个航点为准 |
| `emission` | object | 是 | `{center_Hz, bw_Hz, tx_power_dBm, antenna_gain_dBi, polarization?, waveform}` |
| `emission.polarization` | enum | 否 | `vertical`（缺省）/ `horizontal` / `slant45` / `rhcp` / `lhcp`（2026-09-07，D-051）。极化失配损耗只在接收端算一次：由接收天线组件按自身 `polarization` 与这里注入的发射极化查五档表（10 报告 §3.2）。既有场景文件不写它仍然合法 |
| `emission.waveform` | object | 是 | `{type: "tone" \| "noise" \| "burst", ...}`：`tone` 带 `offset_Hz`；`burst` 带 `period_s, duty, offset_Hz`；`noise` 的 `offset_Hz` 可选（缺省 0）。**`offset_Hz` 自 2026-09-15（C-8，D-069）起对三种波形通用**——此前 noise 既不带限也不搬移频率，写了 `center_Hz` 与 `offset_Hz` 都不起作用；现在 noise 按 `bw_Hz` 做 4 阶巴特沃斯带限（阻带非砖墙，裙边比 `bw_Hz` 宽）并搬移到 `center_Hz + offset_Hz`。P3 再扩 `ofdm` / `fhss`；`template` 带 `template_id`，引用 `docs/emitter-template.md` 的模板（D-045，字段待写，见 §9） |

## 5. 航线 `routes[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `emitter_id` | string | 是 | 指向 `emitters[].id` |
| `waypoints` | array | 是 | `[{position{lon, lat, alt_m}, speed_mps, loiter_s?}]`，至少 1 个 |
| `loop` | boolean | 否 | 缺省 `false`：到末航点后停住；`true` 时回到首航点循环（em-demo 语义） |

运动学语义（与 em-demo `simulation/engine.ts` 的 `moveAlongPlan` 一致，在 `geo/` 用 C++ 重写并注明来源）：

1. 从第一个航点起始；相邻航点之间直线插值，经度、纬度、高度各自线性。
2. 段速度取该段起点航点的 `speed_mps`。
3. 到达航点后若 `loiter_s > 0` 则悬停该时长，位置与航向不变（首航点的 `loiter_s` 只在 `loop` 绕回来时生效）。
4. 越过段末的剩余时间续推到下一段，不丢时间。
5. 航向 = 当前段的真北顺时针方位（铁律 1）；速度单位 m/s；只有 1 个航点即静止。

**两处对 em-demo 的有意偏离**（实现在 `geo/src/kinematics.cpp` 与 `web/src/scene/editor/preview.ts`，
两侧同式，由 `tests/golden/scenario-track-golden-01.json` 对拍，见 08 报告 §9）：

- **段长用 ECEF 弦长**，不用 em-demo 的球面半正矢（R = 6371000）。两者在 2 km 段上差约 0.5%，
  即 10 米，远超航迹对拍 1e-6 度（约 0.1 米）的容差；弦长闭式无迭代，C++ 与浏览器能逐位一致。
- **按绝对时间闭式求值**，不做 em-demo 的增量积分。增量积分与调用步长耦合，
  而引擎里的步长由块长决定——换块长就换结果，「同种子逐字节复现」立刻失守（铁律 9、D-033）。
  另外 `loop` 缺省为假（到末航点停住），em-demo 的 `moveAlongPlan` 是恒循环的。

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

**施加粒度是样点，不是块也不是帧**（2026-09-15，G-6 / D-069）。开关与跳频的边界折到绝对
样点号上（四舍五入，与突发图案同式），波形源与评价器共用 `geo::ActivitySchedule` 这一份
时间表，于是「源怎么发的」与「真值怎么记的」逐位同源。三条闸一律报错、不静默夹（铁律 15）：
停留折出 0 个样点、两个状态相反的开关折到同一样点、两条跳频活动折到同一样点。

**`hop` 的两处口径**：

- `sequence + dwell_s` 自该时刻起**按停留时长循环**，一条活动就够表达整段跳频，
  不必写成几百条离散事件（时间轴上也只落一个字形）。`center_Hz` 与 `sequence` **二选一**，
  同时给即拒；给了 `sequence` 就必须带正的 `dwell_s`。
- 铁律 4 的 `|Δf| + B/2 < Fs/2` 对**每一个跳频点**都要成立，不只是基频 ——
  跳出奈奎斯特不会有任何征兆、只会静默混叠。三处同一口径校验：`Scenario::cross_check`、
  `SceneEmitterSource::configure`、前端频率计划的「目标不跨频带边缘」。
- **参数帧（10–100 Hz）与航迹事件里的 `tx_center_Hz` / `center_Hz` 是这一刻的瞬时频点，
  不是跳频序列**。跳频停留在毫秒量级时帧根本采不到它（`golden-02` 的 2 Hz 航迹基准里
  `uav-2` 的频点恒为序列首项）。要看真实的跳频图案得看瀑布或 `truth.jsonl`。

场景编辑器在活动列表里提供 `+ hop`（新建时带一组以该源中心频率为基准的缺省序列），
选中后可改跳频点（MHz、逗号分隔）与停留时长。

### 6.1 告警区 `zones[]`（2026-09-12，D-061）

不属活动，为不动后文章节编号放在本节末尾。本期只做圆形；多边形、随时间生效 / 失效都不做。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 与站点 / 辐射源同一正则；告警区之间唯一 |
| `name` | string | 是 | 显示名 |
| `kind` | enum | 是 | `alert` / `warning`，两档；只决定显示色 |
| `shape` | enum | 是 | 本期只允许 `circle` |
| `center` | object | 是 | `{lon, lat}`，WGS-84 度（铁律 1）；不带高，圈是地面圈 |
| `radius_m` | number | 是 | 半径，米，> 0 |
| `alt_max_m` | number | 否 | 离地高上限（AGL，铁律 2）；缺席 = 不限高 |

判定（前端，13 报告 §4.3）：实体到圆心的弦长 ≤ `radius_m` 且（无 `alt_max_m` 或 `alt_m ≤ alt_max_m`）即「在区内」。它是 `docs/display-route.md` §3 冻结的「威胁红黄绿」语义第一次有生产者。**不进引擎、不进产品**：将来要进评价（如进入告警区到首次检出的时延）由评价器读场景文件算。
三处必须同一提交：本文、`docs/schemas/scenario.schema.json`、`engine/src/scenario_json.cpp` 的键表——服务端 `PUT` 把语义校验交给 `cuav_run --scenario-track`，少一处即 400。

## 7. 从场景到参数帧（G-1 / G-2 的契约）

每条（站点, 辐射源）链路产生一个帧序列，结构即 `engine/include/cuav/types.h` 的
`SceneParamFrame{valid_from_s, valid_to_s, update_rate_Hz, path_loss_dB, noise_floor_dBm_per_Hz,
line_of_sight, doppler_Hz, delay_s, aod_az_deg, aod_el_deg, aoa_az_deg, aoa_el_deg, tx_heading_deg,
tx_on, tx_center_Hz, state, trace}`。后七项是 2026-09-07（D-051，C-1）新增：

- `aod_*` 是辐射源看站点的方向（发射天线用），`aoa_*` 是站点看辐射源的方向（接收天线用）。
  **两者各算各的**，不由对方取反推出：地球曲率与高差使两端的俯仰角之和不为零，
  短基线上方位近似互为反向也只是近似。角度按铁律 1：方位真北顺时针 [0, 360)、俯仰水平为 0。
- `tx_heading_deg` 是辐射源平台航向，供「指向随航向」的天线用。
- `tx_on` 与 `tx_center_Hz` 是活动时间线的施加结果（G-6），**只供评价器取真值与链路读数，
  不进被测算法**（04 §5.2「可供评价使用但不向被测算法泄漏的真值索引」）。

- 帧边界**按样点序号**：第 k 帧覆盖样点 `[floor(k·fs/rate), floor((k+1)·fs/rate))`，帧内零阶保持；
  不按墙钟（铁律 9，D-033）。映射用纯整数：`fs` 不被 `rate` 整除时也确定，且 C++ 与浏览器能逐位一致，
  用秒做中间量就会在边界上差一个样点。`valid_from_s = k / update_rate_Hz` 是给人看与回放用的派生量，
  施加时一律用样点区间。生产端**每一轮都必须产出至少一帧**（哪怕重发上一帧），
  否则下游信道会因输入不齐而跳过一轮，调度器随即把没被消费的 IQ 块静默覆盖掉（08 报告 §9.3）。
- `update_rate_Hz` 取值范围 [10, 100]，越界拒绝。
- `path_loss_dB` **只装纯传播损耗**，不含发射功率与收发天线增益——那三项在首期是全程常量，
  由施加类信道按场景绑定读取，不进 10–100 Hz 的慢变帧，否则 `link` 事件与场景视图里的「路损」
  读数就名不副实了。
- **传播效应按档位组合**（D-058，自 2026-09-10）。`path_loss_dB = free_space_dB + extra_loss_dB`
  这个恒等式在任何档位下都成立；**缺省档 E1 与此前逐数值相同**（自由空间路损，`c = 299792458`，D-009，
  `extra_loss_dB` 恒 0）。E2 档加地面双径 **或** 城市经验（二选一，至多一个「替代型主模型」）、
  统计阴影、大气与降雨，替代型主模型也走 `extra_loss_dB`（`extra = L_primary − L_fs`）。
  档位与逐项开关是 `ScenarioSource` 的参数（`docs/component-catalog.md` §8），
  公式与参数来源见模型卡 `models/channel/README.md`。
  **帧结构一个字段不加**：`included_loss_terms` 只进链路报告（`link` 事件与 `links.jsonl`），
  不进 `SceneParamFrame`——帧是 IQ 施加路径，加字段没有消费者。
- `line_of_sight` **在 E1 / E2 档下恒为真**（显式平地假设，铁律 2），由此两处在这两档取不到：
  阴影 σ 表的 NLOS 一列、测向误差预算的 `sigma_mp_nlos_deg`。**选了「城市」环境不等于做了遮挡判定。**
  **E3 档自 D3-5（2026-09-18）起由建筑几何给出**：`line_of_sight = !blocked`（与损耗大小无关，
  掠射只损几分贝也算非视距），单刀口绕射损耗单程 ×1 进 `extra_loss_dB`，`included_loss_terms`
  多一项 `diffraction`，`link` 事件与 `links.jsonl` 多一个可选键 `diffraction_dB`（只在非零时写）。
  E3 要观测区域的建筑几何（`--scene-root`，缺省 `data/scene`），且与统计阴影、城市经验互斥。
- `doppler_Hz = -f · (dr/dt) / c`（远离为负）；`delay_s = d / c`。
- 实体状态 `EntityState{t_s, id, lon, lat, alt_m, heading_deg, speed_mps, tx_on, center_Hz}`
  经引擎观察者回调上报，不做端口类型（端口只承载数据流）。

## 8. 示例（骨架，坐标取观测区域中心附近）

```json
{
  "schema_version": "cuav-scenario/1",
  "scenario_id": "golden-01",
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
  ],
  "zones": [
    { "id": "z-1", "name": "核心区", "kind": "alert", "shape": "circle",
      "center": { "lon": 116.405, "lat": 39.990 }, "radius_m": 500, "alt_max_m": 300 }
  ]
}
```

## 9. 待写

- [x] 示例文件 `data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json` 与 schema 的一致性测试
      （2026-09-06，`tests/unit/test_scenario_example.py` 八项：schema、清单哈希、跨引用、航线时长覆盖仿真时长、
      全部位置落在观测区域内）
- [ ] 多站、阵列与设备字段（05 P0，只作命名预留）
- [ ] P3 波形类型 `ofdm` / `fhss` 的字段
- [ ] 波形类型 `template`（`template_id`；模板文件路径是内部参数，画布只见标识，与 D-037 同法；`docs/emitter-template.md` §7；D-045）
- [ ] `emission.tx_power_dBm` 的来源字段 `tx_power_source ∈ {measured, paper, assumed}`：数据层记账随产物走，界面不显示（铁律 8、14；D-042；D-045）
- [x] 圆形告警区 `zones[]`（2026-09-12 已落地：`{id, name, kind ∈ alert | warning, shape: circle, center{lon, lat}, radius_m, alt_max_m?}`，可选、可空；引擎收下不解释，与 `equipment_model` 同一先例；schema、本文 §2 表与新节、`engine/src/scenario_json.cpp` 键表三处必须同一提交，否则 `PUT` 一律 400。13 报告 §4.6，D-061；随 V-2 落地）
