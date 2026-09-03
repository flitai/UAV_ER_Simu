# 分块流 IQ 引擎与组件 SDK
#
# 依据：CLAUDE.md「环境与命令」一节；04 号方案 §6.3；06 备忘录 §2 步骤 S-6。
# C++ 标准定为 C++14，与 emcore 保持兼容。是否提升标准属未决事项。
#
# 双平台构建：Windows x64 与 Linux x64 从第一天起都进持续集成（决策 D-015、D-016）。
# 开发机是 macOS，其构建结果不作为验收依据。
# 不得直接调用平台私有接口；共享内存、内存映射、路径与编码一律经抽象层。

cmake_minimum_required(VERSION 3.16)
project(cuav_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
endif()

add_library(cuav_engine STATIC
  src/placeholder.cpp
)
target_include_directories(cuav_engine PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

enable_testing()
add_executable(cuav_engine_smoke_test tests/smoke_test.cpp)
target_link_libraries(cuav_engine_smoke_test PRIVATE cuav_engine)
add_test(NAME cuav_engine_smoke COMMAND cuav_engine_smoke_test)
