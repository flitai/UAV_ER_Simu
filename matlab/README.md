# matlab 目录

内部工具链：参考模型与 Coder 工程。

## 一条硬边界（03 §11；04 §6.2、§8.5）

MATLAB 只是**内部的模型生产工具**，不是运行时依赖。

- 交付包中不得包含 MATLAB 或其运行时
- 界面上不得出现 MATLAB 的任何痕迹
- 用 Coder 生成的代码产物放到 `models/` 下对应的子目录，并注明来源

## 定位（2026-09-04，D-036）

DSP 类组件（滤波、DDC、信道化）的生产路线是 MATLAB Coder 生成 C 代码；手写 C++ 只用于算术简单件
与引擎骨架。参考模型双轨：MATLAB 工具箱为主参考，Python 参考保留为独立第二实现，黄金向量三方互证。
步骤表见 06 备忘录 §9D（M-0 至 M-5）。开发机 MATLAB R2025a 与工具箱清单、`MATLAB_ROOT` 调用约定
记在 CLAUDE.md「环境与命令」。

计划中的布局：`ref/`（参考模型 `.m`）、`coder/`（`codegen` 脚本与配置）、`golden/`（黄金向量导出）、
`run_all.m`。

## 布局与用法（M-1 落地，M-3 扩到 Coder 与两件 DSP）

```
matlab/
├── ref/       参考模型 .m
│              cuav_welch_power.m         Welch 功率谱，与 pwelch 互证（M-1）
│              cuav_pfb_cycle.m           多相 FFT 换向器一拍（算法核，M-3）
│              cuav_pfb_m{2,4,8,16,32,64}.m   按子信道数钉死 M 的六个入口（codegen 要编译期常量）
│              cuav_rx_fir.m              接收滤波的分块带状态 FIR（算法核，M-3）
├── golden/    黄金向量导出 → engine/tests/golden/*.matlab.json
│              gen_spectrum_golden.m      spectrum_welch.matlab.json（M-1，可选）
│              gen_channelizer_golden.m   channelizer.matlab.json（M-3，**必需**）
│              gen_rx_filter_golden.m     rx_filter.matlab.json（M-3，**必需**）
│              cuav_sha256.m              文件哈希（防陈旧字段用它算）
├── design/    设计校验：check_ddc_fir.m（用 firpm 重设计一遍 DDC 抗混叠低通，与冻结表比对）
├── coder/     Coder 工程与 codegen 脚本：build_coder.m + cuav_banner.cgt（去日期的文件头模板）
├── run_all.m  入口，路径从本文件位置推导
└── run_matlab.sh  MATLAB_ROOT=<安装目录> sh matlab/run_matlab.sh
```

## 三方互证的两个尺度（M-3，D-071）

`Channelizer` / `RxFilter` 的黄金向量分两层，**判据不同、理由不同**：

| 尺度 | 谁与谁 | 判据 | 为什么 |
|---|---|---|---|
| 算法核 | Coder 产物 ↔ MATLAB `.m` ↔ Python 参考，double 进 double 出 | **rel ≤ 1e-9**（06 §9D 的验收判据） | 三方都在双精度上算同一件事 |
| 组件 | 引擎组件 ↔ Python 参考，输出存 `complex64` | rel ≤ 1e-6 | `cuav::Complex` 是 `std::complex<float>`，eps 就是 1.2e-7，套 1e-9 套不上 —— 那不是算法不准，是存储精度的下限 |

**逐位相同不作承诺**（与 M-2 的 DDC 不同）：MATLAB 的 `fft` 走 FFTW、Coder 生成的是自带的基 2 实现、
numpy 走 pocketfft，三家的蝶形次序与旋转因子求值各不相同。实测 Coder 对 MATLAB **1.4e-16**、
MATLAB 对 Python **5.7e-13**、接收滤波三方都在 **1e-15** 以内。

**输入共享比特，不共享公式**：两个 `gen_*_golden.m` 都不自己造输入，一律读
`engine/tests/golden/{channelizer,rx_filter}.json` 里的显式窗口与输入块。M-3 第 5 步踩实过反例 ——
三方各按同一个闭式算输入，编译器把多项式收缩成 FMA，一个样点差一个 ulp，经滤波器的相消放大成 1.5e-9。

**防陈旧**：`.matlab.json` 记着生成那一刻读到的来源 `.m` 与冻结表的 sha256，引擎单测重算一遍比对 ——
改了 `.m` 或改了表却没重跑 MATLAB，当场红（铁律 10）。文件是入库的，所以这条守卫在没有 MATLAB
的机器上照样成立（CI 与 `scripts/build-all.sh` 都不调用 MATLAB）。

## 许可：核实过的事实与用户的澄清（M-2，D-070）

M-2 开工时实跑了一遍 `codegen -config coder.config('lib')`。产物本身是干净的
（无绝对路径、无动态内存），但**每个 `.c` / `.h` 首部都盖着**

> Academic License - for use in teaching, academic research, and meeting course
> requirements at degree granting institutions only. Not for government,
> commercial, or other organizational use.

因为开发机装的是 MATLAB **学术许可**。我据此判断它与 08 报告 §13「产物入库并进交付包」冲突，
M-2 遂以手写 C++ 完成；**当天稍晚用户澄清「本项目属学术用途，学术版许可没有问题」**。

由此定下三件事：

1. **Coder 路线有效，首个使用者是 M-3**（多相 FFT 信道化与接收滤波）。`coder/` 目录随 M-3 重建。
2. **`DDC` 保持手写**不是许可所迫，是工程取舍：算法核（数控振荡 + 抽取型 FIR）约 60 行，
   而封装层按 08 §13 本来就得手写，Coder 省不下多少；且手写版已与独立的 Python 参考**逐位相同**。
3. **一条待核**：产物文件头会带学术许可条款，而本项目文档里写着交付包、甲方数据与 Windows 单机一体化包。
   **若 Coder 产物将来随交付物出去，需按实际用途另行核实**——这不是本目录能决定的事，记在这里备查。

另：DDC 的系数表主设计走 Python（`scripts/design_ddc_fir.py`，`scipy.signal.remez`，BSD），
MATLAB 的 `firpm` 在 `design/check_ddc_fir.m` 作独立校验。这一条**与许可无关**，
是为了让表在没有 MATLAB 的机器上也能复算，同时两家等波纹实现互为佐证——实测吻合 **1.5e-14**。
