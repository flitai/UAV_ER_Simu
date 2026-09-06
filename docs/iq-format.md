# IQ 数据格式规范

**状态**：第 1、2、6、7 节由上游文档冻结；**第 3、4 节于 2026-09-03 定稿（P1-1 第一批）**，
已由 `tools/iq_convert.py` 与 `tools/iq_survey.py` 实现并在两个公开数据集上跑通；第 5 节
（功率与标定口径）仍被「甲方实测数据尚未提供」阻塞，单列不与其余章节捆绑。

**依据**：`CLAUDE.md` 铁律第 4、7、8、15 条；04 号方案 §5.2、§5.4、§9、§10.6、§12.1、§14。

---

## 1. 适用范围与主产品定义（已冻结）

本系统的主产品是 **S4 观测点的 IQ 数据**，即数字下变频（DDC）之后、信道化之前的宽带
复基带 IQ。本规范约束该产品的存储、交换与元数据。

专业模型组不得自行改变 IQ 的语义。任何"看起来更方便"的语义变更（例如把信道化之后的
子带数据也叫作 S4）都属于违规。

## 2. 采样与频率约束（已冻结）

| 约束 | 内容 | 依据 |
|---|---|---|
| 频率占用 | 频偏绝对值加二分之一带宽再加保护带，必须小于二分之一采样率 | 铁律 4 |
| 抽取 | 抽取之前必须先做抗混叠滤波 | 铁律 4 |
| 常用采样率 | 5 至 50 兆样点每秒 | 04 §12.1 |
| 高采样率 | 100 兆样点每秒仅用于文件兼容与短时间窗，不作为主用工作点 | 04 §12.1 |

## 3. 文件容器与样点编码（2026-09-03 定稿）

### 3.1 容器：裸样点文件加旁挂清单

一个 IQ 数据产物由两个文件组成，同名不同扩展名：

| 文件 | 内容 | 是否入 git |
|---|---|---|
| `<stem>.iq` | 裸样点流，无文件头 | 否（大文件只入索引与元数据） |
| `<stem>.manifest.json` | 旁挂元数据清单，UTF-8，缩进 2 | 是 |

选裸文件而非自带文件头，有三条理由：一是铁律 7 要求大文件分片续传，服务端按 HTTP Range
取任意区间时，样点偏移量到字节偏移量的换算必须是常数乘法，文件头会让每次换算都要先解析；
二是引擎按块流式读取时可直接内存映射；三是与 SigMF 的 `.sigmf-data` 加 `.sigmf-meta` 结构
同构，互转不需要搬运样点。

### 3.2 样点编码

| 项 | 取值 | 说明 |
|---|---|---|
| 交换与保存格式 | 复数 16 位整数交织，标识符 `ci16_le` | 铁律 4 |
| 交织顺序 | `I0 Q0 I1 Q1 …`，每样点 4 字节 | 清单 `sampling.iq_layout` 固定为 `interleaved_IQ` |
| 字节序 | **小端固定** | 清单 `sampling.byte_order` 必须显式写 `little`，读取时校验，不做自动探测 |
| 满量程 | `full_scale = 32768` | 取值范围 −32768 至 32767 |
| 内部计算格式 | 复数 32 位浮点 | 04 §9.1 |
| 高精度标定 | 复数 64 位浮点可选，不作默认 | 04 §9.1 |
| 样点偏移到字节偏移 | `byte = sample × 4` | 无文件头，故为纯乘法 |

**无损性要求**：从浮点源数据转换时，必须先断言每个样点是满量程倒数的整数倍（即源数据
底层本来就是 16 位整数），再写盘，并逐位回读对拍。断言失败时**必须中止转换**，不得四舍
五入蒙混过关——那会静默改变数据，违反铁律 10。若源数据确实是真浮点，另开一条有损转换
路径并在清单里标 `degraded`，本期不实现。

### 3.3 分段与索引

单段上限 **67108864 复样点（256 MiB）**。超过上限的数据切成多段，命名 `<stem>_seg000.iq`、
`_seg001`，依次递增；段内样点连续，段之间在时间上仍然连续（分段是存储行为，不是采集行为，
不得与采集的时间不连续混为一谈，见第 6 节）。

清单的 `segments` 数组记录每段的样点数、起始样点号、字节数与 `sha256`；`identity.content_sha256`
是各段字节流依次拼接后的整体哈希，用于 04 §10.6 第 8 项的重复数据判定。

### 3.4 文件命名

**纯 ASCII，且只允许 `A-Z a-z 0-9 . _ -`**，不含空格（铁律 15）。命名模板：

```
<来源批次>_<源文件标识>_<通道>_<观测点>[_segNNN].iq
例：dronerfa_T0010_D00_S0101_RF0_S4.iq
    dronerfb_train_A1_0007_CH0_S4.iq
```

观测点标识取 04 §5.4 的 `S0` 至 `S6`，主产品一律 `S4`。出包前执行
`scripts/check-ascii.sh <目录>` 验收。

### 3.5 观测点标识（引自 04 §5.4）

| 标识 | 内容 | 默认长期保存 |
|---|---|---|
| `S0` | 辐射源输出复基带 IQ | 否 |
| `S1` | 传播到达接收天线端的 IQ | 否 |
| `S2` | 接收机前端等效输出 | 否 |
| `S3` | ADC 量化后 IQ | 可选 |
| `S4` | **DDC 后、信道化前宽带 IQ（主产品）** | 是 |
| `S5` | 信道化后窄带 IQ | 按任务保存 |
| `S6` | 检测、特征与识别结果 | 是 |

## 4. 元数据清单（2026-09-03 定稿）

### 4.1 顶层结构

清单是一个 JSON 对象，顶层键与 04 §9.2 的十一类最小元数据一一对应，另加三项本项目要求的
扩展：`manifest_version`、`observation_point`、`field_sources`。

| 顶层键 | 对应 04 §9.2 类别 | 必填 |
|---|---|---|
| `manifest_version` | —（本规范版本，当前 `1.0`） | 是 |
| `observation_point` | —（04 §5.4 的 S0–S6） | 是 |
| `identity` | 数据身份 | 是 |
| `sampling` | 采样参数 | 是 |
| `frequency` | 频率参数 | 是 |
| `time` | 时间参数 | 是 |
| `channel` | 通道信息 | 是 |
| `power` | 功率标度 | 是（内容可为「未标定」，但键必须在） |
| `quality` | 质量状态 | 是 |
| `origin` | 来源 | 是 |
| `model_trace` | 模型追溯 | 是 |
| `truth` | 真值 | 否（无真值时置 `null`） |
| `permission` | 权限 | 是 |
| `field_sources` | —（来源标注，见 4.3） | 是 |

### 4.2 字段表

| 路径 | 类型 | 必填 | 取值域与说明 |
|---|---|---|---|
| `identity.data_id` | 字符串 | 是 | 纯 ASCII，全局唯一，通常等于文件 `<stem>` |
| `identity.created_utc` | 字符串 | 是 | ISO 8601，带 `Z` |
| `identity.data_version` | 字符串 | 是 | 语义化版本 |
| `identity.content_sha256` | 字符串 | 是 | 各段字节流拼接后的哈希 |
| `identity.producer` | 字符串 | 是 | 生成工具与版本，如 `tools/iq_convert.py 0.1.0` |
| `sampling.sample_format` | 字符串 | 是 | 固定 `ci16_le` |
| `sampling.sample_rate_Hz` | 数值 | 是 | 大于 0 |
| `sampling.sample_count` | 整数 | 是 | 复样点数，须等于总字节数除以 4 |
| `sampling.byte_order` | 字符串 | 是 | 固定 `little` |
| `sampling.iq_layout` | 字符串 | 是 | 固定 `interleaved_IQ` |
| `sampling.internal_format` | 字符串 | 是 | 固定 `cf32` |
| `frequency.center_frequency_Hz` | 数值 | 是 | 等效射频中心频率 |
| `frequency.effective_bandwidth_Hz` | 数值 | 是 | 有效分析带宽，须**小于等于**采样率（第 2 节约束） |
| `time.start_time` | 字符串或 `null` | 是 | 无绝对时间戳时置 `null`，**不得填占位值** |
| `time.time_basis` | 字符串 | 是 | `logical_sim` / `file_acquisition` / `device_hw` / `external`，四者不得混用（铁律 3） |
| `time.continuity.flag` | 字符串 | 是 | `continuous` / `segmented` / `damaged` / `unknown` |
| `time.continuity.note` | 字符串 | 否 | 例如「每 1000 万点内连续、块间有损伤」 |
| `channel.station_id` | 字符串 | 是 | 无站点概念时填 `unknown` 并在 `field_sources` 标 `absent` |
| `channel.channel_id` | 字符串 | 是 | 如 `RF0` |
| `channel.antenna` | 字符串或 `null` | 是 | 天线说明 |
| `power.scale` | 数值或 `null` | 是 | 量化码到 sqrt(mW) 的换算系数 `10^(full_scale_dBm/20) / 32768`；未标定时 `null`（第 5 节） |
| `power.full_scale` | 数值 | 是 | 固定 32768 |
| `power.gain_dB` | 数值或 `null` | 是 | 接收增益设置 |
| `power.agc` | 字符串 | 是 | `on` / `off` / `unknown` |
| `power.absolute_power` | 字符串 | 是 | `calibrated`（设备标定记录）/ `estimated`（按论文参数或链路预算估算的常数，2026-09-06 增，D-047）/ `uncalibrated` |
| `power.reason` | 字符串 | 否 | `uncalibrated` 与 `estimated` 时必填原因 |
| `power.calibration` | 对象 | `estimated` / `calibrated` 时是 | `{full_scale_dBm, source ∈ {measured, paper, assumed, model}, note, status, estimated_utc, table}`；引擎回放只读前三个键；与 `power.scale` 必须自洽（校验器核对） |
| `quality.status` | 字符串 | 是 | 四态之一（第 7 节） |
| `quality.checks` | 对象 | 是 | 八项质检各自的四态结论，键名见 4.4 |
| `quality.reasons` | 字符串数组 | 是 | 非 `valid` 时不得为空 |
| `origin.kind` | 字符串 | 是 | `measured` / `synthetic` / `mixed` / `derived` |
| `origin.dataset` | 字符串或 `null` | 是 | 数据集名 |
| `origin.doi` | 字符串或 `null` | 否 | |
| `origin.source_file` | 字符串或 `null` | 是 | 源文件名 |
| `origin.source_sha256` | 字符串或 `null` | 否 | 源文件哈希，大文件可省并说明 |
| `origin.conversion` | 对象或 `null` | 是 | 转换工具、参数、无损校验结论 |
| `model_trace.*` | 八项 | 是 | 六件套加 `model_layer`、`credibility`（铁律 8、D-012）。实测数据不经模型产生时，`model_id` 填 `measured:<dataset>`，`model_layer` 填 `M3`，`credibility` 按数据可信度给 |
| `truth` | 对象或 `null` | 是 | 真值索引；**评价可用、不得向被测算法泄漏**（04 §5.2） |
| `permission.owner` | 字符串 | 是 | |
| `permission.usage_scope` | 字符串 | 是 | |
| `permission.classification` | 字符串 | 是 | 未确认时填 `unconfirmed` |
| `permission.export_limit` | 字符串或 `null` | 是 | |

### 4.3 来源标注 `field_sources`

**每一个采集类字段都必须声明它是从哪来的**，理由见第 8 节的反面教材。`field_sources` 是一个
从字段路径到来源枚举的映射：

| 取值 | 含义 |
|---|---|
| `measured` | 设备记录或从数据本身实测得到 |
| `paper` | 来自随附论文或文档转述，**数据文件本身不携带** |
| `derived` | 由其他字段推算 |
| `assumed` | 计算假设，例如把距离区间取中点 |
| `absent` | 源头没有这项信息，字段值是占位 |

凡取值为 `paper`、`assumed`、`absent` 的字段，其影响必须在 `quality.reasons` 里有对应条目。
检验规则：`field_sources` 必须覆盖 `sampling`、`frequency`、`time`、`channel`、`power` 下的
每一个叶子字段，缺一项即判 `degraded`。

### 4.4 八项质检的键名（对应 04 §10.6）

| 键 | 04 §10.6 原文 |
|---|---|
| `length_format_metadata` | 文件长度、格式和元数据一致性 |
| `iq_order_endian_range` | I/Q 顺序、字节序和数值范围 |
| `dc_swap_imbalance` | 直流偏置、IQ 交换和幅相异常 |
| `clip_dropout_zero_gap` | 削顶、过载、丢样、全零和时间空洞 |
| `spectrum_noise_bandwidth` | 频谱占用、噪声底和带宽 |
| `multichannel_alignment` | 多通道样本数和时间对齐 |
| `metadata_required_units` | 元数据必填项、单位和取值范围 |
| `hash_duplicate` | 文件哈希和重复数据 |

每项取四态之一。**单通道数据的第 6 项取 `not_applicable`，不是 `valid`**——「不适用」与
「检查通过」是两回事，混同会让统计失真。整体 `quality.status` 取八项中最差的一档，
次序为 `invalid` < `degraded` < `valid`，`not_applicable` 不参与取最差。

### 4.5 与 SigMF 的对应

本清单与 SigMF 可无损互转，对应关系如下（SigMF 没有的项进 `annotations` 的自定义命名空间
`cuav:`）：

| 本清单 | SigMF |
|---|---|
| `sampling.sample_format` = `ci16_le` | `core:datatype` = `ci16_le` |
| `sampling.sample_rate_Hz` | `core:sample_rate` |
| `frequency.center_frequency_Hz` | `captures[].core:frequency` |
| `time.start_time` | `captures[].core:datetime` |
| `identity.data_id` | `core:description` 或 `cuav:data_id` |
| `identity.content_sha256` | `core:sha512` 的同位物（算法不同，两者都记） |
| 其余各类 | `cuav:` 命名空间 |

## 5. 功率与标定口径（首版 2026-09-06，D-047；常数为原型阶段验证值，甲方数据到货后定稿）

**换算**。引擎内部功率单位是 mW：任一观测点的复样点满足 `|x|² = 功率 / mW`，`10·log10(|x|²)` 直接是
dBm。回放时 `x = code / 32768 × 10^(full_scale_dBm / 20)`，其中 `full_scale_dBm` 是量化码满量程
（|code| = 32768）对应的接收功率，参考面是接收机天线端口（天线增益不计入，它是场景侧的量）。这个常数
就是清单 `power.calibration.full_scale_dBm`，`power.scale` 是它的线性形式。没有常数时只除 32768，
样点是相对满量程的比例（dBFS），块元数据标未标定并降级，观测点索引写 `scale = dBFS`。

**需要的标定量**。设备标定记录（`measured`）应给出：接收增益设置、馈线损耗、以及一次注入已知功率
的满量程标定；缺其一都只能估算。估算的两种方法与取舍规则在 `scripts/ds8_calibration.py` 文件头：
论文法 `P_fs0 − gain_dB`（论文给了增益才可用，且按该常数换算的底噪相对热噪声的等效噪声系数须落在
0–15 dB 内）；链路预算反推 `EIRP + G_rx − FSPL − P_sig_dBFS`（需要距离标注与发射功率假设）。

**两个公开数据集（原型阶段验证值，D-028）**：

| 数据集 | `full_scale_dBm` | 来源 | 依据 | 隐含噪声系数 |
|---|---|---|---|---|
| DroneRFa | −50.0 | `paper` | 论文接收增益 50 dB，满量程 0 dB 增益时 0 dBm（假定）；链路预算法给 −9.8 dBm、差 40 dB，但其隐含噪声系数 41 dB 不合理，故取论文法 | 1.1 dB |
| DroneRFb-DIR | −1.6 | `model` | 论文无增益；10 m 视距自由空间链路预算（EIRP 20 dBm、3 dBi 均为假定）反推，24 片 12 型突发功率中位 −35.6 dBFS | 42 dB（近零增益录制） |

常数表 `data/iq/measured/calibration.json`（含全部输入与推导），落进逐文件清单与批索引 `calibration` 块的命令见
CLAUDE.md「环境与命令」。估算常数的产物 `absolute_power = estimated`、质量四态保持 `degraded`，索引里的谱产品
是 dBm 但溯源里带 `calibration.source`；界面只标 dBm，来源只在开发者模式。

**参与边界**。估算常数的数据可以参与：显示、检测与识别（相对量）、路损指数等相对标定、跨层算例里以比值
或差值表达的项。不得参与：绝对灵敏度与绝对接收功率的验收指标、噪声系数标定、任何写成 dBm 绝对值的交付
数字。这些留给甲方带标定记录的数据。

## 6. 时间基准（已冻结）

逻辑仿真时间、文件采集时间、设备硬件时间、外部统一时间这四重时间不得混用。元数据必须
填写所用的时间基准与连续性标志。失锁、补零、重新对齐之后的数据不得当作连续数据。

## 7. 结果状态四态（已冻结）

`valid`、`degraded`、`invalid`、`not_applicable`。禁止用默认值顶替缺失值。

## 8. 已知的真实样本

在手的真实 IQ 数据集有两个公开数据集，都正好落在 S4 观测点，都是本规范的真实样本，
角色分工见 D-018：

| 数据集 | 内部布局 | 对本规范的意义 |
|---|---|---|
| DroneRFb-DIR | 单通道，`I`、`Q` 两个 float32 数据集，各 1×4000000，80 兆样点每秒 | 第 4 节字段表中 `field_sources` 取 `paper` 的第一个真实案例；八项质检里正交项 `valid` 正例的唯一数据 |
| DroneRFa | 双通道，`RF0_I`/`RF0_Q`/`RF1_I`/`RF1_Q` 四个 float64 数据集，各 1×150000000，100 兆样点每秒 | 逼出「正交幅度不平衡判 `degraded`」这条路径；两种文件名形态与按机型编号判中心频率两个解析分支 |

**两者都是「元数据必须外挂」这条要求的反面教材**：文件内部零元数据，采样率、中心频率、
设备型号只写在随附论文里，一旦数据与论文分离就无法解释。这正是第 4.3 节 `field_sources`
存在的理由。

摸底与路损验证的完整结论见 `WORKLOG.md` 的 2026-09-03 第一、三、四条日志。

## 9. 待写清单

- [x] 第 3 节：容器结构、字节序、分片与索引 —— 2026-09-03 定稿
- [x] 第 4 节：采集类元数据完整字段表 —— 2026-09-03 定稿
- [ ] 第 5 节：功率与标定口径（被甲方数据阻塞，两个公开数据集都无标定常数与馈线损耗）
- [ ] 与 04 §15.2 十二项标准算例的对应关系
- [ ] 分片续传的 HTTP Range 约定（与 `docs/api-versions.md` 一并定；原 P1-5 已于 2026-09-04 撤销，此项改归 P2 分片上传）
- [ ] 模板再生产物的元数据：进 `data/iq/synthetic`（纯合成）或 `data/iq/mixed`（叠了实测背景）时 `origin` 引 `template_id`，`model_trace.trace_id` 带 `template_id`（`docs/emitter-template.md` §7；D-045）
