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
├── coder/     Coder 工程与 codegen 脚本（M-3 起：信道化与接收滤波）
├── run_all.m  入口，路径从本文件位置推导
└── run_matlab.sh  MATLAB_ROOT=<安装目录> sh matlab/run_matlab.sh
```

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
