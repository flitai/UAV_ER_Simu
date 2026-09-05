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
build/cuav_run --catalog                                   # 组件目录 JSON
build/cuav_run --validate <框图.json>                       # 只校验，不落盘
build/cuav_run --run <框图.json> --out <目录> [--seed N] [--resolved <旁挂> | --data-index <索引>...]
```

`cuav_run` 的事件与退出码约定见 `docs/api-versions.md` §4.1；逻辑在 `tools/cuav_run/runner.cpp`（静态库 `cuav_runner`），
`main.cpp` 只做 argv。

## 现状（2026-09-05）

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
| `tools/cuav_run/runner.h` | 运行器：`--catalog / --validate / --run`，stdout JSON 事件 `{seq, task_id, type, t_s, payload}` 并镜像 `events.jsonl`，`progress` 按墙钟节流，`product_row` 不带数据，退出码 0–4 | B-4 |
| `cuav/diagram_json.h` | 框图 JSON 装载器：`load_diagram()` 按 `docs/diagram-format.md` 装成 `Graph`、观测点并联、`IDataResolver`（`MapDataResolver` 读解析旁挂 / `IndexDataResolver` 读数据索引）、`DiagramError{code, node_id, port, message}`；只校验模式不落盘 | B-2 |

测试：doctest（`third_party/doctest`，自 emcore 拷入），`tests/` 十个文件 57 个用例，另有三项 `cuav_run` 可执行冒烟（目录、只校验、运行切片 ① 框图）进 ctest；框图夹具 `tests/diagrams/`（切片 ① 示例的逐字副本）；黄金基准
`tests/golden/energy_detector.json` 由 `algos/reference/gen_engine_golden.py` 生成，两侧从同一种子各自生成
输入；`tests/golden/spectrum_welch.json`（Python 端，含 float32 精确输入）与 `spectrum_welch.matlab.json`
（MATLAB `pwelch`）供频谱分析三方互证。JSON 用 `third_party/nlohmann/json.hpp`，构建零网络。

尚未有的：`cuav_run --scenario-track`（G-2）、观测点的 `iq/` 产品、背压与多线程、
共享内存抽象、`SceneParamFrame` 的施加类组件（G-3）、Coder 产物组件（M-2、M-3）。规范见
`docs/{component-catalog,diagram-format,display-products}.md`，步骤见 06 备忘录 §9A。
