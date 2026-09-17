# third_party 目录

第三方代码。每个子目录必须说明来源、许可与授权情况。

## foundation

从 AFSIM 2.9 抽取的基础库，已获授权可以随代码提供（决策 D-004）。

| 项 | 情况 |
|---|---|
| 内容 | 数学 347 个文件、输入输出 151 个、序列化 22 个 |
| 可用的部分 | 椭球地球坐标换算（WGS-84 经纬高与地心地固、站心坐标互转，通用横轴墨卡托，Vincenty）、球面地球的地平线遮挡判断、坐标类、协方差类、方位俯仰表、网格求交、空间树 |
| **没有的部分** | **没有建筑遮挡库**。建筑遮挡走 `geo/`，从 emcore 移植 |
| 已知缺陷 | 不能独立构建：没有顶层 CMakeLists，134 个头文件引用了缺失的 `ModelApi.hpp` 与 `MODEL_API` 宏 |
| 实际的构建目标名 | `model_math`、`model_io`、`model_serialization`。其 README 所写的 `model_foundation_*` 与实际不符，以实际为准 |
| 测试 | 零单元测试 |

引入时必须补 `ModelApi.hpp` 与顶层 CMakeLists，并**保留全部原始文件头**。

## geographiclib

GeographicLib 2.5.2 的抽取，MIT 许可，本项目的 **WGS-84 坐标基座**（决策 D-074，步骤 D3-1）。

| 项 | 情况 |
|---|---|
| 内容 | 只取 `Geocentric`（大地坐标 ↔ 地心地固）与 `LocalCartesian`（地心地固 ↔ 站心地平）及其最小闭包，**七个文件 78105 字节** |
| 版本 | 2.5.2，不是更新的 2.7——上游自 2.6 起要求 C++17，本项目是 C++14，2.5.2 是最后一个只要求 C++14 的版本 |
| 构建 | 不引上游 CMake，三个源文件直接编进 `cuav_geo`；第三方头是 PRIVATE 的，不出现在 `cuav_geo` 的公开头里；零网络 |
| 唯一的非原件 | `include/GeographicLib/Config.h` 由本项目手写（上游那份由它自己的 CMake 生成），每项取值的理由写在文件里；其余七件保留上游文件头、一字节未改 |
| 没有取的部分 | 大地线求解、投影、通用横轴墨卡托与军用格网、大地水准面、磁场与重力模型。将来若为垂直基准启用 `Geoid`，按同法扩充并更新说明 |
| 与自写实现的关系 | `geo/` 的 `ClosedFormWgs84` **保留**作独立第二实现与对拍件；两家一致性由 `tests/golden/geodesy.json` 的 210 例钉住（实测最差 1.7e-9 米） |

来源、压缩包 sha256 与复核命令见 `geographiclib/README.md`。

## 现状

`foundation/` 为空，尚未引入。
