# 显示产品与视窗抽取

**状态**：字段已冻结（2026-09-04，决策 D-030、D-031）。观测点组件与产品写盘已实现（B-3，2026-09-05）；
抽取端点已实现（B-7，2026-09-06，决策 D-046，`server/src/products/`），归约的确切定义见 §3.1。
`scatter` 与三个 JSONL 产品的**生产者**尚未实现（分别等 `iq` 产品与 G 线）。

**依据**：铁律 7（原始 IQ 不进浏览器；展示数据按时间窗、频段、像素宽、统计量抽取；禁止
JSON / Base64 封装二进制）；04 §6.4（展示数据五类）、§8.3（引擎向应用服务发布降采样显示
产品）、§12.2、§16.4（验收级条款）；06 备忘录 §9A B-3、B-7。

---

## 1. 产品目录

```
data/runs/<task_id>/
├── task.json                    任务摘要（cuav-task/1，服务端写，字段见 §1.1）：框图哈希、场景哈希、种子、运行态与结果四态、起止、实时因子、引擎版本
├── diagram.json                 框图副本，服务端落盘，永不含内部参数（B-5）
├── diagram.resolved.json        解析旁挂 cuav-resolved/1，只在有回放节点时写（docs/diagram-format.md §9）
├── events.jsonl                 引擎 stdout 事件原样落盘，每行带 seq；由 cuav_run 自己写，与 stdout 逐字节相同（B-4）；服务端不改它，也不对外暴露
├── track.jsonl                  实体状态，每行一个 EntityState（见 docs/scenario-format.md §7）
├── links.jsonl                  链路帧读数，每行一条链路一帧（字段同 WS link 事件，docs/api-versions.md §4）
├── detections.jsonl             检测列表，每行一个 Detection
└── <observation_point_id>/      每个观测点一个子目录
    ├── spectrum.f32             定长行：每行 nfft 个 float32（dB），一行 = 一帧
    ├── spectrum.index.json
    ├── envelope.f32             定长行：每行 3 个 float32（min, max, rms），一行 = 一桶
    ├── envelope.index.json
    └── iq/                      可选：该观测点的 IQ，本项目 .iq 复 int16 交织 + 旁挂清单（docs/iq-format.md）；B-3 首版未实现，组件暂不声明该参数
```

`data/runs/` 不入 git。应用服务只经第 3 节的抽取端点提供数据，不把目录挂成静态文件。

### 1.1 `task.json`（`cuav-task/1`，B-5，2026-09-05）

服务端在每次状态变化时原子写（写临时文件再改名）。路径类字段只有任务目录内的相对文件名，没有服务器路径。

| 字段 | 说明 |
|---|---|
| `schema_version` | 固定 `cuav-task/1` |
| `task_id` | `t<YYYYMMDD>-<HHMMSS>-<4 hex>`，即目录名，也是引擎事件里的 `task_id` |
| `diagram_id`、`name`、`diagram_sha256` | 取自框图；哈希对 `diagram.json` 的文本 |
| `scenario_sha256` | 有 `scenario_ref` 时取其哈希 |
| `seed`、`seed_source` | 种子与来源 `diagram / cli`（开始事件后才有来源） |
| `run_state` | `queued / running / finished / failed / cancelled` |
| `result`、`reasons[]` | 结果四态与原因；排队与运行中为 `not_applicable`；取消 → `not_applicable`，失败 → `invalid` |
| `created_utc`、`started_utc`、`ended_utc` | 起止时间；`started_utc` 以引擎 `task.state running` 的为准 |
| `wall_s`、`realtime_factor`、`rounds`、`engine_version` | 取自引擎结束事件 |
| `exit_code`、`signal` | 进程关闭后才有；与四态正交（D-041） |
| `cancel_requested` | 服务端是否收到过取消 |
| `error` | `{code, node_id, port, message}`，引擎 `error` 事件或服务端归类的 `engine` 码 |
| `observation_points[]` | `{op_id, node, port, products, rows_seen{spectrum?, envelope?}}`。`rows_seen` 按 `product_row` 事件计数，是**下界**：引擎先刷盘再发事件，被杀时文件可能多一行、索引 `rows` 可能落后不到 64 行。**读端一律以文件长度 `floor(size / (row_len × 4))` 为准**（B-7） |
| `data_refs[]` | `{node_id, data_id, holdout}`，回放节点引用的数据 |
| `warnings[]` | 验收集片段用于回放的提示（D-038）、重启对账说明等 |
| `idempotency_key` | 提交时的 `Idempotency-Key`，重启后据此重建幂等表 |
| `last_seq` | 已折入本记录的最大事件序号 |
| `stderr_tail` | 引擎 stderr 尾部（≤ 8 KB，已脱敏），只在进程结束后有 |
| `files` | `{diagram, resolved?, events}` 三个相对文件名 |

## 2. 索引文件（已冻结）

`spectrum.index.json`：

| 字段 | 说明 |
|---|---|
| `schema_version` | 固定 `cuav-product/1` |
| `kind` | `spectrum` |
| `dtype`、`byte_order` | `float32`、`little` |
| `op_id` | 观测点标识 |
| `row_len` | 每行元素数，即 nfft |
| `rows` | **已写完的行数**；运行中每 64 行刷一次，收尾时最后更新 |
| `sample_rate_Hz`、`center_Hz` | 观测点处的采样率与中心频率，来自 `BlockMeta` |
| `bin_width_Hz` | 频率分辨率 |
| `frame_hop_samples` | 相邻两行的样点间隔 |
| `start_sample`、`t0_s` | 第一行对应的样点序号与逻辑时间 |
| `nfft`、`segments_per_frame`、`window` | 谱参数；`frame_hop_samples = hop × segments_per_frame` |
| `scale` | `dBm` 或 `dBFS`。有 `calibration` 即为 `dBm`：引擎内部功率单位是 mW（`|x|² = 功率 / mW`，D-047），样点在**源端**已换算，观测点不再加偏移，行值直接是 dBm；没有任何标定常数才写 `dBFS`。界面对用户只标 `dBm`，来源徽标、常数与出处只在开发者模式 `?dev=1` 显示（D-047 ④，修正 D-038 的显示层） |
| `calibration` | `{offset_dB, source ∈ {measured, paper, assumed, model}, note}`：`offset_dB` 是源端用过的常数——回放源为清单 `power.calibration.full_scale_dBm`（满量程对应的 dBm，2026-09-06 估算：DroneRFb-DIR −1.6 `model`、DroneRFa −50.0 `paper`，原型阶段验证值），合成源为 0（`model`）；`AddMixer` 两路都标定才标定、来源取较弱者（`measured > paper > model > assumed`）；缺失即无此字段 |
| `floor_dB` | 零功率频点的下限（−300 dB），读端据此识别精确零 |
| `state`、`state_reasons` | 四态与原因，取自被观测信号的块元数据；**末行段数不足、末桶样点不足、丢弃尾样点是流结束的自然结果，不降级** |
| `notes` | 说明性备注：`末行只有 m/K 段`、`末桶只有 n/N 个样点`、`收尾丢弃不满一段的 k 个样点` |
| `trace` | 被观测信号的溯源八件套 |
| `producer` | `{component: ObservationTap, version, engine_version}` |

`envelope.index.json` 同上，`kind = envelope`，`row_len = 3`，`columns = [min_abs, max_abs, rms_abs]`（桶内 |x| 的最小、最大、均方根，线性、相对满量程），
`scale = sqrt_mW`（已标定：|x| 的单位是 sqrt(mW)，D-047）或 `linear_FS`（未标定），已标定时同样带 `calibration`；另有 `bucket_samples`（每桶样点数）与 `last_bucket_samples`（末桶实际样点数）。

写入约定：行定长追加；索引在**写完第一行**时刷一次，此后每 64 行一次，收尾时最后更新（首行那次是给
读端的：没有索引就不知道 nfft 与采样率，抽取端点只能回 409，B-7 / D-046）。

**读端一律以文件长度定行数**：`rows_available = floor(文件字节数 / (row_len × 4))`。索引里的 `rows`
只用来判断索引是否已收尾（`index_final = rows == rows_available`），它决定包络末桶按满桶还是按
`last_bucket_samples` 计权。这条不是可选项：`rows` 每 64 行才刷一次，任务被杀时还会永远停在最后一次
刷新——实测取消的任务 `t20260905-143440-f5f3` 包络索引记 1344 行而文件有 1392 行。行定长加上
`floor` 使得读正在追加的文件也永远读不到半行。

## 3. 抽取端点（已冻结）

| 端点 | 参数 | 返回 |
|---|---|---|
| `GET /api/v1/results/{task_id}/{op_id}/spectrum` | `t0, t1, f0, f1, px, py, stat` | 二维 Float32，列 = 频率、行 = 时间 |
| `GET /api/v1/results/{task_id}/{op_id}/envelope` | `t0, t1, px` | 三列 Float32（min, max, rms），行 = 像素 |
| `GET /api/v1/results/{task_id}/{op_id}/scatter` | `t0, t1, n` | 复样点 Float32 对，n ≤ 65536；是抽样的展示数据，不是 IQ 流 |
| `GET /api/v1/results/{task_id}/track` | `t0, t1, stride` | JSON 数组 |
| `GET /api/v1/results/{task_id}/links` | `t0, t1, stride, link_id?` | JSON 数组，供场景视图回放链路读数 |
| `GET /api/v1/results/{task_id}/detections` | `t0, t1` | JSON 数组 |

参数语义：

| 参数 | 说明 |
|---|---|
| `t0`, `t1` | 秒，相对索引里的 `t0_s`；缺省全程 |
| `f0`, `f1` | Hz，相对 `center_Hz`；缺省全带 |
| `px`, `py` | 目标像素宽（频率方向）与高（时间方向）；`py` 缺省取原始行数与上限中的较小者 |
| `stat` | `max` / `mean` / `min`，缺省 `max`；多行合一时逐列取该统计量 |

响应：`application/octet-stream`，Float32 小端行主序；维度与实际范围在响应头
`X-CUAV-Rows`、`X-CUAV-Cols`、`X-CUAV-T0`、`X-CUAV-T1`、`X-CUAV-F0`、`X-CUAV-F1`、`X-CUAV-Stat`、`X-CUAV-State`。

规则：

1. `px` 大于原始列数时**不插值**，只截取并返回实际列数；`py` 同理。
2. 单次响应上限 16 MB，超出返回 413 并在响应体建议更粗的 `px` / `py`。
3. 抽取在应用服务里用 TypeScript 完成（原型阶段）；性能不够再下沉到 C++，端点不变。
4. 抽取结果必须与 Python 参考对同一产品文件做同样归约的结果逐值一致（B-7 验收）。

### 3.1 归约的确切定义（B-7，2026-09-06，D-046）

实现在 `server/src/products/`，参考实现 `algos/reference/product_window.py`，两侧逐行对译。
区间一律**半开** `[lo, hi)`；所有分组边界是整数运算，与浮点无关。

**行选择**（谱 `dt = frame_hop_samples / sample_rate_Hz`，包络 `dt = bucket_samples / sample_rate_Hz`）：

```
r0 = t0 缺省 ? 0 : clamp(floor(t0 / dt), 0, rows_available)
r1 = t1 缺省 ? rows_available : clamp(ceil(t1 / dt), 0, rows_available)
```

**列选择**（只谱；`half = floor(nfft / 2)`，对奇偶 nfft 通用）。列 k 的中心频率是
`center_Hz + (k − half)·bin_width_Hz`，覆盖 `[(k − half − 0.5)·bw, (k − half + 0.5)·bw)`：

```
c0 = f0 缺省 ? 0 : clamp(floor(f0 / bw + half + 0.5), 0, nfft)
c1 = f1 缺省 ? nfft : clamp(ceil(f1 / bw + half + 0.5), 0, nfft)
```

**分组**：n 个输入项分成 m 组，边界 `B[g] = floor(g·n / m)`，`g = 0..m`；`m = min(目标, n)`，
所以目标超过原始数时每组恰好一项（即规则 1 的「不插值」）。时间与频率两个方向同法。

**统计量**：

| 量 | 定义 | 复现性 |
|---|---|---|
| `max` / `min` | 直接对 dB 值取 | 逐位可复现（比较不引入舍入） |
| `mean` | **线性功率域**聚合（铁律 5）：`10·log10( Σ 10^(v/10) / count )`，float64 按行主序顺序累加，结果转 float32 | 依赖 `pow` 与 `log10`，允许 1 个 float32 ulp |
| 包络合桶 | `[min(min), max(max), sqrt(Σ n_j·rms_j² / Σ n_j)]`；`n_j = bucket_samples`，**仅当索引已收尾且 j 为末行**时取 `last_bucket_samples` | 逐位可复现 |

谱的 `mean` 对行不加权：末行段数不足是流结束的自然结果，不影响该行的值本身。累加顺序是逐位复现的
前提——参考实现必须写显式循环，不得用 Python 内置 `sum()`（3.12 起是 Neumaier 补偿求和）或 numpy
（成对求和），两者都不是「acc = acc + x」。

**缺省与上限**：`px` 缺省 `min(窗内列数, 4096)`；`py` 缺省 `min(窗内行数, 2048, floor(16 MiB / (列数 × 4)))`
——**不带参数的请求永远不会 413**。显式值必须是不超过 9 位的正整数。

**响应头**取实际覆盖的范围，都是**相对量**（`String(x)` 的十进制文本）：`X-CUAV-T0 = r0·dt`、
`X-CUAV-T1 = r1·dt`、`X-CUAV-F0 = (c0 − half − 0.5)·bw`、`X-CUAV-F1 = (c1 − half − 0.5)·bw`；
`X-CUAV-State` 取索引里的 `state`。包络没有 `X-CUAV-F0/F1/Stat`。绝对频率与绝对时间由客户端用
索引端点的 `center_Hz` 与 `t0_s` 换算。空窗口返回 200、`X-CUAV-Rows: 0`、空响应体。

### 3.2 就绪语义与错误码（B-7）

| 情形 | 码 | 响应体 |
|---|---|---|
| 任务不存在、`op_id` 非法、观测点没有这种产品（任务已终态） | 404 | `{error, task_id, op_id?, kind?}` |
| `scatter` | 404 | `{error, reason: "product_unsupported", message}`——观测点本版本不产出 `iq` 产品（框图装载器拒绝 `products` 里的 `iq`，D-040 ③），端点待 `iq` 产品落地 |
| 参数不合法（非十进制数、非正整数、`t1 < t0`、`f1 < f0`、`stat` 越界） | 400 | `{error: "bad_request", param, message}` |
| 产品文件还没出现，任务仍 `queued / running` | 409 + `Retry-After: 1` | `{error: "not_ready", reason: "product_missing", bytes, rows_available, run_state}` |
| 索引还没写出来（任何运行态） | 409 + `Retry-After: 1` | `{error: "not_ready", reason: "index_missing", bytes, rows_available, run_state}`；谱的 `rows_available` 为 `null`（行长未知） |
| 索引不合法、读到短行 | 500 | `{error: "index_invalid" \| "short_read", message}` |
| 超过单次响应上限 | 413 | `{error: "payload_too_large", max_bytes, rows, cols, bytes, suggest: {px, py}}`，`suggest` 按 `sqrt(上限 / 字节数)` 缩，重取必定能过 |

**409 不是错误，是「还没到」**：客户端收到后按 `Retry-After` 重试即可，通常下一条 `product_row`
事件到达时就已就绪。**参数校验先于就绪判定**：坏参数在任何运行态下都返回 400，不被 409 盖住，
否则客户端会拿着一个永远不可能成功的查询一直重试。

### 3.3 索引端点（B-7 新增）

`GET /api/v1/results/{task_id}/{op_id}/{spectrum|envelope}/index` 返回索引原文加三个字段：
`rows_available`（文件长度定的行数）、`index_final`、`run_state`。客户端用它建频率轴与时间轴、
读 `scale` 与 `state`，再决定视窗参数。索引里没有任何服务器路径（04 §8.6）。

### 3.4 JSONL 端点（`track` / `links` / `detections`）

三者共用一个时间窗读取器：闭区间 `t0 ≤ t_s ≤ t1`；`stride` 按键抽稀（`track` 按 `id`、`links` 按
`link_id`、`detections` 全局），每个键保留第 0、stride、2·stride… 条；`links` 另支持 `link_id` 精确过滤。
末尾没有换行的残片一律丢弃（生产者可能正在写），不可解析或缺 `t_s` 的行跳过并在 `X-CUAV-Skipped`
里计数。响应是裸 JSON 数组，头带 `X-CUAV-Rows`、`X-CUAV-Skipped`、`X-CUAV-T0/T1`、`X-CUAV-State`；
超上限 413 并建议更大的 `stride`。**这三个文件首期还没有生产者**（G-2 的 `ScenarioSource` 与 G-5 才写），
端点先行，生产者落地后不必改读取层。

## 4. 实时推送

运行中的新行经 WebSocket **二进制帧**推送（`docs/api-versions.md` §4，字节布局见 §4.0，B-6 已实现，D-044）：
`[u32 LE header_len][JSON 帧头 {seq, task_id, op_id, kind, row_index, row_len, t_s} 补齐到 4 字节][Float32 LE 载荷]`，
载荷就是 `.f32` 该行的原字节。浏览器只追加显示不保存；回看与缩放走第 3 节端点。量级：20 Hz × 1024 bin × 4 B ≈ 80 KB/s。
允许丢帧，但必须以 `dropped{from, to, count}` 告知（区间连续、先于下一帧），`task.state` 与 `error` 事件永不丢。
断线后的补取端点 `GET /api/v1/tasks/{id}/events?since` 里 `product_row` 只是文本（无数据）。

引擎侧的来源（B-4）：`ObservationTap` 每写一行就 `fflush`，随即经运行器在 stdout 发一条不带数据的 `product_row`
事件 `{op_id, kind, row_index, row_len}`（`docs/api-versions.md` §4.1）；应用服务据此从 `<op_id>/<kind>.f32` 的
`row_index × row_len × 4` 偏移读出该行并转成二进制帧。索引里的 `rows` 仍每 64 行更新一次，它服务的是回看端点，
实时推送不等它——推送按事件读，靠引擎逐行 `fflush` 保证；行尚未落盘（短读）时服务端退回发文本事件，不发半行。
回看端点走的是另一条路：按文件长度定行数（第 2 节），与索引的刷新节奏无关。

## 5. 待写

- [x] 观测点组件 `ObservationTap` 的参数（nfft、窗、桶长）与目录条目（B-3，2026-09-05）
- [x] 抽取端点的测试夹具（B-7，2026-09-06）：黄金基准 `tests/golden/product-window.json`（合成产品 12 个用例，只存公式与输入哈希）+ 真引擎与 Python 参考的逐字节对拍 `server/src/products/reference.test.ts`
- [x] 前端缓存约定（U-3，2026-09-06，D-048 ⑧）：只保留最近一次窗口 `(task, op, t0, t1, f0, f1, px, py, stat, envPx)` 的抽取结果（`web/src/signal/viewStore.ts`），量程变化只重查色表不重取；瓦片缓存键 `(op_id, t 桶, f 段, px)` 延后到 U-4，待回看延迟实测超过 100 ms 再议
