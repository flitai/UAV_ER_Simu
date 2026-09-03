# 无人机电子信号侦察仿真系统（804 C-UAV）

面向反无人机电子信号侦察接收机研发的、以 **DDC 后、信道化前宽带复基带 IQ** 为主产品的、实测数据驱动的 B/S 自主框图仿真与算法试验平台。**设计真理源 = `04.无人机电子信号侦察仿真系统实施方案_v2.0.md`**（下称 04）；05 为后置能力方案（本期只预留接口，不实施）；01–03 为依据。本文件只记约定、状态和决策，不复述设计内容。

## 文档体系

| 文档 | 作用 | 只读 |
|---|---|---|
| `01.反无人机系统电子信号侦察三级模型体系建设方案 v1.md` | M1 功能级 / M2 信号级 / M3 IQ 级 × E1–E4 × V1–V5 三维正交的顶层框架 | 是 |
| `02.面向反无人机应用的电子侦察IQ级信号模拟仿真概念模型需求分析.md` | M3 层 10 类新增概念模型、IQ-CM-001~012 需求 | 是 |
| `03.基于MATLAB_Simulink的无人机信号侦察仿真系统可行性与技术路线_v3.0.md` | MATLAB 定位为内部工具、11 种标准数据端口、组件生命周期、实测数据资产体系、18 条建设误区 | 是 |
| `04.无人机电子信号侦察仿真系统实施方案_v2.0.md` | **真理源**：B/S 架构、控制面/数据面边界、模型简化策略、IQ 规范、阶段 0–4、验收 | 是 |
| `05.无人机电子信号侦察仿真系统后置功能高阶建设方案_v1.0.md` | P0–P9 后置能力包；P0 的端口/时间/坐标/设备抽象与四态降级语义是本期须预留的接口 | 是 |
| `06.首期实施备忘录_v1.0.md` | 执行层路线图与分步清单（S / D0–D4 / P1 步骤表、当前位置、待用户输入）；每次对话开工前对照 §0.3 | 否 |
| `C-UAV Model Demo/概念模型/*.md` | 60 份 EM-x 概念模型（公式、接口、参数），M1/M2 层已有模型的实体 | 是 |
| `/Users/zhiyu/CC/EM-C-UAV/{CLAUDE.md, 07.实现2.5D地图总体方案.md, 08.覆盖区域遮挡计算关键技术与创新性.md, 演示软件软件架构.md, 09.模型库C++工程化迁移方案.md, 10.模型库M2服务化深化方案.md}` | 场景数据包 EMScene、IMapQuery、遮挡算法、六边形架构、emcore 迁移史 | 是 |
| `WORKLOG.md`（待建） | 工作过程日志，每任务节点立即追加，状态快照置顶 | 否 |
| `docs/`（待建） | 代码引用的规范：iq-format / api-versions / scene-package / display-route / decisions | 否 |

**分级符号口径**。三个正交维度来自 01，每个结果同时声明；IQ 模型另加 04 的等效档：

| 维度 | 取值 | 出处 |
|---|---|---|
| M 层（模型层次） | M1 功能级 / M2 信号级 / M3 IQ 级 | 01 |
| E 精度（同层内数学细致度） | E1 快速抽象 / E2 工程 / E3 精细机理 / E4 实测融合 | 01、概念模型库 |
| V 可信度（验证程度） | V1 – V5 | 01 |
| L 等效档（仅 IQ 模型） | L1 基础 / L2 工程（默认）/ L3 数据校准；对应 L1 ≈ E1–E2、L2 = E2、L3 = E4 | 04 |

代码、元数据与产物只允许这四种字段。其余符号只在引用原文时使用，且必须带文档前缀（如"03-L2"）：03 的 L0–L2 保真度层级、05 的 F1–F3 运行档位与 U1–U4 城市传播等级、02 对 E 的 IQ 专用释义。

## 铁律

1. **坐标**：交换与文件用 WGS-84 经纬度（度，EPSG:4326）；内部计算 ECEF + 站心 ENU（米）；方位真北顺时针、俯仰水平为 0；禁止 GCJ-02 混入；每个坐标产物记录坐标版本与转换参数（05 §6.2.3）。
2. **高程**：建筑 `base_m / height_m` 为离地高差，DEM 为海拔，禁止隐式相加；首期 LOS 采用显式平地假设（`terrainHeight_m` 常数），DEM 只作 hillshade 视觉；DEM 垂直基准 OPEN。
3. **时间**：逻辑仿真 / 文件采集 / 设备硬件 / 外部统一四重时间不得混用；元数据必填时间基准与连续性标志；失锁、补零、重对齐不得当作连续数据（04 §9.2；05 §6.2.2）。
4. **IQ 语义**：主产品 = S4 观测点（DDC 后、信道化前）；交换/保存复 int16 交织，内部 float32；`|Δf| + B/2 + 保护带 < Fs/2`，抽取前必抗混叠；专业模型组不得自行改变 IQ 语义（04 §5.2、§9、§14）。
5. **单位与 dB**：SI（m / Hz / dBm / deg / s）；dB 域与线性域不混算，功率聚合在线性域；损耗 dB 正值 = 变差（emcore README）。
6. **离线**：建库可联网、运行不联网。Overpass、planet extract 等联网动作只允许出现在 `scene/` 建库脚本；底图、字形、sprite、字体随包；交付环境不依赖 CDN / 在线字体 / 在线地图 / 外部身份（04 §6.5；EM-C-UAV 07）。
7. **原始 IQ 不进浏览器**：浏览器只收控制、状态与按视窗（时间窗 + 频段 + 像素宽 + 统计量）抽取的展示数据；大文件分片续传，禁 JSON/Base64 封装；浏览器不缓存原始 IQ（04 §6.4、§8.6）。
8. **溯源**：每个模型输出携带 `model_id / model_version / model_level(E) / model_layer(M) / credibility(V) / parameter_version / confidence / trace_id`，即同时声明 M/E/V 与 L 等级；每个数据产物挂同构元数据（来源、参数、输入哈希）（emcore README 六件套 + 01 §3.1 扩展；04 §9.2）。
9. **种子**：随机性显式注入（`IRandom&` / 请求 `seed`），库内无全局随机源；固定种子逐位复现；随机量用蒙特卡洛矩校验（04 §8.3、§15.2）。
10. **基准不得静默变**：任何模型/参数/数据集变化不得静默改变既有基准结果；超差 = 发现，查根因，禁止调参使其通过；黄金向量相对误差 ≤ 1e-9（04 §15.3；emcore golden）。
11. **渲染—物理同源**：建筑几何单一来源 `buildings.geojson`（`{id, base_m, height_m, src, footprint}`）同时驱动 `fill-extrusion` 渲染与遮挡桶网格；瓦片 `buildings` 层只作 AOI 之外的渲染回退，永不进遮挡计算（EM-C-UAV 08 §2.3；D-002 / D-010）。
12. **几何 / 材质 / 无线参数分管**：三维好看 ≠ 传播可信；建筑几何、电磁材质、无线参数分开管理、各自版本化；首期建筑只用于 LOS/NLOS、附加损耗与场景分类（03 §7.3；04 §7.3；05 §25）。
13. **第三方代码边界**：`foundation`（AFSIM 抽取，已获授权）可 vendored，放 `third_party/foundation/`，保留原文件头；emcore / em-demo 自研代码可拷，文件头注明来源与 golden 对应关系；Airports 为本方自有代码可复用，其 `vendor/` 第三方件与 OSM 瓦片的 ODbL 署名必须保留；MATLAB 仅内部模型生产工具，不作运行时依赖，界面与交付包不出现（03 §11；04 §6.2、§8.5）。
14. **合成数据不用于展示**：演示与交付图一律真实数据或显式标注；`src=est:*`（估算建筑高度）、合成底噪等标记随字段传到每个下游产物（04 §9.2）。
15. **不静默降级 + ASCII 文件名**：结果状态四态 `valid / degraded / invalid / not_applicable`，禁止默认值顶替（如 `height ?? 8`）；Web 资源与数据包文件名纯 ASCII，出包执行 `find dist -type f | LC_ALL=C grep -nP '[^\x00-\x7f]'`（05 §16.3；em-demo 打包说明）。
16. **目标平台**：客户端与单机一体化包 **Windows x64 优先**；内网集中模式的服务端（应用服务 + C++ 引擎 + 数据库）**Windows 或 Linux x64 视情选择**，二者从第一天起都进 CI 构建。开发机是 macOS，其结果不作验收依据；打包与性能数字只认目标平台原生验证。引擎与服务不得直接调用平台私有 API，共享内存、内存映射、路径与编码一律经抽象层（D-015 / D-016；04 附录 B；方法论阶段 7）。

## 资源清单 · 只读边界 · 复用边界

| 路径 | 角色 | 复用方式 | 备注 |
|---|---|---|---|
| `C-UAV Model Demo/` | 只读参考快照，与 `/Users/zhiyu/CC/EM-C-UAV/` 逐字节相同 | 不在其中开发；拷入对应目录并注明来源 | 保留快照还是直接引用 EM-C-UAV：OPEN |
| `C-UAV Model Demo/em-demo/` | 态势展示参考（React 19.2 / TS 6.0 / Vite 8 / MapLibre GL 5.24 / pmtiles 4.4 / protomaps-themes-base 4.5 / Tauri 2.11） | 可拷：`src/map/basemapStyle.ts`、`src/components/{MapView,SignalPanel,CoverageControl}.tsx`、`src/models/{occlusion,coverage,geo-fix}.ts`、`src/simulation/engine.ts`、`scripts/fetch-buildings.mjs`、`桌面应用打包说明.md` | 前端 TS 自算物理，与 emcore 运行时零耦合；Tauri 无 sidecar；本项目不用 Tauri |
| `C-UAV Model Demo/emcore/` | C++14 模型核心（CMake ≥ 3.16，vendored doctest / nlohmann / cpp-httplib，零网络构建） | 可拷：`include/emcore/map/{imap_query,local_scene_adapter}.h`、`models/{occlusion,propagation}`、`core/{types,units,result,random,geo}.h`、`tests/golden/*.json`、`tests/golden_util.h` | 遮挡 148 例 golden；`emsvc` 5 端点 `/api/v1/{health, models/catalog, radar/detect, signal/detect, los/check}` |
| `C-UAV Model Demo/foundation/` | AFSIM 2.9 抽取：math 347 / io 151 / serialization 22 文件 | 可 vendored（D-004）：`UtEllipsoidalEarth`（WGS-84 LLA↔ECEF↔ENU/NED、UTM、Vincenty）、`UtSphericalEarth::MaskedByHorizon`、`UtCoords`、`UtCovariance*`、`UtAzElTable*`、`UtIntersectMesh`、`UtSpatialTree` | **无建筑遮挡库**；不能独立构建：无顶层 CMakeLists，134 个头引用缺失的 `ModelApi.hpp` / `MODEL_API`；target 实名 `model_math / model_io / model_serialization`；零单测 |
| `/Users/zhiyu/CC/Airports/` | 本方自有 2.5D 离线地图工程（MapLibre 5.6.1 + PMTiles + Python 标准库 Range 服务器） | 可拷：`serve.py`（Range）、`fetch_tiles.py`、`fetch_levels.py`、`download_offline_maps.py`、`index.html` 中的 `protomapsStyle()`（60 层含机场要素）/ `localglyphs://` / `probePmBldg()` / `window.__probe`；文档 `TILES.md`、`OFFLINE.md` | 无遮挡计算；未开 `setTerrain`；原生 JS 需手工切成 TS 模块 |
| `/Users/zhiyu/CC/Airports/tiles/planet.pmtiles` | 全球 Protomaps 底图 z0–15，128 GB，planetiler 0.10.2，OSM 2026-08-17；`buildings` 层 z11–15 含 `height / min_height / kind` | 只读；AOI 底图与建筑 GeoJSON 的共同源（D-010） | 缺瓦片渲染为空白不降级，AOI 档案 zoom 必须"满" |
| `/Users/zhiyu/CC/Airports/tiles/dem/{z}/{x}/{y}.png` | AWS terrarium DEM z0–8，7.1 GB | 只读；hillshade 用 | 百米级/像素，对街区 LOS 无用；高分辨率 DEM OPEN |
| `/Users/zhiyu/CC/C-UAV/天津机场_地表材质与建筑数据工作流.md` | 地表材质面层 + 建筑 GeoJSON 的 QGIS 工作流 | 只参考（材质分类与 εr/σ/roughness 默认表） | 双径地面参数将来用 |
| `data/` | IQ、共享底图与 DEM（`basemap/`）、场景数据包、黄金基准 | 大文件不入 git，只入索引与元数据；开发机上 `data/basemap/{planet.pmtiles, dem}` 是指向 Airports 的软链 | 每个产物挂同构元数据；`data/basemap/*.manifest.json` 已生成（D-022） |

## 首期边界与架构决策

首期基线见 04 §21；不做事项见 04 §3.4；后置能力见 05（P0 端口 `ArrayIQStream / MultiSiteIQSet / ChannelPathSet / CalibrationSet / BearingReport / PositionReport / TrackReport / DeviceStatus` 本期**只做命名预留**，不实现）。首期单站、单通道、离线/准实时，常用 5–50 MS/s，100 MS/s 仅文件兼容与短窗（04 §12.1）。

**已定**

| 项 | 决定 | 出处 |
|---|---|---|
| 运行形态 | B/S；单机模式由本地启动器拉起应用服务并打开系统浏览器；**不用 Tauri** | 04 §2.5 / §6.5；D-003 |
| 前端 | TypeScript + React 19 + Vite；MapLibre GL **pin 5.24** + pmtiles 4.4，全部 vendored 离线；地图图层与显示风格照搬 Airports 手写样式，不引入 `protomaps-themes-base` | 04 §6.3；D-003 / D-008 / D-017 |
| 应用服务 | Node/TypeScript，REST + WebSocket（事件带序号可补取）；**必须支持 HTTP Range**（PMTiles 需要；em-demo 整文件 fetch 只是 Tauri 权宜） | 04 §6.3 / §8.6；D-003 |
| 运行引擎 | C++ 分块流 + DAG 调度，同进程 / 共享内存；C++14 起（与 emcore 兼容，提升标准 OPEN） | 04 §6.3 / §8.3 |
| 数据 | SQLite 单机 / PostgreSQL 内网；IQ 项目二进制 + SigMF 兼容元数据 | 04 §6.3 / §9 |
| 场景—框图集成 | 三视图 **场景 / 框图 / 结果** + 顶部试验上下文；场景中的站点、无人机航迹、建筑在框图中以"场景绑定"信道/天线组件出现；地理传播几何（LOS/NLOS、附加损耗、多径路径）由服务端 `geo/` C++ 库按 10–100 Hz 计算，经 `SceneParamFrame` / `ChannelPathSet` 端口交 IQ 引擎施加，浏览器只展示 | D-001 / D-013；05 §5.2 |
| 显示子线优先级 | 显示子线 D0–D4 不进入阶段 1 退出条件，不得挤占 IQ 主链 | D-001 |
| 常数策略 | 从 emcore 移植的模块保留原常数守 golden（光速 `3e8`；遮挡投影 `110540 / 111320·cosφ`；定位投影 `111320` 双向；TDOA `299792458`）；新写代码统一 `c = 299792458` 与严格 ENU；禁止"顺手统一" | emcore README；D-009 |
| 交付平台 | 客户端与单机一体化包 **Windows x64 优先**；内网集中服务端 **Windows 或 Linux x64 视情**（`server/`、`engine/`、`geo/` 双平台构建）；浏览器基线须支持 WebGL2（MapLibre GL 5 不支持 WebGL1）；macOS 仅开发 | D-015 / D-016 |

**OPEN**

| 项 | 候选 | 决策时点 |
|---|---|---|
| 框图画布 | React Flow / AntV X6 | 阶段 2 设计报告 |
| 遮挡计算落点 | server 预计算场 + WS 推送 / 浏览器 TS 复算并与 C++ golden 对拍 | D3 设计报告 |
| 坐标基座实现 | foundation `UtEllipsoidalEarth` vendored / GeographicLib | D3 设计报告 |
| 高分辨率 DEM 与垂直基准 | Copernicus 30 m / 本地 DSM | D0 |
| AOI 范围大小（中心已由用户定为北京亚运村，D-021）、首批频段/带宽/机型 | 04 附录 B 清单；当前范围 10 × 10 km 为 PROVISIONAL | 阶段 0 |
| 缺失引用文件 | 主界面交互原型 html、两阶段建设方案、signal signature database、实施方案 v1.0、01/02 三张架构图 | 阶段 0（阻塞退出） |
| 参考快照去留 | 保留 `C-UAV Model Demo/` / 直接引用 EM-C-UAV | 目录建立时 |
| 跨层一致性容差 δ | 按指标分别冻结，参考 04 §16.3（检出率差 5–10 个百分点、功率统计 10–20%） | 阶段 1 设计报告 |
| M3 新增概念模型编号前缀 | `EM-Q-xx` 候选 | 阶段 0 |
| 交付平台基线 | Windows 版本、浏览器（Edge / Chromium 内核国产浏览器）、MSVC 版本、Node LTS 版本、Windows 构建验证机或 CI；服务端若选 Linux：发行版（Ubuntu LTS / openEuler / 麒麟服务器版等）与 glibc、GCC 基线 | 阶段 0（04 附录 B） |
| 单机启动器形态 | `.bat` + 便携 Node / 单文件 exe / Windows 服务 | 阶段 2 设计报告 |

## 地理场景 / 态势显示子线

三条路线的决策如下，细节进 `docs/display-route.md`（待写）。

- **2.5D 地理环境（照搬 Airports）**：底图直接用整份全球 `planet.pmtiles`（137 GB，登记为共享资产 `data/basemap/`，D-022），不按 AOI 裁切；`scene/fetch_tiles.py` 裁出的 `data/scene/<aoi>/basemap-slice.pmtiles` 只作测试夹具（z0–15；建筑几何 z ≥ 11；档案必须"满"，AOI 外空白）。**图层顺序与显示风格逐项照搬 Airports `index.html`**：`protomapsStyle()`（810–1092 行，60 层浅色样式与 `PM` 配色表，含机场要素）、hillshade 参数（1218 行）、建筑拉伸外观（`addBldg3d()` 1296 行：`#e6e1da`、minzoom 14、14→14.7 渐显）、相机与控件（`newMap()` 1375 行、pitch 55、`NavigationControl({visualizePitch:true})`）、标签与字形（`localglyphs://` 拉丁 SDF + CJK 交给系统字体）、`probePmBldg()` 探测与 `window.__probe` 探针。只把原生 JS 切成 TS 模块，不改视觉参数；**不采用** em-demo 的 protomaps `black` 深色主题与 `protomaps-themes-base`。AOI 内建筑改用同源 GeoJSON 拉伸，但外观参数与 Airports 瓦片建筑层一致；AOI 外保留 Airports 瓦片建筑层（铁律 11）。任何视觉偏离 Airports 须记决策。
- **建筑数据（D-010）**：从**同一份** planet.pmtiles 的 z15 瓦片解码 `buildings` 层、跨瓦片合并去重 → `data/scene/<aoi>/buildings.geojson`，字段 `{id, base_m, height_m, src, footprint}`；`height` 缺失时按 em-demo `fetch-buildings.mjs` 的用途/面积分档确定性估高并记 `src=est:*`；缺高度地区后续逐步用 Overpass 全标签或人工数据补齐（只升级 `src` 与高度，不改几何 id）。国内城市 OSM 高度覆盖极低（西安 12×12 km 样本 13,593 栋：height 1.0%、levels 1.3%、`building=yes` 96.1%），这是首个已知数据欠项；北京亚运村范围的覆盖率待 D0-3 实测。
- **无人机 / 电磁态势（参考 em-demo）**：图形语义沿用——威胁红/黄/绿、效应染色优先于威胁等级、AOA 与 TDOA 双色区分、覆盖 viridis 5 档 + 值域不透明度、iso-Pd 包络（marching squares，画在楼之上）；PPI 扫描 / 测向线 / 2σ 误差椭圆走 Canvas 叠加层并用 `map.project` 投影；定频 tick（20 Hz）+ 每帧一次状态提交；无人机图标 SVG 光栅化 `source-in` 染色、`icon-rotate` 航向；航迹抽稀。**具体色值须在 Airports 浅色底图上重新标定**（em-demo 的 AOA 橙 `#f97316`、TDOA 青 `#22d3ee` 等是为深色底图调的），标定结果进 `docs/display-route.md`。参考 `em-demo/src/components/{MapView,CoverageControl,SignalPanel}.tsx`、`src/models/coverage.ts`、`src/simulation/engine.ts`。
- **地理计算与遮挡（D-005）**：`IMapQuery`（`getTerrainHeight / queryBuildings / raycast / getMaterial`）+ `LocalSceneAdapter`（100 m 桶网格 + DDA，命中语义"侵入最深的等效单刀口"）+ `models/occlusion`（ITU-R P.526 刀口衍射）自 emcore 移植到 `geo/`；遮挡是软的：雷达 `SINR − 2·L_diff`、单程 `P_rx − L_diff`，实时与覆盖场同一注入点；移植后必须通过 148 例 golden 对拍（rel ≤ 1e-9）+ 独立解析锚点（如 FSPL@2.4 GHz/1 km ≈ 100.1 dB）才算可信。

## 功能级—信号级衔接（M1/M2 ↔ M3）

本系统按 01 口径 = **M2 信号级 + M3 IQ 级**（口语"信号级"包含二者）。`概念模型/` 60 份是 M1/M2 层专业模型单元（01 §9.2），在本系统中只有两种角色：**向下的参数供给层**与**向上的归约目标层**；IQ 级不是另一套模型，而是同一条电侦模型链的高粒度展开（02 §6.1）。概念模型库表头没有 M 层字段，按 01 §3.5 判据的归属如下（逐份确认后写入 `docs/concept-model-layers.md`）：

| 族 | M 层 | 在本系统中的角色 |
|---|---|---|
| EM-B-07 天线 / B-11 接收机基础 / B-12 噪声 | M1 参数供给 | 复增益与极化损耗 / 接收采样链能力边界（NF、带宽、增益、AGC、阻塞）/ 样本级噪声的目标 PSD |
| EM-B-09 信号抽象 / EM-T-03 辐射源特性 | M1（E1/E2），E3 时频包络进 M2 | 波形模板与业务活动的输入（频率计划、带宽、功率、谱形、突发/跳频摘要、调制家族）；保持"不生成 IQ" |
| EM-B-10 频谱栅格 | M2 | M3 归约后时频观测产品的容器；也为 IQ 任务选频段、窗口与背景源 |
| EM-P-01/02/04/08/13（P-03/05/07 备用） | M1/M2 | 路损、双径、建筑遮挡、阴影、模型选择与降级 → 慢变信道参数；P-11 射线追踪与 P-12 缓存 → 后置 P3 的 `ChannelPathSet` |
| EM-S-01 扫描策略 | M2 调度 | IQ 捕获窗口：时间窗、中心频率、驻留、采样上下文 |
| EM-S-02/03/04 检测、特征、识别 | M2 裁决 | 只消费 M3 归约出的观测量，不碰原始 IQ（02 §8.5）；其 Pd 曲线与特征模板是 M3 蒙特卡洛的校准对象 |
| EM-S-05/06/07/08 测向定位 | M2 | 首期只作 M3 观测量（TOA、方位）的接口与误差语义参考；实现后置 P1/P2 |
| EM-S-10/11/12 运动估计、关联、退化 | M1/M2 | 退化模型提供 IQ 质量标记的映射（削顶、镜像、缺样 → 检测/识别质量修正） |
| EM-T-04 建筑材质 | M2 参数 | 首期不用（铁律 12），P3 启用 |
| EM-R / J / H / N / C / F 六族 + EM-T-01/02（雷达目标 RCS、微多普勒） | M1 效应裁决 / 雷达目标特性 | **04 电侦范围外，不使用**；保留引用，如需纳入须修订 04 |

**三条衔接机制**

- **向下参数注入（M1/M2 → M3）**：功能级模型按 10–100 Hz 输出慢变参数（链路几何、LOS/NLOS、各损耗分量、噪声底、天线复增益、扫描窗口、多径路径），M3 组件（波形生成、时变复信道、噪声注入、接收采样链、信道化）在采样率上施加（03 §11.7；04 §12.2；05 §5.2）。参数只在 M3 组件的"施加"环节进入 IQ，M3 不得绕过 M1/M2 自行硬编码传播或噪声参数。
- **向上归约（M3 → M2 → M1）**：IQ → 内置"IQ 观测量提取"（FFT/PSD/瀑布、能量检测、突发统计、参数估计、特征、TOA/方位）→ `SpectrumFrame / DetectionList / FeatureVector / BearingReport` → 批量蒙特卡洛 → Pd/Pfa 曲线、混淆矩阵、σ_θ、CEP 分布 → 回写为 M1/M2 模型的校准参数（01 §8.2、§12.4；02 §9.2）。归约必须在统一场景、参数版本、随机上下文与统计口径下进行。
- **跨层一致性约束（01 §8.3）**：同场景、同种子、同参数版本下，M3 归约到 M2/M1 的统计量与 M1/M2 直接计算值的相对偏差 δ 超容差 = 发现，追查抽象误差 / 参数不一致 / 样本不足 / 适用范围，禁止选有利结果。首批跨层一致性算例（进 `tests/regression`，与 04 §15.2 十二项并列）：① 自由空间 + AWGN 单音与突发：EM-S-02 Pd 公式 vs M3 蒙特卡洛 Pd；② 建筑遮挡：EM-P-04 附加损耗 vs M3 接收功率统计；③ 双径：EM-P-02 vs M3 复信道功率起伏；④ 混合增强：实测背景 + 合成目标的 SNR 归约 vs M2 预测。容差 OPEN，参考 04 §16.3。

**工程约定**

- **溯源字段**：六件套之外新增 `model_layer ∈ {M1, M2, M3}` 与 `credibility ∈ {V1..V5}`（01 §3.1）。同一概念模型编号可同时有 M1/M2 函数式实现（自 emcore `compute*` 移植）与 M3 分块流组件，共用 `parameter_set_id`，不共用代码路径。
- **框图端口**：在 03 §11.6 端口之外新增慢变参数端口 `SceneParamFrame`（链路几何、LOS/NLOS、损耗分量、噪声底、天线复增益、扫描窗口；携带 `valid_from / valid_to / update_rate_Hz` 与溯源）；多径路径用 05 P0 的 `ChannelPathSet`，**首期即启用**，单径/双径也走它，避免 P3 时改接口。连线校验：`IQStream` 与 `SceneParamFrame / ChannelPathSet` 不得直接相连，必须经"施加"类 M3 组件；M2 裁决组件只接受观测量端口，不接受 `IQStream`。
- **职责边界**：原始 IQ 处理只由"IQ 观测量提取"组件承担；概念模型库保持"不生成 IQ"的边界（EM-B-09 假设 A-001）；对既有概念模型的 IQ 相关字段扩展按 02 §8 七条写入 `docs/concept-model-extensions.md`（待建），不修改只读快照。
- **新增 M3 概念模型**：02 §6.2 十类，编号前缀 OPEN（候选 `EM-Q-xx`）。首期只写与阶段 1 闭环相关的：波形模板与业务活动、复基带波形生成、时变复信道、样本级噪声与干扰、接收机采样链、IQ 观测量提取、IQ 数据产品与回放、IQ 验证与校准；多站同步与阵列采样后置。
- **运行模式**：默认"算法验证模式 M2+M3"；"工程分析模式 M1+M2，争议窗口调 M3"为第二模式（01 §10.2）；M3 触发单元 = 站点集合 + 空间区域 + 时间窗口 + 频率窗口 + 信号集合 + 验证指标（01 §10.3），显式声明并进入试验记录。

## 目录结构（2026-09-03 已按此建立，见 WORKLOG 同日「工程骨架」条目）

```
804 C-UAV/
├── CLAUDE.md  WORKLOG.md  01–05.*.md      方案文档留根目录（只读）；新设计报告按 06+ 编号同放根目录
├── docs/            代码引用的规范：iq-format / api-versions / scene-package / display-route / decisions/
├── web/             WP2 前端 TS+React：src/{diagram,signal,scene,api}
├── server/          WP2 应用服务 Node/TS：REST+WS、权限/项目/任务/审计、文件 Range 服务
├── engine/          WP3 C++ 分块流 IQ 引擎 + 组件 SDK
├── models/          WP4 模型组件：radiator/channel/antenna/receiver/adc-ddc/channelizer（含 Coder 产物）
├── geo/             显示子线物理侧：IMapQuery + LocalSceneAdapter + 刀口衍射（自 emcore 移植，带 golden）
├── third_party/foundation/   AFSIM 抽取库 vendored（补 ModelApi.hpp + 顶层 CMakeLists，保留文件头）
├── algos/           WP6 算法与评价基线、用户插件接口
├── tools/           内部数据工具：iq_convert（DS-2/DA-2）、iq_survey（DS-5/DA-5，04 §10.6 八项质检）、iq_format 共享库；不进交付包
├── matlab/          内部工具链（参考模型、Coder 工程），不进交付包
├── scene/           场景数据包生产脚本：pmtiles extract / buildings 解码合并 / dem；AOI 定义
├── data/{iq/{measured,synthetic,mixed}, basemap/, scene/<aoi>/, golden/}   大文件不入 git，只入索引与元数据；basemap/ 为共享底图与 DEM（D-022）
├── tests/{unit,integration,e2e,golden,regression}/               04 §15.1 五级验证
├── deploy/          WP8 单机/内网部署包、离线静态资源、启动器
└── C-UAV Model Demo/   只读参考快照，不在其中开发
```

新建目录与文件名一律 ASCII 无空格。根目录与快照目录名含空格，脚本中路径必须加引号。

## 环境与命令

- 开发机（2026-09-02 核实）：macOS 26.5 arm64；node 25.8 / npm 11.12；cmake 4.2 / Apple clang 21；GDAL 3.12；`pmtiles` CLI；python 3.13 + uv 0.12；cargo 1.96；java 11。不需要 tilemaker / planetiler / osmium / qgis。
- 目标机：客户端与单机 Windows x64；集中部署服务端 Windows 或 Linux x64（D-015 / D-016）。MSVC / GCC 构建、Node LTS 版本与验证机待阶段 0 冻结；emcore / foundation 的 CMake 无平台私有 flag 且已链 `ws2_32`，但**只在 macOS 实测过**，MSVC 与 GCC 构建需在 D3 首次验证。
- 构建与测试命令待代码建立后回填。占位：`web`、`server`：`npm run dev | build | test`；`engine`、`geo`：`cmake -S . -B build && cmake --build build && ctest --test-dir build --output-on-failure`；`scene`：`uv run python scene/fetch_tiles.py --aoi <id> --estimate`（已可用）、`uv run python scene/register_basemap.py --planet <planet.pmtiles> --dem <dem> --sha256 <hex> --link`。
- 数据工具（已可用，依赖 h5py + numpy，经 uv 拉起，不进交付包）：
  转换 `uv run --quiet --with h5py --with numpy python tools/iq_convert.py <源.mat 或目录> -o data/iq/measured/<batch>/`；
  质检 `uv run --quiet --with h5py --with numpy python tools/iq_survey.py data/iq/measured/<batch>/ --report <报告.md>`；
  单测 `uv run --quiet --with h5py --with numpy python tests/unit/test_iq_tools.py`（32 项，用合成夹具，不依赖数据集）。
- 验收入口：`tests/golden` 与 `tests/regression` 全绿 + 12 项标准算例（04 §15.2）。

## 里程碑状态

单元格 ≤ 5 行，量化结果一行数字，其余进 WORKLOG。

| # | 里程碑 | 对应 | 状态 | 退出条件 | 量化验收 | 锚点 |
|---|---|---|---|---|---|---|
| P0 | 需求冻结与数据摸底 | 04 §13.2 / WP1 | 进行中 | 04 §13.2 四条 + 显示子线定位与 AOI 已冻结 + 缺失引用文件已索取 | — | — |
| P1 | 最小端到端 IQ 闭环 | 04 §13.3 / WP3-4-6 | 未开始 | 04 §13.3 四条 + 1 个跨层一致性算例（自由空间 + AWGN 能量检测 Pd：M1 公式 vs M3 蒙特卡洛；PROVISIONAL） | — | — |
| P2 | B/S 框图平台与组件化 | 04 §13.4 / WP2-3-8 | 未开始 | 04 §13.4 六条 + 05 P0 端口命名预留检查 + Windows 单机一体化包在干净 Windows 机上安装运行 | — | — |
| P3 | 工程等效模型与实测校准 | 04 §13.5 / WP4-7 | 未开始 | 04 §13.5 四条 + 首批跨层一致性算例全部在容差内，M1/M2 校准参数已回写并版本冻结 | — | — |
| P4 | 试用、整改与交付 | 04 §13.6 / WP8 | 未开始 | 04 §13.6 四条 + 第三方许可合规 | — | — |
| D0 | 场景数据包 | scene/ | 进行中（D0-1、D0-2、D0-5 完成 2026-09-03） | 共享底图与 DEM 已登记 + AOI buildings.geojson（解码合并，含 src）+ 区域总清单，全离线可加载 | 底图 137370745450 B、sha256 b4c46742…；DEM 87381 文件；切片 206 瓦片 4342046 B | WORKLOG 2026-09-03「D0-1 / D0-2」 |
| D1 | 2.5D 离线底图在 web/ 可显 | web/scene | 未开始 | Range 服务、字形/sprite 随包、ASCII 验收通过；同一 AOI 与 Airports 并排截图，图层与风格一致 | — | — |
| D2 | 态势图层接 WS 状态流 | web/scene | 未开始 | 无人机图标/航迹/覆盖热力图/包络随状态流刷新 | — | — |
| D3 | 遮挡库移植与验证 | geo/ | 未开始 | golden 148 例 rel ≤ 1e-9 + 解析锚点；接入 04 §7.3 LOS/NLOS | — | — |
| D4 | 渲染—物理同源验收 | web + geo | 未开始 | 同一 GeoJSON 驱动渲染与遮挡；探针无副作用 | — | — |

D0–D4 挂靠 P0 冻结后启动，不进入 P1 退出条件。

## 决策日志

| # | 日期 | 决策 | 依据 / 影响 |
|---|---|---|---|
| D-001 | 2026-09-02 | 地理场景视图 = 信号级仿真的场景设置与环境背景（传播/绕射/反射计算依据）；框图 = 计算链路、参数与 I/O 监控；三视图切换 | 用户确认；04 无此需求，挂 04 §3.1-2 与 §7.3，须进阶段 0 冻结清单 |
| D-002 | 2026-09-02 | 底图沿用 Airports；建筑走独立 GeoJSON 同源驱动渲染与遮挡 | 瓦片建筑层经切割简化且 `height ?? 8`，不适合计算 |
| D-003 | 2026-09-02 | B/S，不用 Tauri；应用服务 Node/TS | 04 §2.5；与前端同语言共享 schema |
| D-004 | 2026-09-02 | foundation 已获授权，可 vendored 使用 | 用户确认；需补 `ModelApi.hpp` 与顶层 CMakeLists |
| D-005 | 2026-09-02 | 建筑遮挡复用 emcore 实现，移植后须 golden + 解析锚点验证 | 用户确认 |
| D-006 | 2026-09-02 | WORKLOG 纪律：每任务节点立即追加，状态快照置顶；里程碑表单元格 ≤ 5 行 | 方法论阶段 5 |
| D-007 | 2026-09-02 | 单仓多目录布局如上；方案文档与设计报告留根目录按序号编号 | 用户既有项目惯例 |
| D-008 | 2026-09-02 | MapLibre GL pin 5.24 + pmtiles 4.4（取 em-demo 版本，非 Airports 5.6.1） | 避免版本分叉 |
| D-009 | 2026-09-02 | 常数策略：移植模块守原常数，新代码统一 `c = 299792458` 与严格 ENU | emcore README W5 警告 |
| D-010 | 2026-09-02 | 建筑 GeoJSON 从本地 planet.pmtiles z15 瓦片解码合并生成，与底图同一 OSM 快照；缺高度地区后续逐步补数据 | 用户确认；建库不联网 |
| D-011 | 2026-09-02 | 概念模型库定位为 M1/M2 参数供给层与归约目标层；本系统建设 M2+M3；EM-R/J/H/N/C/F 六族不在本系统范围 | 用户提出衔接问题；01 §9.2、02 §6.1 |
| D-012 | 2026-09-02 | 溯源字段扩展 `model_layer(M)` 与 `credibility(V)` | 01 §3.1 要求同时声明 M/E/V |
| D-013 | 2026-09-02 | 新增 `SceneParamFrame` 慢变参数端口；`ChannelPathSet` 首期即启用；IQ 流与参数流不得直连 | 03 §11.6、§11.7；05 §5.2 |
| D-014 | 2026-09-02 | P1 退出条件含 1 个跨层一致性算例（PROVISIONAL，待 04 修订确认） | 01 §8.3；04 §13.3 原文无此条 |
| D-015 | 2026-09-02 | 首期交付平台 Windows x64 优先；Linux / macOS 可构建不阻塞；国产化平台（麒麟 / 统信、ARM64 / 龙芯）不在首期范围，MATLAB Runtime 路线因此不受 ARM 限制影响 | 用户确认"先保证 Windows 上可用" |
| D-016 | 2026-09-02 | 细化 D-015：内网集中模式的服务端可视情选 Linux x64，`server/`、`engine/`、`geo/` 双平台构建；客户端与单机一体化包仍 Windows 优先。D-015 中"国产化不在首期"相应放宽：服务端 Linux 发行版含国产化服务器版作为候选，阶段 0 定；ARM64 / 龙芯仍不在首期 | 用户确认"后台服务适情可以是 Linux" |
| D-017 | 2026-09-02 | 地图渲染的图层顺序与显示风格照搬 Airports（浅色手写 Protomaps 样式、hillshade、建筑拉伸外观、相机与控件、字形策略）；em-demo 只贡献态势图层的图形语义与离线加载机制，其深色主题与 `protomaps-themes-base` 不采用；态势色值在浅色底图上重标定 | 用户确认"沿用或照搬 Airports" |
| D-018 | 2026-09-03 | 两个公开数据集**互补不替代**，都完整保留。DroneRFb-DIR 承担：跨层算例 ② 的唯一量级依据（视距/非视距标签）、P3 的 D 组独立验证集（出版方已划分）、DS-6 虚警率标定主样本（62 片背景）、`iq_survey` 正交项 `valid` 正例与 DA-7 对照组、个体识别素材。DroneRFa 承担：距离与路损粗档标定、运动与多普勒、正交不平衡唯一校准素材、长突发时序、双通道解析分支。转换与质检按角色排序，不做删减 | 用户问"DroneRFb 是否可以不用了"；06 §11.4、§11.5 角色段 |
| D-019 | 2026-09-03 | 实测路损指数只冻结**粗档结论「2.4 GHz 城市户外链路 n ≈ 2」**：`T0010` 六片 n = 1.93（逐对极差 0.12、标准差 0.05），`T0011` 三片 1.69，两机型宽基线一致。**1.93 的前提是"距离取区间中点"这一计算假设，不代表数据精度**——真实距离比只能定在 2.0–7.5，同一实测降幅对应 n = 1.29–3.75。P3 模型卡必须三件事一并写；相邻距离档比较一律不得用于标定；带真实置信区间的路损曲线仍只能靠带 GPS 距离的甲方自采数据 | DA-6 实测（`scripts/da6_pathloss.py`）；WORKLOG 2026-09-03 第四条 |
| D-020 | 2026-09-03 | IQ 数据格式定稿（`docs/iq-format.md` 第 3、4 节）：容器用**裸样点文件加旁挂 JSON 清单**（Range 取区间时字节偏移是常数乘法，且与 SigMF 两文件结构同构）；字节序**固定小端且不做自动探测**；单段上限 67108864 复样点；元数据十四个顶层键，另加 `field_sources` 逐字段标注 `measured/paper/derived/assumed/absent`；`not_applicable` 与 `valid` 严格分开，整体状态取八项最差。**正交不平衡判据取安静帧的 I/Q 标准差比，不取整片**——实测 DroneRFa 的不平衡在噪声路径上，整片值随信噪比趋近 1，按整片判会漏掉三片中的两片。直流、标准差比、互相关三项判据取「固定阈值」与「5 倍统计标准差」中较宽者，避免短窗误报 | P1-1 第一批定稿；WORKLOG 2026-09-03 第五条；实现见 `tools/` |
| D-021 | 2026-09-03 | **AOI = 北京亚运村周围**（用户否决原计划的 em-demo 西安范围）。中心 (116.405, 39.990) 由用户定；范围 `116.345,39.945,116.465,40.035`（约 10 × 10 km）由实施方暂定、标 PROVISIONAL；定义文件 `scene/aoi/beijing-yayuncun.json`，含从底图瓦片解出的地名核实证据。后果：em-demo 的 13,594 栋西安 Overpass 建筑集不再能作 D0-4 对拍基准，需在建库阶段对北京 bbox 重拉 | 用户指示"不放在西安，放在北京亚运村周围"；范围大小待用户确认 |
| D-022 | 2026-09-03 | **底图与 DEM 直接用整份全球文件，登记为共享资产 `data/basemap/`，不按 AOI 裁切**：`planet.pmtiles` 137370745450 B（sha256 `b4c46742…`，planetiler 0.10.2，OSM 2026-08-17）、terrarium DEM z0–8 共 87381 文件。开发机上软链到 Airports，目标机放真实文件；必须经 Range 服务提供。`scene/fetch_tiles.py` 裁出的 AOI 切片 `basemap-slice.pmtiles` 降为测试夹具与便携底图（AOI 外空白）。缩小到 AOI 之外仍有完整世界图，"AOI 外空白"这一继承的坑随之消失 | 用户指示"我可以用大的呀，128 GB 没有问题"；项目记忆：存储不是约束，不做省空间取舍 |

## 对上游文档的修正与补充

- 显示子线（D0–D4）是 04 之外的新增需求，04 修订前标 **PROVISIONAL**。
- 05 编制依据是 04 V1.0（其首期基线假设无 B/S 条目）；05 与 04 V2.0 冲突处以 V2.0 为准。
- 04 附录 D 引用编号有误："08.面向反无人机应用…需求分析" 实为 02；"基于MATLAB_Simulink…v3.0" 应为 03。
- 04 §8.1 引用的 `无人机信号侦察仿真系统_主界面交互原型_v1.0.html`、04 附录 D / 05 附录 C 引用的《城市反无人机电子侦察IQ仿真两阶段建设方案》《信号侦察模型_信号级与IQ级模拟能力说明》《signal signature database》《实施方案_v1.0》、01/02 引用的三张架构图 png，均不在本目录，已列 OPEN。
- foundation README 所述顶层 CMakeLists 与 target 名 `model_foundation_*` 与实际不符，以实际为准（无顶层；`model_math / model_io / model_serialization`）。
- 概念模型库 60 份无 M 层字段；本项目以「功能级—信号级衔接」一节的族归属表为口径，建 `docs/concept-model-layers.md` 时逐份确认。
- 04 §15.2 十二项标准算例建议增补跨层一致性算例（D-014）；04 修订前以本文件为准。

## 继承的坑（尚未在本项目复现，先记）

- PMTiles 需要 HTTP Range：`python3 -m http.server` 对 Range 返回整文件；用 Airports `serve.py` 或自实现。
- 矢量档案 zoom 范围内缺瓦片渲染为空白，不回退父级；混合粒度 merge 后区域外放大一片空白。
- Tauri 自定义协议不支持 Range，WKWebView 明显慢于 Chrome（本项目不用 Tauri 的直接原因之一）。
- Web 资源文件名含非 ASCII，macOS 打包后在 Windows 解压乱码导致 404。
- foundation 缺 `ModelApi.hpp`；emcore 三套常数刻意不统一，"统一化"会破坏 golden。
- 定位 CEP 公式曾经蒙特卡洛散布校验发现有误（√trace → 0.5887·(σmax+σmin)），TS/C++ 两侧同步修正（EM-C-UAV 09 号方案 W4）——解析锚点与统计校验缺一不可。
- Windows 交付经验（em-demo 打包说明）：启动脚本 `.bat` 必须 GBK 编码 + CRLF 换行，否则中文乱码或无法执行；macOS 上 zip 打包中文文件名到 Windows 解压乱码；Windows 原生构建在 Mac 上无法交叉完成，需 Windows 机或 CI。
