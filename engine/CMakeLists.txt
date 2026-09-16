# 分块流 IQ 引擎与组件 SDK
#
# 依据：CLAUDE.md「环境与命令」一节；04 号方案 §6.3、§8.3；06 备忘录 §9 P1-2。
# C++ 标准定为 C++14，与 emcore 保持兼容。是否提升标准属未决事项。
#
# 双平台构建：Windows x64 与 Linux x64 从第一天起都进持续集成（决策 D-015、D-016）。
# 开发机是 macOS，其构建结果不作为验收依据。
# 不得直接调用平台私有接口；共享内存、内存映射、路径与编码一律经抽象层。
#
# 第三方件全部 vendored，构建零网络：doctest 与 nlohmann/json 自 emcore 拷入，
# 保留原文件头（CLAUDE.md 铁律 13）。

cmake_minimum_required(VERSION 3.16)
project(cuav_engine LANGUAGES C CXX)

# C 语言是 M-3 引入的：MATLAB Coder 的产物是 C99（08 报告 §13 规定 TargetLang = 'C'）。
# 它们编进独立的静态库 cuav_coder，与手写代码分开——生成物里的告警不可行动，
# 不该跟着引擎吃 -Wall -Wextra / W4。
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
endif()

# 场景运行时的运动学与链路预算在 cuav_geo（决策 D-033）：引擎侧的 ScenarioSource 只作薄封装。
# 源在树外，add_subdirectory 必须显式给二进制目录。geo 也可独立构建（scripts/build-all.sh 各建一次）。
if(NOT TARGET cuav_geo)
  add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../geo ${CMAKE_CURRENT_BINARY_DIR}/geo)
endif()

# --- MATLAB Coder 产物（M-3，D-071）------------------------------------------
#
# 三层分工见 08 报告 §13：matlab/ref/*.m 是算法核的来源，这里编的是 Coder 生成的 C，
# 封装层（参数校验、样点序号换算与群时延扣除、状态持有、溯源、四态传播）是
# engine/src/{channelizer,rx_filter}.cpp，手写。
#
# 产物在树外（models/<环节>/coder/），路径从 CMAKE_CURRENT_SOURCE_DIR 推导（铁律 17）。
# 两个目录各有一份 rtwtypes.h，内容逐字节相同（同一套硬件配置），各自自足；
# 每个 .c 用 #include "..." 找同目录那一份，所以同名不成问题。
set(CUAV_CODER_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../models)
file(GLOB CUAV_CODER_SRC
  ${CUAV_CODER_ROOT}/channelizer/coder/*.c
  ${CUAV_CODER_ROOT}/receiver/coder/*.c)
add_library(cuav_coder STATIC ${CUAV_CODER_SRC})
target_include_directories(cuav_coder PUBLIC
  ${CUAV_CODER_ROOT}/channelizer/coder
  ${CUAV_CODER_ROOT}/receiver/coder)
# 刻意不给它 -Wall -Wextra / /W4：生成代码的告警改不得也不该改。
# 真正要守的是「产物没被人动过」，那由 engine/tests/test_coder_provenance.cpp 的 sha256 兜住。

add_library(cuav_engine STATIC
  src/types.cpp
  src/random.cpp
  src/dsp.cpp
  src/ddc_taps.cpp
  src/pfb_taps.cpp
  src/rx_taps.cpp
  src/coder_provenance.cpp
  src/ddc.cpp
  src/graph.cpp
  src/sources.cpp
  src/processing.cpp
  src/recognition.cpp
  src/evaluation.cpp
  src/evaluator.cpp
  src/locate.cpp
  src/spectrum.cpp
  src/platform.cpp
  src/tap.cpp
  src/registry.cpp
  src/catalog.cpp
  src/diagram_json.cpp
  src/sha256.cpp
  src/scenario_json.cpp
  src/scenario.cpp
  src/channel.cpp
  src/antenna.cpp
  src/receiver.cpp
)
target_include_directories(cuav_engine PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
target_link_libraries(cuav_engine PUBLIC cuav_geo cuav_coder)

if(MSVC)
  target_compile_options(cuav_engine PRIVATE /W4)
else()
  target_compile_options(cuav_engine PRIVATE -Wall -Wextra)
endif()

# 运行器（B-4，D-031）：逻辑在静态库 cuav_runner 里，可执行入口只做 argv；测试直接驱动库检查事件流
add_library(cuav_runner STATIC tools/cuav_run/runner.cpp)
target_link_libraries(cuav_runner PUBLIC cuav_engine)
target_include_directories(cuav_runner PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/tools/cuav_run)
add_executable(cuav_run tools/cuav_run/main.cpp)
target_link_libraries(cuav_run PRIVATE cuav_runner)
if(MSVC)
  target_compile_options(cuav_runner PRIVATE /W4)
  target_compile_options(cuav_run PRIVATE /W4)
else()
  target_compile_options(cuav_runner PRIVATE -Wall -Wextra)
  target_compile_options(cuav_run PRIVATE -Wall -Wextra)
endif()

enable_testing()

add_executable(cuav_engine_tests
  tests/test_main.cpp
  tests/test_types_graph.cpp
  tests/test_dsp_random.cpp
  tests/test_components.cpp
  tests/test_golden.cpp
  tests/test_registry.cpp
  tests/test_spectrum.cpp
  tests/test_tap.cpp
  tests/test_diagram_json.cpp
  tests/test_runner.cpp
  tests/test_catalog_golden.cpp
  tests/test_geo.cpp
  tests/test_propagation.cpp
  tests/test_scenario.cpp
  tests/test_channel.cpp
  tests/test_ddc.cpp
  tests/test_channelizer.cpp
  tests/test_rx_filter.cpp
  tests/test_coder_provenance.cpp
  tests/test_locate.cpp
  tests/test_locate_golden.cpp
  tests/test_receiver_chain.cpp
  tests/test_recognition_chain.cpp
  tests/test_evaluation.cpp
  tests/test_evaluator.cpp
)
target_link_libraries(cuav_engine_tests PRIVATE cuav_runner)
# 黄金基准放源码树里，测试要按源码目录找它，不能依赖运行时工作目录
target_compile_definitions(cuav_engine_tests PRIVATE
  CUAV_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
add_test(NAME cuav_engine_unit COMMAND cuav_engine_tests)

# 可执行文件的冒烟：目录、只校验、运行切片 ① 框图（产品写到构建目录）
add_test(NAME cuav_run_catalog COMMAND cuav_run --catalog)
add_test(NAME cuav_run_validate_slice1
  COMMAND cuav_run --validate "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice1_tone_noise_psd.json")
add_test(NAME cuav_run_run_slice1
  COMMAND cuav_run --run "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice1_tone_noise_psd.json"
          --out "${CMAKE_CURRENT_BINARY_DIR}/runs/slice1" --seed 20260904)

# 切片 ② 的场景绑定链路：航迹预览、只校验、运行（产品与 track/links 写到构建目录）
add_test(NAME cuav_run_scenario_track
  COMMAND cuav_run --scenario-track
          "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json"
          --track-rate 2 --scene-root "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene")
add_test(NAME cuav_run_validate_slice4_detect
  COMMAND cuav_run --validate "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice4_detect.json")
add_test(NAME cuav_run_validate_slice4_feature
  COMMAND cuav_run --validate "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice4_feature.json")
add_test(NAME cuav_run_validate_slice4_recognize
  COMMAND cuav_run --validate "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice4_recognize.json"
          --library-root "${CMAKE_CURRENT_SOURCE_DIR}/../models/recognition")
add_test(NAME cuav_run_validate_slice4_evaluate
  COMMAND cuav_run --validate "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice4_evaluate.json"
          --library-root "${CMAKE_CURRENT_SOURCE_DIR}/../models/recognition")
# C-5：缺省典型链路（demo-01）加绑站的评价器，跑 6 s，产品目录里应有 truth.jsonl 与 metrics.json
add_test(NAME cuav_run_run_slice4_evaluate_scene
  COMMAND cuav_run --run "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice4_evaluate_scene.json"
          --out "${CMAKE_CURRENT_BINARY_DIR}/runs/slice4-evaluate-scene"
          --scenario "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json"
          --scene-root "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene"
          --library-root "${CMAKE_CURRENT_SOURCE_DIR}/../models/recognition")
# M-2（D-070）：宽带链启用 DDC —— 10 MS/s 选出 2438.5 MHz 的图传、抽取 2 倍到 5 MS/s
add_test(NAME cuav_run_validate_demo02_ddc
  COMMAND cuav_run --validate "${CMAKE_CURRENT_SOURCE_DIR}/../tests/regression/diagrams/chain-demo-02-ddc.json"
          --scenario "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene/beijing-yayuncun/scenarios/demo-02.scenario.json"
          --scene-root "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene"
          --library-root "${CMAKE_CURRENT_SOURCE_DIR}/../models/recognition")
add_test(NAME cuav_run_validate_slice2
  COMMAND cuav_run --validate "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice2_scenario_link.json"
          --scenario "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json"
          --scene-root "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene")
add_test(NAME cuav_run_run_slice2
  COMMAND cuav_run --run "${CMAKE_CURRENT_SOURCE_DIR}/tests/diagrams/slice2_scenario_link.json"
          --out "${CMAKE_CURRENT_BINARY_DIR}/runs/slice2"
          --scenario "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json"
          --scene-root "${CMAKE_CURRENT_SOURCE_DIR}/../data/scene")
