# 显示产品与视窗抽取

**状态**：骨架，字段已冻结（2026-09-04，决策 D-030、D-031）。观测点组件、产品写盘与抽取端点
尚未实现，实现时以本文为准。

**依据**：铁律 7（原始 IQ 不进浏览器；展示数据按时间窗、频段、像素宽、统计量抽取；禁止
JSON / Base64 封装二进制）；04 §6.4（展示数据五类）、§8.3（引擎向应用服务发布降采样显示
产品）、§12.2、§16.4（验收级条款）；06 备忘录 §9A B-3、B-7。

---

## 1. 产品目录

```
data/runs/<task_id>/
├── task.json                    任务摘要：框图哈希、场景哈希、种子、状态四态、起止、实时因子、引擎版本、溯源
├── events.jsonl                 引擎 stdout 事件原样落盘，每行带 seq
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
| `scale` | `dBm` 或 `dBFS`。有 `calibration` 即为 `dBm`（行值已加上 `offset_dB`）；没有任何标定常数才写 `dBFS`。界面显示 dBm 时必须带 `calibration.source` 徽标（09 §7.2；用户 2026-09-05 拍板） |
| `calibration` | `{offset_dB, source ∈ {measured, paper, assumed, model}, note}`：回放数据取自数据索引（公开数据集先按论文参数估算，标 `paper`），合成链取自引擎内部功率约定（标 `model`）；缺失即无此字段 |
| `floor_dB` | 零功率频点的下限（−300 dB），读端据此识别精确零 |
| `state`、`state_reasons` | 四态与原因，取自被观测信号的块元数据；**末行段数不足、末桶样点不足、丢弃尾样点是流结束的自然结果，不降级** |
| `notes` | 说明性备注：`末行只有 m/K 段`、`末桶只有 n/N 个样点`、`收尾丢弃不满一段的 k 个样点` |
| `trace` | 被观测信号的溯源八件套 |
| `producer` | `{component: ObservationTap, version, engine_version}` |

`envelope.index.json` 同上，`kind = envelope`，`row_len = 3`，`columns = [min_abs, max_abs, rms_abs]`（桶内 |x| 的最小、最大、均方根，线性、相对满量程），
`scale = linear_FS`，另有 `bucket_samples`（每桶样点数）与 `last_bucket_samples`（末桶实际样点数）。

写入约定：行定长追加，索引里的 `rows` 最后更新；读端只读 `rows` 以内的行。这样 Windows 上
服务读正在追加的文件也不会读到半行。

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

## 4. 实时推送

运行中的新行经 WebSocket **二进制帧**推送（`docs/api-versions.md` §4）：帧头
`{seq, task_id, op_id, kind, row_index, row_len}` 加 Float32 载荷。浏览器只追加显示不保存；
回看与缩放走第 3 节端点。量级：20 Hz × 1024 bin × 4 B ≈ 80 KB/s。允许丢帧，但必须以
`dropped{from, to}` 告知，`task.state` 与 `error` 事件永不丢。

## 5. 待写

- [ ] 观测点组件 `ObservationTap` 的参数（nfft、窗、桶长）与目录条目（B-3）
- [ ] 抽取端点的测试夹具（B-7）
- [ ] 瀑布瓦片缓存键 `(op_id, t 桶, f 段, px)` 的前端约定（U-3）
