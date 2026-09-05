# 应用服务接口规范

**状态**：第 2 节硬性约束、3.1 已实现端点、3.3 待实现端点、第 4 节 WebSocket 事件均已冻结（3.3 与第 4 节于 2026-09-04 冻结，决策 D-030 / D-031，尚未实现）；第 1、5 节待写。

**依据**：`CLAUDE.md` 铁律第 7 条；04 号方案 §6.3、§8.6；决策 D-003。

---

## 1. 版本策略（待写）

需要定：版本号放在路径里还是请求头里；不兼容变更的判定标准；旧版本的下线周期。

## 2. 已冻结的硬性约束

| 约束 | 内容 | 依据 |
|---|---|---|
| 传输协议 | REST 加 WebSocket | 04 §6.3 |
| 事件可补取 | WebSocket 事件必须带序号，断线后可按序号补取遗漏事件 | 04 §8.6 |
| 必须支持 Range | 服务端必须支持 HTTP Range 请求，因为 PMTiles 依赖它。参考实现是 Airports 项目的 `serve.py` | 04 §8.6，D-003 |
| 浏览器不收原始 IQ | 浏览器只接收控制、状态，以及按视窗（时间窗、频段、像素宽度、统计量）抽取后的展示数据 | 铁律 7 |
| 大文件传输 | 分片续传。禁止用 JSON 或 Base64 封装二进制数据 | 铁律 7 |
| 浏览器不缓存原始 IQ | 同上 | 铁律 7 |

## 3. 端点清单

### 3.1 已实现（2026-09-04，里程碑 D1-1）

| 方法 | 路径 | 返回 | 说明 |
|---|---|---|---|
| GET/HEAD | `/api/v1/health` | `{status, service, version}` | 健康检查 |
| GET/HEAD | `/api/v1/scenes` | `{scenes: [id...]}` | 列出带入口清单的场景数据包 |
| GET/HEAD | `/api/v1/scenes/<id>/manifest` | 数据包入口清单原文 | 前端据此取底图、高程与建筑的地址，不硬编码路径 |
| GET/HEAD | `/data/basemap/*` | 文件，支持 Range | 全球底图与高程瓦片 |
| GET/HEAD | `/data/scene/<aoi>/*` | 文件，支持 Range | 场景数据包产物 |
| GET/HEAD | 其余路径 | 前端构建产物 `web/dist` | 无扩展名的路径回退到首页 |

**只有上表列出的目录会被暴露**。`data/iq/` 不在其中（铁律 7：原始 IQ 不进浏览器）。

三条路由规则是有意为之，都有测试守着：

1. `/data/` 与 `/api/` 下的未知路径**一律 404**，绝不回退首页。否则请求 `data/iq/` 会拿到
   200 与一页 HTML，既掩盖错误又让人误以为该路径存在。
2. 单页应用回退**只对没有扩展名的路径生效**。缺失的静态资源要 404，不能返回 HTML 让浏览器
   在解析脚本时才报出莫名其妙的错误。
3. 解析后落在根目录之外的路径返回 403；实现的安全契约是"要么 null，要么落在根内"。

### 3.2 Range 语义（已冻结）

按 RFC 9110 §14 实现，语义对齐参考实现 Airports `serve.py`：

| 情形 | 应答 |
|---|---|
| 无 Range 头 | 200 + 完整内容 |
| `bytes=start-end` / `bytes=start-` / `bytes=-suffix` | 206 + `Content-Range` |
| 末端越界 | 截到文件末字节，仍 206 |
| 起点越界、区间倒置、后缀长度为 0 | 416 + `Content-Range: bytes */size` |
| 多区间 `bytes=0-9,20-29` | **不支持**，按无 Range 处理返回 200 与完整内容 |

多区间那条是允许的降级（服务端可以忽略 Range），但必须显式写明，不能让调用方以为拿到的是
部分内容。实现见 `server/src/range.ts`，13 项单元测试加 17 项集成测试。

### 3.3 已冻结、待实现（2026-09-04，D-030 / D-031）

| 方法 | 路径 | 说明 | 步骤 |
|---|---|---|---|
| GET | `/api/v1/components` | 组件目录，缓存 `cuav_run --catalog` 的输出；格式见 `docs/component-catalog.md` | B-5 |
| POST | `/api/v1/tasks` | 提交框图 JSON（`docs/diagram-format.md`），返回 `{task_id, state}`；请求头 `Idempotency-Key` 防重（04 §8.6）。服务端在装载前把回放节点的 `data_id` 按数据索引解析成 `manifest_path`，注入服务端副本 `data/runs/<task>/diagram.resolved.json`；提交的框图里出现任何 `internal` 参数即 400（D-037） | B-5 |
| GET | `/api/v1/tasks`、`/api/v1/tasks/{id}` | 任务列表；单任务状态与摘要（`task.json`） | B-5 |
| POST | `/api/v1/tasks/{id}/cancel` | 取消运行中的任务 | B-5 |
| GET | `/api/v1/tasks/{id}/events?since&limit` | 按序号补取事件 | B-6 |
| GET | `/api/v1/results/{task}/{op}/spectrum`、`.../envelope`、`.../scatter`；`/api/v1/results/{task}/track`、`.../detections` | 按视窗抽取的展示数据；参数与响应见 `docs/display-products.md` §3 | B-7 |
| GET / PUT | `/api/v1/scenarios/{id}` | 场景文件读写，按 `docs/schemas/scenario.schema.json` 校验 | G-4 |
| GET | `/api/v1/datasets` | 各批数据索引的非路径字段：`data_id`、数据集、通道、中心频率、样点数、分段数、质量四态与原因、`holdout` 标记、`calibration{offset_dB, source}`（若有）；不暴露 `.iq`，不暴露任何路径 | U-4 |
| GET | `/api/v1/datasets/{data_id}` | 单条索引详情（非路径字段）与真值摘要 | U-4 |

项目管理、审计日志、分片上传、模型包留 P2。参考实现 `C-UAV Model Demo/emcore/` 的 `emsvc`
五个端点（`/api/v1/{health, models/catalog, radar/detect, signal/detect, los/check}`）只作命名参考。

## 4. WebSocket 事件（已冻结，待实现：B-6）

- 路径 `/ws`。客户端先发订阅报文 `{subscribe: task_id, since}`，`since` 为已收到的最大序号，首次为 0。
- 文本帧信封 `{seq, task_id, type, t_s, payload}`：`seq` 每任务从 1 单调递增；`t_s` 为逻辑仿真时间（秒）。
- 类型：`task.state`（运行态 `run_state ∈ {queued, running, finished, failed, cancelled}` 与结果四态 `result`，两者正交）、
  `progress`、`log`、`entity`（`EntityState`，见 `docs/scenario-format.md` §7）、`link`（每条链路每帧的 `SceneParamFrame`
  读数：`link_id, t_s, line_of_sight, distance_m, azimuth_deg, elevation_deg, path_loss_dB, delay_s, doppler_Hz, valid_from_s,
  valid_to_s, update_rate_Hz, state`）、`detection`、`error`（含 `node_id`、`port`，与引擎 `--validate` 的定位一致）、
  `heartbeat`、`dropped{from, to}`。日志与错误文本里的服务器路径由服务端替换为 `data_id` 或相对名后再下发（04 §8.6）。
- 二进制帧只承载 `spectrum` / `envelope` 行：帧头 `{seq, task_id, op_id, kind, row_index, row_len}` + Float32 载荷
  （`docs/display-products.md` §4）。铁律 7 禁的是 JSON / Base64 封装二进制，不禁二进制帧。
- 补取：断线后 `GET /api/v1/tasks/{id}/events?since=N`；服务端每任务保留环形缓冲，深度初值 4096 条文本事件，实测后定。
- 背压：只允许丢弃二进制行帧，丢弃必须发 `dropped{from, to}`；`task.state` 与 `error` 永不丢。
- 心跳 15 s；客户端重连退避 1 / 2 / 4 / 8 s 封顶，重连后带 `since`。

## 5. 后置能力的端口命名预留（待写）

05 号方案 P0 定义的八个端口在首期只做命名预留，不实现：`ArrayIQStream`、
`MultiSiteIQSet`、`ChannelPathSet`、`CalibrationSet`、`BearingReport`、`PositionReport`、
`TrackReport`、`DeviceStatus`。

例外：`ChannelPathSet` 首期即启用（决策 D-013），单径与双径也走这个端口，避免后置阶段
再改接口。

## 6. 待写清单

- [ ] 第 1 节 版本策略
- [~] 第 3 节 端点清单：3.3 已冻结，待 B-5 / B-7 / G-4 / U-4 实现
- [~] 第 4 节 WebSocket 事件：已冻结，待 B-6 实现
- [ ] 鉴权与审计（P2 阶段）
