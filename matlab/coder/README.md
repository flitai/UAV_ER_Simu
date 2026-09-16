# matlab/coder

MATLAB Coder 的生成脚本。**本目录不进交付包**，生成出来的 C 才进（`models/<环节>/coder/`）。
D-036 定的路线、D-070 ② 定的首个使用者是 M-3，08 报告 §13 是规范。

```
matlab/ref/cuav_pfb_cycle.m + cuav_pfb_m{2,4,8,16,32,64}.m   算法核（%#codegen）
matlab/ref/cuav_rx_fir.m
        ↓  MATLAB_ROOT=<安装目录> sh matlab/run_matlab.sh   （走 run_all.m）
models/channelizer/coder/*.{c,h}      六个入口 + rtwtypes.h
models/receiver/coder/*.{c,h}         一个入口 + rtwtypes.h
        ↓  uv run --quiet python scripts/gen_coder_provenance.py
engine/src/coder_provenance.cpp       溯源串，编译进目录（source_ref 必填，catalog.cpp:65-69）
```

## 三处非缺省的 codegen 配置，每一处都有理由

| 配置 | 值 | 为什么 |
|---|---|---|
| `CodeTemplate` | `cuav_banner.cgt` | 默认模板往每个文件头写一行生成时间戳，**入库后每次重生成都 diff**，读起来像一次基准变更（铁律 10）。本模板照抄默认模板、只删掉 `%<SourceGeneratedOn>` 一行。去掉之后连跑两次 codegen，产物**逐字节相同**——实测过 |
| `HardwareImplementation.ProdHWDeviceType` | `Generic->Custom` | 缺省的 `Generic->MATLAB Host Computer` 生成的 `rtwtypes.h` 会 `#include "tmwtypes.h"`，那是 MATLAB 安装目录里的文件 —— **入库产物会依赖 MATLAB，换台机器就编不过**。换成自定义硬件后 `rtwtypes.h` 自足。位宽里 `long` **故意取 32**：于是 `int64_T` 由 `long long` 定义，在 Windows 的 LLP64 与 Linux/macOS 的 LP64 上都是 64 位，三平台共用同一份头（铁律 16） |
| `UseBuiltinFFTWLibrary` | `false` | 显式设，不吃缺省值。为真会让 `fft`/`ifft` 去链 FFTW；为假则 Coder 生成自带的基 2 实现，旋转因子常量折叠，产物自足、不引第三方（铁律 6） |

其余：`GenCodeOnly` 只出源码不调本机编译器；`FilePartitionMethod = 'MapMFileToCFile'` 一文件一入口（`SingleFile` 会把六个 M 全塞进以第一个入口命名的那个 .c，名不副实）；`EnableVariableSizing = false` + `EnableDynamicMemoryAllocation = false`
使接口全定长、无 `emxArray`、无 `malloc`（08 §13 第 3 条）；`SupportNonFinite = false` 省掉四个
`rt_nonfinite` 文件；`InstructionSetExtensions = 'None'` 使生成的 C 不含 SSE/AVX intrinsic，三平台同源。

## 两处用法陷阱

- `cfg.CodeTemplate` 要 `coder.MATLABCodeTemplate` **对象**，给路径字符串会报
  「must be scalar or empty of class 'coder.MATLABCodeTemplate'」。
- `codegen -d outd` 的**命令形式**把 `outd` 当字面目录名。要传变量必须用函数式
  `codegen('-config', cfg, ..., '-d', outd)`。

## 入库哪些、不入库哪些

入库：`<入口>.c`、`<入口>.h`、`<入口>_types.h`、`rtwtypes.h`。
不入库：`interface/`（MEX 胶水）、`buildInfo.mat`、`codeInfo.mat`、`compileInfo.mat`、
`codedescriptor.dmr`、`*_rtw.mk`、`rtw_proj.tmw`、`_clang-format`
—— `.mat` 与 `.mk` 里带绝对路径，入库会被 `scripts/check-paths.sh` 拦下（也应该被拦下）。
暂存目录 `matlab/coder/_staging/` 已进 `.gitignore`。

`_initialize` / `_terminate` **不是独立文件**（`FilePartitionMethod = 'SingleFile'`）：
声明在 `.h`、空定义在同一个 `.c` 里。封装层照常调 `_initialize` 一次。

## 许可

产物文件头带「Academic License — … Not for government, commercial, or other organizational use.」，
因为开发机是 MATLAB 学术许可。用户 2026-09-16 澄清**本项目属学术用途，据此可用**（D-070）。
**留一条待核**：产物若随交付物出去，需按实际用途另行核实。来龙去脉见 `matlab/README.md`。
