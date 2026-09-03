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

## 现状

`foundation/` 为空，尚未引入。
