# 地理计算：地图查询接口、场景适配器、刀口衍射遮挡
#
# 依据：CLAUDE.md「环境与命令」一节；04 号方案 §6.3；06 备忘录 §2 步骤 S-6。
# C++ 标准定为 C++14，与 emcore 保持兼容。是否提升标准属未决事项。
#
# 双平台构建：Windows x64 与 Linux x64 从第一天起都进持续集成（决策 D-015、D-016）。
# 开发机是 macOS，其构建结果不作为验收依据。
# 不得直接调用平台私有接口；共享内存、内存映射、路径与编码一律经抽象层。

cmake_minimum_required(VERSION 3.16)
project(cuav_geo LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
endif()

# 坐标基座 vendored GeographicLib 2.5.2（决策 D-074，步骤 D3-1）。
# 只抽 Geocentric 与 LocalCartesian 及其最小闭包，七个文件；来源、版本、压缩包哈希与
# 「为什么不是最新的 2.7」见 third_party/geographiclib/README.md。
# 不引上游的 CMake 工程，三个源文件直接编进本静态库（同 engine/third_party/ 的做法），构建零网络。
set(CUAV_GEOGRAPHICLIB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/geographiclib)

add_library(cuav_geo STATIC
  ${CUAV_GEOGRAPHICLIB_DIR}/src/Geocentric.cpp
  ${CUAV_GEOGRAPHICLIB_DIR}/src/LocalCartesian.cpp
  ${CUAV_GEOGRAPHICLIB_DIR}/src/Math.cpp
  src/geodesy.cpp
  src/local_scene_adapter.cpp
  src/occlusion.cpp
  src/kinematics.cpp
  src/link_budget.cpp
  src/propagation.cpp
  src/scenario.cpp
  src/activity.cpp
  src/df_error.cpp
  src/fix_geometry.cpp
  src/locate_aoa.cpp
  src/locate_tdoa.cpp
)
target_include_directories(cuav_geo PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
# 第三方头只给本库自己用（PRIVATE）：GeographicLib 不出现在 cuav_geo 的公开头里，
# 引擎与调用方对它无感。
target_include_directories(cuav_geo PRIVATE ${CUAV_GEOGRAPHICLIB_DIR}/include)

# 本项目自己的源文件按 -Wall -Wextra 挑；第三方源文件不按本项目的标准去挑
# （同 engine/ 对 Coder 产物的处置，D-071）。GeographicLib 2.5.2 实测在
# -std=c++14 -pedantic-errors -Wall -Wextra 下零警告，这里设 PRIVATE 只是不把
# 将来上游升版带来的警告变成本项目的噪声。
if(MSVC)
  target_compile_options(cuav_geo PRIVATE /W4)
  set_source_files_properties(
    ${CUAV_GEOGRAPHICLIB_DIR}/src/Geocentric.cpp
    ${CUAV_GEOGRAPHICLIB_DIR}/src/LocalCartesian.cpp
    ${CUAV_GEOGRAPHICLIB_DIR}/src/Math.cpp
    PROPERTIES COMPILE_OPTIONS "/W1")
else()
  target_compile_options(cuav_geo PRIVATE -Wall -Wextra)
  set_source_files_properties(
    ${CUAV_GEOGRAPHICLIB_DIR}/src/Geocentric.cpp
    ${CUAV_GEOGRAPHICLIB_DIR}/src/LocalCartesian.cpp
    ${CUAV_GEOGRAPHICLIB_DIR}/src/Math.cpp
    PROPERTIES COMPILE_OPTIONS "-w")
endif()

enable_testing()
add_executable(cuav_geo_smoke_test tests/smoke_test.cpp)
target_link_libraries(cuav_geo_smoke_test PRIVATE cuav_geo)
# 冒烟测试要直接拿 LocalCartesian 来验「站心旋转各家一样」这句话，并生成 tests/golden/geodesy.json，
# 所以它（且只有它）需要第三方头。库的公开头里仍然没有 GeographicLib。
target_include_directories(cuav_geo_smoke_test PRIVATE ${CUAV_GEOGRAPHICLIB_DIR}/include)
add_test(NAME cuav_geo_smoke COMMAND cuav_geo_smoke_test)
