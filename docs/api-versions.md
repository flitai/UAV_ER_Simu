# 应用服务接口规范

**状态**：第 2 节硬性约束、3.1 已实现端点（D1 静态与场景接口；2026-09-05 起含 B-5 的组件目录与任务端点、B-6 的事件补取端点，见 3.1a）、3.3 待实现端点、第 4 节 WebSocket 事件均已冻结（3.3 与第 4 节于 2026-09-04 冻结，决策 D-030 / D-031；第 4 节于 2026-09-05 由 B-6 实现，实现约定见 4.0，决策 D-044）；第 1、5 节待写。

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

### 3.1a 组件目录与任务（2026-09-05，B-5，决策 D-042）

| 方法 | 路径 | 返回 | 说明 |
|---|---|---|---|
| GET/HEAD | `/api/v1/components` | 组件目录原文 + `generated_at` | 缓存 `cuav_run --catalog` 的输出（进程内取一次），`generated_at` 是服务端取得时间（`docs/component-catalog.md` §2）；引擎二进制缺失 503 `engine_unavailable` |
| POST | `/api/v1/tasks` | 201 任务摘要（`task.json` 内容，含 `task_id`、`run_state = queued`、`result`） | 请求体 = 框图 JSON（`application/json`，≤ 1 MB）；请求头 `Idempotency-Key` 可选：同键同框图 200 返回同一任务，同键不同框图 409 `idempotency_conflict`。提交流程与失败码见下 |
| GET/HEAD | `/api/v1/tasks?limit=N` | `{tasks: [...]}` | 按 `created_utc` 降序；`limit` 缺省 100、上限 1000 |
| GET/HEAD | `/api/v1/tasks/{id}` | 任务摘要 | 不存在 404 |
| POST | `/api/v1/tasks/{id}/cancel` | 任务摘要 | 排队中立即 `cancelled`；运行中先 SIGTERM、3 s 后 SIGKILL（Windows 都是 TerminateProcess），进程退出后 `cancelled / not_applicable`；已结束 409 `task_finished`；不存在 404 |
| GET/HEAD | `/api/v1/tasks/{id}/events?since=N&limit=M` | `{task_id, since, events[], last_seq, run_state}` | 按序号补取（B-6，D-044）：返回 `seq > since` 的事件，升序、无缺号，最多 `limit` 条（缺省 1000、上限 5000）；`since` 缺省 0，非整数或负数 400 `bad_request`；不存在 404。缓冲内直接切片，缓冲外顺序读 `events.jsonl` 并经同一脱敏入口；服务端补发的终态在服务重启后按 `task.json` 合成。**这里的 `product_row` 永远是文本（无数据）**，行数据走第 4 节的二进制帧或 B-7 端点。空数组表示暂无新事件；「追平」的判据是空批次，不是不足 `limit` |

`POST /api/v1/tasks` 的处理顺序（每一步失败都不留任务目录）：

1. 体不是 JSON → 400 `{error: diagram_invalid, detail: {code: json_parse}}`；不是 `application/json` → 415；超 1 MB → 413。
2. 最小结构检查（`schema_version`、`diagram_id`、`name`、`nodes[]`、`run`、`observation_points[]` 可遍历）→ 400 `code = schema`。
   服务端**不复刻** schema 的其余规则，语义只在引擎一处解释（`docs/diagram-format.md` §3）。
3. 任何 `internal` 参数出现在节点或观测点 `params` 里 → 400 `code = internal_param`（D-037，两道闸的第一道）。
4. 回放节点的 `data_id` 按数据索引解析成相对仓库根的清单路径，写解析旁挂 `diagram.resolved.json`（§9 of `docs/diagram-format.md`）；解析不到 → 400 `code = data_id`。命中验收集的 `data_id` 允许，但写进任务 `warnings[]`（D-038）。
5. 落盘 `diagram.json`（原始框图缩进 2 重排，`diagram_sha256` 即其哈希）后**同步跑 `cuav_run --validate --task-id <id> [--resolved …]`**（实测约 9 ms）；失败 → 删目录，400 `{error: diagram_invalid, detail: {code, node_id, port, message}}`，四字段原样来自引擎（用户 2026-09-05 拍板：不建 failed 任务）。
6. 入队，201。队列 FIFO，同时运行数由环境变量 `CUAV_MAX_CONCURRENT_TASKS` 定，缺省 1。

任务摘要 `task.json`（`cuav-task/1`）的字段见 `docs/display-products.md` §1.1。运行态 `run_state ∈ {queued, running, finished, failed, cancelled}`
与结果四态 `result` 正交：取消 → `not_applicable`，失败 → `invalid`；引擎给了终态就以引擎为准，没给（被杀、退出码 4、起不来）由服务端定
并在事件流末尾补一条 `task.state`（`payload.source = "server"`，序号接在引擎之后）。

服务端拉起引擎的约定（D-042）：`spawn` 数组参数不走 shell；子进程 cwd = 仓库根；传给引擎的路径全部相对仓库根、纯 ASCII、字面 `/`
（`data/runs/<task_id>/diagram.json`、`--out data/runs/<task_id>`、旁挂里的 `data/iq/measured/<batch>/<data_id>.manifest.json`）；
恒传 `--task-id`。这样引擎的窄字符 `main()` 永远见不到可能含中文或空格的绝对根目录。引擎二进制位置取环境变量 `CUAV_RUN`，
缺省 `engine/build/cuav_run`（Windows 加 `.exe`）。服务收到 SIGINT / SIGTERM 时同步杀掉运行中的引擎并把这些任务标 `failed`
「服务停止时任务被中止」；重启后扫 `data/runs/*/task.json` 重建列表，遗留的 `queued / running` 任务按 `events.jsonl` 尾部的
最后一条 `task.state` 对账，没有终态就标 `failed`「服务重启时任务未结束」。

`/api/v1/health` 增加 `engine: {available, version?}`：`available` 是二进制是否可执行，`version` 只在目录已缓存时给出（不为健康检查起子进程）。

### 3.1b 视窗抽取（2026-09-06，B-7，决策 D-046）

全部 GET/HEAD，其它方法 405 `Allow: GET, HEAD`。归约的确切定义、参数语义、错误码与响应头见
`docs/display-products.md` §3.1–§3.4，那里是真理源，本表只列路径与要点。

| 方法 | 路径 | 返回 | 说明 |
|---|---|---|---|
| GET/HEAD | `/api/v1/results/{task}/{op}/spectrum?t0&t1&f0&f1&px&py&stat` | `application/octet-stream`，Float32 小端行主序，行 = 时间、列 = 频率 | `stat ∈ {max, mean, min}` 缺省 `max`；`mean` 在线性功率域聚合（铁律 5）；`px/py` 超过原始行列数**不插值** |
| GET/HEAD | `/api/v1/results/{task}/{op}/envelope?t0&t1&px` | 同上，三列 `[min_abs, max_abs, rms_abs]` | 合桶的 rms 按样点数加权；末桶只有索引收尾后才按 `last_bucket_samples` 计权 |
| GET/HEAD | `/api/v1/results/{task}/{op}/scatter` | 404 `product_unsupported` | 观测点本版本不产出 `iq` 产品（D-040 ③），待 `iq` 落地 |
| GET/HEAD | `/api/v1/results/{task}/{op}/{spectrum\|envelope}/index` | 索引原文 + `rows_available` + `index_final` + `run_state` | 客户端据此建频率轴与时间轴；不含任何服务器路径 |
| GET/HEAD | `/api/v1/results/{task}/{track\|links\|detections}?t0&t1&stride[&link_id]` | JSON 数组 | 闭区间取窗、按键抽稀；**生产者尚未实现**（G 线），现阶段这三个端点在终态任务上返回 404 |

响应头：`X-CUAV-Rows`、`X-CUAV-Cols`、`X-CUAV-T0`、`X-CUAV-T1`、`X-CUAV-F0`、`X-CUAV-F1`、
`X-CUAV-Stat`、`X-CUAV-State`（JSONL 端点用 `X-CUAV-Rows`、`X-CUAV-Skipped`、`X-CUAV-T0/T1`、`X-CUAV-State`）。
时间与频率都是**相对量**：时间相对索引的 `t0_s`，频率相对 `center_Hz`。

三个与别处不同的约定：

1. **读端以文件长度定行数**，不信索引里的 `rows`（`docs/display-products.md` §2）。
2. **409 `not_ready` 不是错误**：产品文件或索引还没出现时带 `Retry-After: 1`，客户端重试即可；
   只有终态任务确实没有这种产品才 404。
3. 单次响应上限 16 MB，超出 413 并给出必定能过的 `suggest`；不带参数的请求永远不会 413。

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

### 3.3 已冻结、待实现（2026-09-04，D-030 / D-031；B-5 四个端点与 B-6 的事件补取端点已于 2026-09-05 实现并移入 3.1a，B-7 的视窗抽取端点已于 2026-09-06 实现并移入 3.1b）

| 方法 | 路径 | 说明 | 步骤 |
|---|---|---|---|
| GET / PUT | `/api/v1/scenarios/{id}` | 场景文件读写，按 `docs/schemas/scenario.schema.json` 校验 | G-4 |
| GET | `/api/v1/datasets` | 各批数据索引的非路径字段：`data_id`、数据集、通道、中心频率、样点数、分段数、质量四态与原因、`holdout` 标记、`calibration{offset_dB, source}`（若有）；不暴露 `.iq`，不暴露任何路径 | U-4 |
| GET | `/api/v1/datasets/{data_id}` | 单条索引详情（非路径字段）与真值摘要 | U-4 |

项目管理、审计日志、分片上传、模型包留 P2。参考实现 `C-UAV Model Demo/emcore/` 的 `emsvc`
五个端点（`/api/v1/{health, models/catalog, radar/detect, signal/detect, los/check}`）只作命名参考。

## 4. WebSocket 事件（2026-09-04 冻结；2026-09-05 由 B-6 实现，决策 D-044）

- 路径 `/ws`。客户端先发订阅报文 `{subscribe: task_id, since}`，`since` 为已收到的最大序号，首次为 0。
- 文本帧信封 `{seq, task_id, type, t_s, payload}`：`seq` 每任务从 1 单调递增；`t_s` 为逻辑仿真时间（秒）。
- 类型：`task.state`（运行态 `run_state ∈ {queued, running, finished, failed, cancelled}` 与结果四态 `result`，两者正交）、
  `progress`、`log`、`entity`（`EntityState`，见 `docs/scenario-format.md` §7）、`link`（每条链路每帧的 `SceneParamFrame`
  读数：`link_id, t_s, line_of_sight, distance_m, azimuth_deg, elevation_deg, path_loss_dB, delay_s, doppler_Hz, valid_from_s,
  valid_to_s, update_rate_Hz, state`）、`detection`、`error`（含 `node_id`、`port`，与引擎 `--validate` 的定位一致）、
  `heartbeat`、`dropped{from, to, count}`。日志与错误文本里的服务器路径由服务端替换为 `data_id` 或相对名后再下发（04 §8.6）。
- 二进制帧只承载 `spectrum` / `envelope` 行：帧头 `{seq, task_id, op_id, kind, row_index, row_len}` + Float32 载荷
  （`docs/display-products.md` §4）。铁律 7 禁的是 JSON / Base64 封装二进制，不禁二进制帧。
- 补取：断线后 `GET /api/v1/tasks/{id}/events?since=N`；服务端每任务保留环形缓冲，深度初值 4096 条文本事件，实测后定。
- 背压：只允许丢弃二进制行帧，丢弃必须发 `dropped{from, to}`；`task.state` 与 `error` 永不丢。
- 服务端自己决定的终态（用户取消、引擎没给终态就退出）以一条 `task.state` 追加在引擎事件之后，`payload.source = "server"`，
  序号 = 引擎最后序号 + 1（B-5，D-042）。读端凭 `run_state ∈ {finished, failed, cancelled}` 判终态，不必区分来源。
- 心跳 15 s；客户端重连退避 1 / 2 / 4 / 8 s 封顶，重连后带 `since`。

### 4.0 实现约定（B-6，2026-09-05，D-044）

实现在 `server/src/ws/{hub,events}.ts`，挂在 http 服务的 `upgrade` 事件上；`/ws` 之外的 upgrade 直接以 `HTTP/1.1 404` 断开（浏览器侧表现为 1006）。

**订阅流程**。一个连接一个订阅。客户端发文本帧 `{subscribe: task_id, since}`（`since` 缺省 0），服务端先注册实时订阅、再应答
`subscribed{since, last_seq, run_state}`，然后按 `readEvents()`（与 3.1a 补取端点同一读函数）分批回放序号大于 `since` 的事件，直到读到空批次才转实时；
回放期间到达的实时事件排队，转实时后按序号去重。已结束的任务也可订阅，但 `since = 0` 会把全部行重放一遍，客户端应先 `GET /api/v1/tasks/{id}` 取 `last_seq`
作 `since`，历史走 B-7 端点。

**连接级报文**。`subscribed`、`heartbeat{last_seq}`（每 15 s 一条，同时发 WebSocket ping，两轮没有 pong 即断开）、`dropped{from, to, count}`、
`error{code, node_id: "", port: "", message}`（协议错误，随后关闭）沿用同一信封但 **`seq = 0`**：它们不属于任务的序号流。客户端规则：`seq = 0` 的报文不推进
`lastSeq`，唯 `dropped` 令 `lastSeq = to`。

**二进制帧布局**（只承载 `spectrum` / `envelope` 行）：

```
[u32 LE header_len][UTF-8 JSON 帧头，用空格补齐到 4 字节的倍数][Float32 LE × row_len]
```

帧头 = `{seq, task_id, op_id, kind, row_index, row_len, t_s}`（`t_s` 是该行的逻辑时间）；载荷就是 `<op_id>/<kind>.f32` 里该行的原字节，服务端不做转换。
`header_len` 是补齐后的长度，所以 `4 + header_len` 是 4 的倍数，客户端可零拷贝 `new Float32Array(buf, 4 + header_len, row_len)`（帧头 JSON 带尾随空格，
`JSON.parse` 照常解析）。**`product_row` 在 WebSocket 上一律是二进制帧**（回放与实时都是）；行读不到（文件尚未出现、短读）时退回发原文本 `product_row`
事件，序号不断，客户端稍后按 `row_index` 走 B-7 端点取。

**背压**。只丢二进制行帧：连接的 `bufferedAmount` 超过 1 MiB 时不读文件、把该行的序号并进待告知区间，并在发送**下一帧（任何类型）之前**先发
`dropped{from, to, count}`，因此 `dropped` 的区间总是连续且有序（客户端可按 `row_index` 的跳变知道少了哪些行）。文本事件（`task.state`、`error`、`log`、
`progress` 等）永不丢。`bufferedAmount` 超过 16 MiB 时以 4013 断开，客户端重连补取。

**关闭码**：4400 订阅报文不合法（非 JSON、不是 `{subscribe, since}`、二进制报文）；4404 任务不存在；4409 同一连接重复订阅；4013 客户端跟不上；
1011 服务端内部错误；1001 服务停止（服务收到 SIGINT / SIGTERM 时先关全部连接再退出）。

**服务端补发的终态**不在 `events.jsonl` 里（那是引擎的文件）。进程内它在缓冲里，序号 = 引擎最后序号 + 1；服务重启后缓冲为空，`readEvents()`
按 `task.json` 合成同一条（重启对账时 `last_seq` 已推到文件末序号 + 1），两条路径的读端看到的事件一样。

### 4.1 引擎 stdout 事件与退出码（B-4，2026-09-05，D-041）

`cuav_run` 的 stdout 每行一条 JSON，信封与上面的文本帧完全相同：`{seq, task_id, type, t_s, payload}`。`seq` 每进程从 1
单调递增；`task_id` 取 `--task-id`，缺省为 `--out` 的末级目录名（运行）或 `diagram_id`（校验）。应用服务转发文本事件前
只做一件事：把路径替换为 `data_id` 或相对名（04 §8.6）。`--out` 给出时引擎自己把每行原样落 `<out>/events.jsonl`，
stdout 与文件都逐行 flush。诊断文字走 stderr，不混进事件流。

| type | 何时 | payload |
|---|---|---|
| `task.state` | 运行开始与结束各一条 | 开始：`run_state = running`、`diagram_id`、`name`、`seed`、`seed_source ∈ {diagram, cli}`、`run{seed, duration_s, block_size?, max_rounds?}`、`nodes[]`、`observation_points[{op_id, node, port, products}]`、`engine_version`、`started_utc`。结束：`run_state ∈ {finished, failed}`、`result` 四态、`reasons[]`、`rounds`、`wall_s`、`realtime_factor`、`product_rows`、`nodes[{name, state, blocks_in, blocks_out, samples_in, samples_out, notes}]`、`ended_utc` |
| `progress` | 每轮调度，按墙钟节流（`--progress-interval-ms`，默认 100；0 = 每轮） | `round`、`nodes[]`（同上） |
| `log` | 装载摘要、种子覆盖、组件日志 | `level`、`message` |
| `product_row` | 观测点每写一行 | `op_id`、`kind ∈ {spectrum, envelope}`、`row_index`、`row_len`。**不带数据**：该行已逐行刷到 `<out>/<op_id>/<kind>.f32`，服务端按 `row_index × row_len × 4` 的偏移读出并转成二进制帧（§4） |
| `entity`、`link` | 场景运行时（G-2 起） | 字段同 §4 |
| `error` | 装载失败或运行失败 | `{code, node_id, port, message}`（`docs/diagram-format.md` §4）；运行失败 `code = run_failed`，`node_id` 为出错节点 |
| `validate` | `--validate` 成功时一条 | `ok`、`diagram_id`、`name`、`nodes[]`、`edges`、`observation_points[]`、`run`、`engine_version` |

`t_s`：`product_row` / `entity` / `link` 为该行或该帧的逻辑时间；`progress`、`log` 与结束的 `task.state` 取此前见过的
最大逻辑时间；开始的 `task.state` 与 `validate` 为 0。`detection` 事件待 P1-4d 的 `detections.jsonl`。

退出码：

| 码 | 含义 |
|---|---|
| 0 | 目录已输出 / 校验通过 / 运行到底（结果四态在 `task.state` 里，不影响退出码） |
| 1 | 命令行错误，或尚未实现的子命令（`--scenario-track` 待 G-2） |
| 2 | 框图装载失败（含解析旁挂或数据索引读不到），已发 `error`；运行模式下再发 `task.state failed` |
| 3 | 运行失败（初始化、处理、收尾、调度停滞、超轮数），已发 `error` 与 `task.state failed` |
| 4 | 产品目录建不了或 `events.jsonl` 打不开 |

`--seed N` 覆盖框图 `run.seed`：`task.state.seed_source = cli`，并发一条 `log` 写明原值与新值。数据解析入口
`--resolved <旁挂>`（`cuav-resolved/1`）或 `--data-index <index.manifest.json>...`，二者互斥；都不给而框图有回放节点
即 `error data_id`。`--catalog` 不走事件信封，直接输出目录 JSON（`docs/component-catalog.md`）。

## 5. 后置能力的端口命名预留（待写）

05 号方案 P0 定义的八个端口在首期只做命名预留，不实现：`ArrayIQStream`、
`MultiSiteIQSet`、`ChannelPathSet`、`CalibrationSet`、`BearingReport`、`PositionReport`、
`TrackReport`、`DeviceStatus`。

例外：`ChannelPathSet` 首期即启用（决策 D-013），单径与双径也走这个端口，避免后置阶段
再改接口。

## 6. 待写清单

- [ ] 第 1 节 版本策略
- [~] 第 3 节 端点清单：3.1a 已实现（B-5、B-6）、3.1b 已实现（B-7）；3.3 已冻结，待 G-4 / U-4 实现
- [x] 第 4 节 WebSocket 事件：已冻结并由 B-6 实现（4.0 实现约定，2026-09-05）
- [ ] 鉴权与审计（P2 阶段）
