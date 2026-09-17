// 建筑遮挡：ITU-R P.526 单刀口衍射（EM-P-04）。
//
// **来源**：自 emcore `include/emcore/models/occlusion.h` + `src/models/occlusion.cpp` 移植
// （D-005 / D-074，D3-3），祖本 em-demo `src/models/occlusion.ts` 的 segmentOcclusion。
// **黄金基准**：`tests/golden/occlusion.json`，148 例，相对误差 ≤ 1e-9。
//
// 物理与地图解耦：本文件只做刀口衍射物理，桶网格与线段几何全在 cuav_geo/map.h 的适配器里
// （05 §3.1）。输出恒为**单程**刀口衍射损耗——掠射约 6 dB、深阴影几十 dB，
// 由调用方注入链路预算。**单向链路取 ×1，不乘 2**：emcore 的原注写着「雷达双程 ×2、
// 单向链路 ×1」，本系统是电子侦察单向链路，这是从雷达代码移植过来时最容易顺手抄错的地方。

#ifndef CUAV_GEO_OCCLUSION_H
#define CUAV_GEO_OCCLUSION_H

#include "cuav_geo/map.h"

namespace cuav {
namespace geo {

struct OcclusionResult {
    double obstruction_loss_dB;   // 单程刀口衍射损耗。无遮挡为 0
    double intrusion_m;           // 视线侵入建筑的竖直深度，仅信息性
    bool blocked;                 // 视线在几何上有没有被楼切断

    OcclusionResult() : obstruction_loss_dB(0.0), intrusion_m(0.0), blocked(false) {}
};

// tx → rx 视线被建筑切断时的刀口衍射损耗。两个端点都是**平面米**（投影由调用方做，
// 见 map.h 头注）。没有建筑或未命中时优雅降级返回全 0。
//
// frequency_Hz：衍射的 Fresnel 参数依赖波长，电子侦察取发射频率。
OcclusionResult segment_occlusion(const IMapQuery& map, const MapPoint& tx, const MapPoint& rx,
                                  double frequency_Hz);

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_OCCLUSION_H
