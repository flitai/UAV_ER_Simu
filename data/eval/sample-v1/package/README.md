# 试样集 v1：无人机电子侦察 IQ 数据（10 段 × 1 s）

本数据包是试样集。请先确认三件事：文件读得出来；时频图、频谱、星座等看得惯；字段够用。
确认之后，我方按同一格式生成正式集。

## 首先说明：DJI 图传的数值结构是假定的

DJI 图传（OcuSync / O 系列）的 OFDM 数值结构没有公开资料。本数据里的图传按与 DroneID 同族的「类 LTE」结构生成：
15 kHz 子载波间隔，1024 / 2048 / 4096 点 FFT，循环前缀按 LTE 的比例，子载波上是随机载荷的 16QAM。
这是**假定**，不是厂商资料。占用带宽、突发时长与间隔、占空比取自公开实测数据集的统计（DroneRFb、DroneRFa），
DroneID 的帧结构取自 NDSS 2023 的逆向分析。逐项出处见模型说明（随正式集交付）。

## 目录

| 路径 | 内容 |
|---|---|
| `data/<段>_s3.sigmf-data` / `.sigmf-meta` | S3：ADC 之后的宽带复基带（采样率见「段一览」） |
| `data/<段>_s4.sigmf-data` / `.sigmf-meta` | S4：数字下变频之后、信道化之前（主产品；采样率见「段一览」） |
| `data/<段>_<点>.cuav-links.jsonl` | 该段每条链路的逐帧几何与链路预算（20 Hz 帧，隔帧记录） |
| `previews/<段>_<点>.png` | 峰值保持时频图预览 |
| `examples/read_sigmf.py`、`examples/read_sigmf.m` | 读取示例（Python 只依赖 numpy；MATLAB 只用基础函数） |
| `index.json` | 段一览（机器可读） |
| `SHA512SUMS` | 本包内全部文件的 SHA-512（`shasum -a 512 -c SHA512SUMS`） |

## 段一览

| 段 | 内容 | 接收 | 传播 | 主辐射源信噪比目标 | S3 | S4 |
|---|---|---|---|---|---|---|
| `sv1-s01` | DJI 图传 10 MHz + DroneID，视距 | R1 | 视距 | uav-1 30 dB | 80 MS/s @ 2440 MHz | 20 MS/s @ 2462.5 MHz |
| `sv1-s02` | DJI 图传 20 MHz，视距 | R1 | 视距 | uav-1 30 dB | 80 MS/s @ 2440 MHz | 40 MS/s @ 2460 MHz |
| `sv1-s03` | DJI 遥控上行（2.2 MHz 跳频），视距 | R1 | 视距 | rc-1 30 dB | 80 MS/s @ 2440 MHz | 20 MS/s @ 2440 MHz |
| `sv1-s04` | FrSky D16 v2 遥控（GFSK 跳频），视距 | R1 | 视距 | rc-frsky 30 dB | 80 MS/s @ 2440 MHz | 20 MS/s @ 2440 MHz |
| `sv1-s05` | Futaba S-FHSS 遥控（2-FSK 跳频），视距 | R1 | 视距 | rc-futaba 30 dB | 80 MS/s @ 2440 MHz | 20 MS/s @ 2440 MHz |
| `sv1-s06` | DJI 图传 40 MHz（5.8 GHz）+ DroneID，视距 | R2 | 视距 | uav-1 30 dB | 80 MS/s @ 5790 MHz | 80 MS/s @ 5796.5 MHz |
| `sv1-s07` | 多源：DJI 图传 20 MHz + DroneID + DJI 遥控上行 + FrSky 遥控，视距 | R1 | 视距 | uav-1 20 dB；rc-1 20 dB；rc-frsky 20 dB | 80 MS/s @ 2440 MHz | 40 MS/s @ 2460 MHz |
| `sv1-s08` | 纯背景：只有接收机噪声与非理想 | R1 | 视距 | — | 80 MS/s @ 2440 MHz | 20 MS/s @ 2440 MHz |
| `sv1-s09` | DJI 图传 20 MHz，非视距（楼后低空） | R1 | 非视距 | uav-1 10 dB | 80 MS/s @ 2440 MHz | 40 MS/s @ 2460 MHz |
| `sv1-s10` | DJI 遥控上行（2.2 MHz 跳频），非视距（楼后地面） | R1 | 非视距 | rc-1 10 dB | 80 MS/s @ 2440 MHz | 20 MS/s @ 2440 MHz |

信噪比目标指每个平台主辐射源的**链路预算带内信噪比**（下面「两种信噪比」的第一种）。

## 文件格式

- SigMF 1.2.6。`core:datatype` = `ci16_le`：复 int16，I、Q 交织，小端。
- 换成物理量：x = 码 / 32768 × 10^(`cuav:full_scale_dBm` / 20)，|x|² 的单位是 mW。同一接收配置下所有文件共用一个满量程。
- S3 是 ADC 的输出，无损。S4 是数字下变频的输出，导出时量化了一次；量化噪声比底噪低 20 dB 以上（每个文件的
  `cuav:quality.export_requantization` 记了实际余量）。
- 没有 `core:datetime`：数据是逻辑仿真时间，从 0 s 起，没有绝对时刻。`cuav:time_basis` = `logical_sim`。
- 本方的键在命名空间 `cuav:` 里，`core:extensions` 已声明。

## 真值（annotations）

每条注记是一段发射：一个突发、一个跳频包或一个跳频驻留。

| 键 | 含义 |
|---|---|
| `core:sample_start`、`core:sample_count` | 该段在本文件里的样点起点与样点数 |
| `core:freq_lower_edge`、`core:freq_upper_edge` | 实际载频 ± 占用带宽 / 2（Hz）。实际载频含该辐射源的载频偏差 |
| `core:label` | 信号角色：`video_link`（图传）、`rc_hopping`（遥控跳频）、`droneid`、`cw_beacon` 等 |
| `cuav:emitter_id`、`cuav:equipment_model`、`cuav:preset_id`、`cuav:waveform` | 哪个辐射源、什么设备、哪个机型预设、什么波形 |
| `cuav:capture` | 该段落在本文件**可用频带**（`cuav:usable_band_Hz`）的哪里：`full` 整段在内，`partial` 跨边，`none` 在外 |
| `cuav:in_capture_band` | 该段频带与本文件的采样带宽 ±fs/2 是否相交 |
| `cuav:distance_m`、`cuav:line_of_sight`、`cuav:path_loss_dB`、`cuav:diffraction_dB`、`cuav:doppler_Hz` | 段中点时刻的链路几何（取最近的链路帧，帧时刻在 `cuav:link_frame_t_s`） |
| `cuav:cfo_Hz` | 该段的载频偏差（Hz） |
| `cuav:snr_dB`、`cuav:snr_basis` | 链路预算带内信噪比（见下）及其依据 |
| `cuav:snr_measured_dB`、`cuav:snr_measured_basis` | 在数据上实测的带内信噪比（见下）；算不出时为 null，`basis` 写缘由 |

## 两种信噪比

1. **链路预算**（`cuav:snr_dB`）= P_rx − (kT·F + 10·log10 B)。P_rx = 发射功率 + 两端天线增益 − 路损；kT 取 290 K，
   F 是接收机噪声系数，B 是该段的占用带宽。开了小尺度衰落时，`cuav:snr_basis` = `link_budget_mean`：这是平均值，
   单段的实现值随衰落起伏。
2. **数据实测**（`cuav:snr_measured_dB`）：在该观测点的谱上量。频段取注记的上下沿、两边各加宽 2 个频点；
   信号取该段时间内的谱行，噪声取同一频段上没有任何发射的谱行；信噪比 =（信号 − 噪声）/ 噪声，再换算到占用带宽。
   该段与别的辐射源同时同频（`overlapped:<辐射源>`）、跨可用频带边（`capture_partial`）或在带外（`capture_none`）时为 null。

两者并给，读者可以自己核对。

## 可用频带与跳频段的 S4

`cuav:usable_band_Hz` 是该文件里不混叠、不在滤波器过渡带里的那一段频率。S3 是 ±fs/2；S4 是下变频滤波器的通带
（±0.4 × S4 采样率；不抽取时是 S3 与 S4 两个窗口的交集）。

只有跳频遥控的段，S4 固定取 20 MS/s @ 2440 MHz，所以只有一部分跳频点在 S4 里：

| 段 | 遥控 | S4 里整段在内 / 跨边 / 在外 |
|---|---|---|
| `sv1-s03` | DJI 遥控器（dji-uplink-2m） | 29 / 11 / 137 |
| `sv1-s04` | FrSky X 系列遥控器（frsky-d16v2-fcc） | 33 / 0 / 110 |
| `sv1-s05` | Futaba S-FHSS 遥控器（futaba-sfhss） | 108 / 0 / 187 |
| `sv1-s07` | DJI 遥控器（dji-uplink-2m） | 67 / 5 / 108 |
| `sv1-s07` | FrSky X 系列遥控器（frsky-d16v2-fcc） | 61 / 0 / 82 |
| `sv1-s10` | DJI 遥控器（dji-uplink-2m） | 29 / 17 / 132 |

全部跳频点都在 S3 里。

## 接收机与信道

| 项 | 取值 | 出处 |
|---|---|---|
| 侦察站 | 北京亚运村（116.405°E，39.99°N），天线离地 30 m，全向 3 dBi | 设定 |
| 接收配置 R1 | 80 MS/s @ 2440 MHz（与公开数据集 DroneRFb 相同） | 设定 |
| 接收配置 R2 | 80 MS/s @ 5790 MHz | 设定 |
| 噪声系数、前端增益 | 6 dB、20 dB | 设定（甲方给出接收机指标即替换） |
| ADC | 14 位，满量程 −20 dBm | 设定 |
| 本振相位噪声 | 锁相环单极点：带内 −95 dBc/Hz，转角 100 kHz（均方根相位约 0.57°） | 设定 |
| IQ 不平衡 | 幅度 0.005346 dB，相位 -0.006931° | 实测：DroneRFb 实测样本集里 37 个背景片段的中位数 |
| 直流 | 比噪声低 40.12 dB | 实测：同上 |
| 发射机载频偏差 | 每个平台在 ±20 ppm 内均匀取一个值 | 假定（以 IEEE 802.11 的 ±20 ppm 容差作代理） |
| 视距段的传播 | 自由空间 + 莱斯衰落（K = 9 dB，平坦） | 假定 |
| 非视距段的传播 | 自由空间 + 建筑刀口绕射（OSM 建筑） + 瑞利衰落（平坦） | 建筑来自 OpenStreetMap |
| 平台 | 定点悬停（无人机离地 100 m 或 40 m，遥控器离地 1.5 m） | 设定 |

## 已知限制

- DJI 图传的数值结构是假定（见首页）。
- 载荷是随机比特，没有信道编码，不含任何真实身份信息（DroneID 同样）。
- 单天线、单通道；没有阵列。
- 地面按平地处理（地面高度 0 m），没有地形遮挡。
- 建筑绕射只取侵入最深的一栋楼作单刀口；不计多次绕射与反射。
- 衰落参数（K、时延扩展）与载频偏差的范围是假定，不是实测拟合。
- S4 在导出时量化了一次（S3 无损）。
- Futaba S-FHSS 按开源协议实现生成；公开数据集里的 Futaba 实测数据不是 S-FHSS，二者不可直接比较。
- 纯背景段的场景里有一个全程关断的占位辐射源，链路旁挂文件里有它的几何，注记里没有它。
- 全部量化结论是原型阶段的验证值。

## 读取示例

```
python examples/read_sigmf.py data/sv1-s02_s3 --png s02_s3.png
```

MATLAB：

```
[x, meta] = read_sigmf('data/sv1-s02_s3');
```

（把 `examples/read_sigmf.m` 放在 MATLAB 路径上。）

也可以用 SigMF 官方 Python 包（`pip install sigmf`）读取。
