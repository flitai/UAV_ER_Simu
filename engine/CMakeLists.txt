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
project(cuav_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
endif()

add_library(cuav_engine STATIC
  src/types.cpp
  src/random.cpp
  src/dsp.cpp
  src/graph.cpp
  src/sources.cpp
  src/processing.cpp
  src/spectrum.cpp
  src/platform.cpp
  src/tap.cpp
  src/registry.cpp
  src/catalog.cpp
  src/diagram_json.cpp
)
target_include_directories(cuav_engine PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

if(MSVC)
  target_compile_options(cuav_engine PRIVATE /W4)
else()
  target_compile_options(cuav_engine PRIVATE -Wall -Wextra)
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
)
target_link_libraries(cuav_engine_tests PRIVATE cuav_engine)
# 黄金基准放源码树里，测试要按源码目录找它，不能依赖运行时工作目录
target_compile_definitions(cuav_engine_tests PRIVATE
  CUAV_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
add_test(NAME cuav_engine_unit COMMAND cuav_engine_tests)
