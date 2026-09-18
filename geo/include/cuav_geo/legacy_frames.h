// 黄金基准回放专用的两套旧投影。**新代码一律不许用**（决策 D-009）。
//
// ---- 为什么这两套并排放在同一个文件里 ----
//
// 本项目从 emcore 移植了两批黄金基准，它们当年是用**两把刻度不同的尺子**量出来的：
//
//   · 测向定位那批（AOA / TDOA / 测向误差，D-053 移植）→ 纬向 111320 m/度
//   · 建筑遮挡那批（148 例 segmentOcclusion，D-074 / D3-3 移植）→ 纬向 110540 m/度
//
// 经向两批都是 111320·cos(参考纬度)，**只有纬向不同**。所以光看函数名里的数字是分不清的
// ——这正是把它们挪到一起的理由：一眼能同时看见两把，拿不错。
//
// **系统实际运行一把都不用**：链路几何、定位求解、将来的遮挡接线，走的都是
// `default_geodesy().to_enu()` 的严格站心地平坐标（铁律 1）。这两套存在的唯一理由是
// 「要听懂当年那两盘录音带，就得用当年那两套播放参数」。
//
// **不许去统一它们**。统一 = 用我们自己的常数重新生成黄金基准 = 把「基准独立于我方代码产生」
// 这个唯一的价值抹掉，正是铁律 10 禁止的事。两者与真值的偏差都量过并留档：
// 遮挡那套在亚运村处纬向偏 −0.445%、经向偏 −0.138%，折到刀口损耗上最大 0.1 dB（07 报告 §6.2）。
// `engine/tests/test_geo.cpp` 有一条用例把这件事钉成断言——谁哪天真去统一了，它当场红。

#ifndef CUAV_GEO_LEGACY_FRAMES_H
#define CUAV_GEO_LEGACY_FRAMES_H

namespace cuav {
namespace geo {
namespace legacy {

// 局部等距圆柱投影的尺度（米/度），锚定参考纬度。
// 用法：x = (lon − ref_lon)·m_per_deg_lon，y = (lat − ref_lat)·m_per_deg_lat。
struct LocalFrame {
    double m_per_deg_lat;
    double m_per_deg_lon;
    LocalFrame() : m_per_deg_lat(0.0), m_per_deg_lon(0.0) {}
};

// 测向定位那批黄金基准的投影：纬向 111320。
// 调用方只有 `legacy::aoa_localization_lonlat()` 与 `engine/tests/test_locate_golden.cpp`。
LocalFrame local_frame_locate(double ref_lat_deg);

// 建筑遮挡那批黄金基准的投影：纬向 **110540**（与上面那把不同，别拿错）。
// 调用方只有 `engine/tests/test_occlusion.cpp`。
LocalFrame local_frame_occlusion(double ref_lat_deg);

}  // namespace legacy
}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_LEGACY_FRAMES_H
