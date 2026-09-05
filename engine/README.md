# engine 目录

C++ 分块流 IQ 引擎与组件软件开发包。

| 项 | 值 | 依据 |
|---|---|---|
| 架构 | 分块流加有向无环图调度，同进程或共享内存 | 04 §6.3、§8.3 |
| C++ 标准 | C++14 起，与 emcore 兼容。是否提升属未决事项 | CLAUDE.md |
| CMake | 3.16 及以上 | 同上 |
| 平台 | Windows x64 与 Linux x64 都进持续集成；macOS 仅开发，结果不作验收依据 | 决策 D-015、D-016 |

不得直接调用平台私有接口。共享内存、内存映射、路径与编码一律经过抽象层。

## 命令

```
cmake -S . -B build && cmake --build build && ctest --test-dir build --output-on-failure
```

## 现状（2026-09-04）

| 头文件 | 内容 | 落地步骤 |
|---|---|---|
| `cuav/types.h` | 样点块、端口类型与 `can_connect()`、结果四态、溯源八件套、`SceneParamFrame` | P1-2 |
| `cuav/component.h` | `IComponent`（configure / init / process / flush / reset / status / describe）、`ComponentInfo`、六类类别常量 | P1-2、B-1 |
| `cuav/param_spec.h` | `ParamSpec` 参数描述与链式构造 | B-1 |
| `cuav/registry.h` | `Registry` 按名构造、`validate_params()`、`builtin_registry()` | B-1 |
| `cuav/catalog.h` | `catalog_json()` 组件目录导出（`cuav-catalog/1`）、`validate_catalog_entry()` | B-1 |
| `cuav/graph.h` | 有向无环图、连线校验（D-013）、拓扑排序、单线程调度 | P1-2 |
| `cuav/random.h`、`cuav/dsp.h` | xoshiro256++ 显式注入、基 2 FFT、正则化不完全伽马、门限求解 | P1-2 |
| `cuav/components/sources.h` | `ToneSource`、`NoiseSource`、`FileReplaySource` | P1-3 |
| `cuav/components/processing.h` | `AddMixer`、`EnergyDetector`、`DetectionSink` | P1-3 |
| `cuav/components/spectrum.h` | `WelchAccumulator`、`SpectrumAnalyzer`（Welch 功率谱 dBFS，double FFT） | P1-4a |
| `cuav/components/tap.h` | `ObservationTap`：谱行与包络行定长二进制加索引，回调观察者 | B-3 |
| `cuav/observer.h` | `IRunObserver`、`ProgressInfo`、`EntityState`、`LinkFrame` | B-3 |
| `cuav/platform.h` | 目录、原子替换、字节序、路径拼接；唯一允许出现 `#ifdef _WIN32` 的模块 | B-3 |

测试：doctest（`third_party/doctest`，自 emcore 拷入），`tests/` 七个文件 37 个用例；黄金基准
`tests/golden/energy_detector.json` 由 `algos/reference/gen_engine_golden.py` 生成，两侧从同一种子各自生成
输入；`tests/golden/spectrum_welch.json`（Python 端，含 float32 精确输入）与 `spectrum_welch.matlab.json`
（MATLAB `pwelch`）供频谱分析三方互证。JSON 用 `third_party/nlohmann/json.hpp`，构建零网络。

尚未有的：可执行入口 `cuav_run`（B-4）、框图 JSON 装载器（B-2）、观测点的 `iq/` 产品、背压与多线程、
共享内存抽象、`SceneParamFrame` 的施加类组件（G-3）、Coder 产物组件（M-2、M-3）。规范见
`docs/{component-catalog,diagram-format,display-products}.md`，步骤见 06 备忘录 §9A。
