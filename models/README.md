# models 目录

模型组件。每个子目录对应仿真链条上的一个环节。

| 子目录 | 环节 | 说明 |
|---|---|---|
| `radiator/` | 辐射源 | 波形模板与业务活动、复基带波形生成 |
| `channel/` | 信道 | 时变复信道，把慢变传播参数施加到采样率上 |
| `antenna/` | 天线 | 复增益与极化损耗 |
| `receiver/` | 接收机 | 噪声系数、增益、自动增益控制、阻塞、样本级噪声注入；**接收滤波 `RxFilter`**（M-3，D-071）的模型卡在 `receiver/README.md` §8，冻结系数表 `receiver/fir_rx_v1.json`，Coder 产物 `receiver/coder/` |
| `adc-ddc/` | 模数转换与数字下变频 | 量化、削波、频移、低通、抽取；模型卡 `adc-ddc/README.md`（M-2，D-070），冻结系数表 `adc-ddc/fir_lp_v1.json` |
| `channelizer/` | 信道化 | 宽带 IQ 切分为子带 IQ；多相 FFT 滤波器组 `Channelizer`（M-3，D-071，**首条 Coder 链路**），模型卡 `channelizer/README.md`，冻结原型表 `channelizer/fir_pfb_v1.json`，Coder 产物 `channelizer/coder/` |
| `detection/` | 检测 | 能量检测的滑动噪声估计与突发分段（C-3，D-063）；模型卡在此，代码在引擎 `processing.cpp` |

## 两条边界

1. **参数只在"施加"环节进入 IQ**。M3 组件不得绕过功能级与信号级模型，自行硬编码传播
   参数或噪声参数。
2. **原始 IQ 的处理只由「IQ 观测量提取」组件承担**。概念模型库保持「不生成 IQ」的边界。

## 端口约束（决策 D-013）

连线校验时必须拒绝两类连接：

- `IQStream` 不得与 `SceneParamFrame` 或 `ChannelPathSet` 直接相连，中间必须经过「施加」类
  的 M3 组件
- 信号级裁决组件只接受观测量端口，不接受 `IQStream`

## 实现形态（2026-09-04，D-036）

| 组件 | 形态 | 来源 |
|---|---|---|
| **信道化、接收滤波** | **MATLAB Coder 生成的 C（2026-09-16 落地，D-071）**，放对应子目录的 `coder/`；来源 `.m`、MATLAB 与 Coder 版本、codegen 参数哈希编在 `engine/src/coder_provenance.cpp` 里，由组件的 `source_ref` 给出（08 §13 第 4 条），产物的 sha256 由单测重算核对 | 06 §9D M-3 |
| **DDC** | **手写 C++**：算法核（数控振荡 + 抽取型 FIR）约 60 行，而封装层按 08 §13 本来就得手写，Coder 在这一件上收益很小——工程取舍，不是许可所迫（D-070 ①） | 06 §9D M-2 |
| ADC 量化削波、噪声注入、混合、观测量归约 | 手写 C++ | 引擎 `components/` |
| 场景绑定信道、自由空间信道 | 手写 C++，链接 `geo/` | 06 §9C G-3 |

## 现状（2026-09-16 更新）

代码不在这里：三件手写 C++ 组件（`AntennaGain`、`ReceiverFrontEnd`、`AdcQuantizer`）的实现
在 `engine/src/{antenna,receiver}.cpp`，与其余组件同处一地，因为它们与引擎共用同一套
`IComponent` 生命周期与 `ParamSpec` 描述，拆开放会让构建与头文件路径无谓地复杂。
本目录保留给两类东西：

- **模型卡**：`antenna/README.md`、`receiver/README.md` 已写（C-2，D-051），记依据、参数、
  取值来源与适用范围；`detection/README.md`（C-3）、`recognition/README.md`（C-4）、`locate/README.md`（L 线）、
  `channel/README.md`（R 线）、`evaluation/README.md`（C-5，2026-09-14：真值口径、两张映射表、指标定义、已知边界）随各自组件落地；
  `channelizer/README.md`（M-3，2026-09-16：多相口径、抽头数的两难与解法、两个精度尺度、临界抽取的已知边界）。
- **冻结的模型数据**：`adc-ddc/fir_lp_v1.json`（DDC 抗混叠低通，M-2）、
  `channelizer/fir_pfb_v1.json`（多相原型，M-3）、`receiver/fir_rx_v1.json`（接收滤波，M-3）、
  `recognition/library-v1.json`（模板库）这类随组件走的版本化数据。它们是真理源，
  引擎侧的副本（如 `engine/src/ddc_taps.cpp`）由脚本生成、由单测逐位核对。

- **Coder 产物**：`channelizer/coder/`（25 个文件）与 `receiver/coder/`（11 个文件）**已落地**（M-3，D-071）。
  它们是独立的 C 源码，与手写代码分开存放并带来源头；编进静态库 `cuav_coder`，
  **不按 `-Wall -Wextra` 挑毛病**（生成代码不该按手写代码的标准去挑）。
  `adc-ddc/` 下**不会有** Coder 产物：`DDC` 是手写的（D-070 ①）。
  许可的来龙去脉见 `matlab/README.md`。
