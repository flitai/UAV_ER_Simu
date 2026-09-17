# GeographicLib（抽取）

WGS-84 坐标基座：大地坐标 ↔ 地心地固 ↔ 站心地平。决策 **D-074**（07 号报告 §3），
步骤 **D3-1**。

## 来源

| 项 | 值 |
|---|---|
| 上游 | GeographicLib，作者 Charles Karney |
| 版本 | **2.5.2**，2025-08-22 发布 |
| 取得方式 | 官方发布的源码包，非仓库检出 |
| 地址 | `https://sourceforge.net/projects/geographiclib/files/distrib-C++/GeographicLib-2.5.2.tar.gz/download` |
| 压缩包字节数 | 1734035 |
| 压缩包 sha256 | `b3b4ce396e541254085ab9ad88dae8ff977145f798d839d5c84676b6acdcc96f` |
| 取得日期 | 2026-09-17 |
| 许可 | MIT，全文见同目录 `LICENSE.txt` |

**为什么是 2.5.2 而不是当时最新的 2.7**：上游的 `NEWS` 记载，**2.4 起要求 C++14、2.6 起要求 C++17**
（2.6 的条目原文：「C++17 is now required. Minimum version of Visual Studio supported is
Visual Studio 15 2017」）。本项目的 C++ 标准是 C++14（与 emcore 兼容；是否提升属未决事项，
要单独拍板，不能为了编过一个第三方件就顺手提）。**2.5.2 是最后一个只要求 C++14 的版本**，
正好卡在本项目的标准上。实测确认：抽取的这个子集在 `-std=c++14 -pedantic-errors -Wall -Wextra`
下零警告编过。2.7 的同一子集在 C++14 下只能靠编译器扩展通过（`Math.hpp` 用了 C++17 的
`inline` 变量），MSVC 严格模式下不可靠，而 Windows 是优先平台（铁律 16）。

## 抽取了什么

只取 `Geocentric`（大地坐标 ↔ 地心地固）与 `LocalCartesian`（地心地固 ↔ 站心地平）
及其最小闭包，**七个文件、78105 字节**：

```
include/GeographicLib/Constants.hpp        上游原件
include/GeographicLib/Geocentric.hpp       上游原件
include/GeographicLib/LocalCartesian.hpp   上游原件
include/GeographicLib/Math.hpp             上游原件
src/Geocentric.cpp                         上游原件
src/LocalCartesian.cpp                     上游原件
src/Math.cpp                               上游原件
include/GeographicLib/Config.h             **本项目手写**，见下
LICENSE.txt                                上游原件
```

七个原件**保留上游文件头、一个字节未改**（铁律 13）。`Config.h` 是唯一的例外：
上游那一份由它自己的 CMake 从 `Config.h.in` 生成，本项目不引上游的 CMake 工程，
所以按抽取需要手写，每一项取值的理由写在文件里。其中一项值得单独说：
**`GEOGRAPHICLIB_HAVE_LONG_DOUBLE` 取 0**，因为 `long double` 在 MSVC 上是 64 位、
在 clang / gcc 的 x86 上是 80 位，双平台交付时这是个跨平台可复现性的口子；
本项目用不到它（`GEOGRAPHICLIB_PRECISION` 取 2 即 double 时它不参与计算），堵死它零代价。

## 没有抽取什么

上游共 53 个源文件、53 个头文件。本项目**不取**其余部分，包括大地线求解（`Geodesic`）、
通用横轴墨卡托与军用格网（`UTMUPS` / `MGRS`）、大地水准面（`Geoid`）、磁场与重力模型、
各类投影、多边形面积。理由：本系统的距离口径是**地心地固弦长**（决策 D-049 第一条），
不需要大地线；坐标交换一律 WGS-84 经纬度（铁律 1），不需要投影。

**唯一一件将来可能要回来取的是 `Geoid`**：高程垂直基准至今是未决事项，若将来要算
大地水准面高（EGM96 / EGM2008），它在上游是现成的。届时按同样方式扩充抽取范围并更新本文件；
注意它还需要额外的格网数据文件，那是一笔离线资产。

## 怎么构建

不引上游的 CMake 工程，三个源文件直接编进 `cuav_geo` 静态库（与 `engine/third_party/` 下
doctest、nlohmann 的做法一致）。构建零网络。

## 复核

重新取一遍并核对：

```
curl -sSL -o GeographicLib-2.5.2.tar.gz \
  "https://sourceforge.net/projects/geographiclib/files/distrib-C++/GeographicLib-2.5.2.tar.gz/download"
shasum -a 256 GeographicLib-2.5.2.tar.gz   # 应为上表的 sha256
```

取源码这一步需要联网，属**建库阶段**动作；交付与运行一律不联网（铁律 6）。

## 与自写实现的关系

`geo/` 里的 `ClosedFormWgs84`（自写 WGS-84 闭式，Bowring 反算）**保留**，降为独立第二实现与
对拍件，不删（D-074）。两家在本项目尺度上的一致性由 `tests/golden/geodesy.json` 钉住。
三家实现（自写、本件、`third_party/foundation` 的 `UtEllipsoidalEarth`）互相差 1e-9 米量级，
**谁也不比谁更准**；引入本件换来的是出处与将来的功能余量，不是精度（07 报告 §3.2）。
