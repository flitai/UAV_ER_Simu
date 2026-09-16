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

## 布局与用法（M-1 已落地，2026-09-05）

```
matlab/
├── ref/       参考模型 .m：cuav_welch_power.m（Welch 功率谱，与 pwelch 互证）
├── golden/    黄金向量导出：gen_spectrum_golden.m → engine/tests/golden/spectrum_welch.matlab.json
├── design/    设计校验：check_ddc_fir.m（用 firpm 重设计一遍 DDC 抗混叠低通，与冻结表比对）
├── run_all.m  入口，路径从本文件位置推导
└── run_matlab.sh  MATLAB_ROOT=<安装目录> sh matlab/run_matlab.sh
```

## 许可：为什么这里没有 Coder 产物（M-2，D-070）

原计划（D-036）是 DSP 件走 MATLAB Coder 生成 C 入库。M-2 开工时实跑了一遍
`codegen -config coder.config('lib')`：产物本身是干净的（无绝对路径、无动态内存），
但**每个 `.c` / `.h` 首部都盖着**

> Academic License - for use in teaching, academic research, and meeting course
> requirements at degree granting institutions only. Not for government,
> commercial, or other organizational use.

而 08 报告 §13 要求产物入库并进交付包。用户 2026-09-16 据此拍板：**放弃 Coder，DSP 件改手写 C++**，
MATLAB 降为内部的设计与校验工具。`coder/` 目录随之撤掉。

由此还有一条更细的考虑：用学术许可的 MATLAB 为交付件**设计**滤波器，严格说也在该许可的用途
范围之外，即使输出只是一串数。所以 DDC 的系数表主设计走 Python
（`scripts/design_ddc_fir.py`，`scipy.signal.remez`，BSD 许可，任何机器都可复算），
MATLAB 只在 `design/check_ddc_fir.m` 里独立重设计一遍作校验。
实测两家吻合到 **1.5e-14**，指标（阻带 ≥ 60 dB、通带纹波、奇数抽头）逐档达标。

黄金向量的输入由 Python 端 `algos/reference/gen_spectrum_golden.py` 写成 JSON（float32 精确值），MATLAB 只读不改写：
`jsonencode` 只保留 15 位有效数字，会破坏原文件里的精确十进制表示，所以 MATLAB 一方的结果写到同目录的
`*.matlab.json`。已知的坑：`pwelch` 的 `'centered'` 对偶数 nfft 与 `fftshift` 差一格，一律用 `'twosided'` 再 `fftshift`。
