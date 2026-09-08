// 链路预算：自由空间路损、多普勒、时延、热噪声底、视线角。
//
// 依据：docs/scenario-format.md §7（从场景到参数帧的契约）；概念模型 EM-P-01（自由空间传播）；
// CLAUDE.md 铁律 5（SI 单位，dB 域与线性域不混算）、铁律 2（平地假设）、铁律 15（不静默降级）、
// 决策 D-009（c = 299792458）。
//
// 首期只有自由空间：line_of_sight 在显式平地假设下恒真，extra_loss_dB 恒 0。
// D3（切片 ⑤）接入建筑遮挡后只改 extra_loss_dB 与 line_of_sight 两处，帧结构与本接口不变。

#ifndef CUAV_GEO_LINK_BUDGET_H
#define CUAV_GEO_LINK_BUDGET_H

#include <string>

#include "cuav_geo/geodesy.h"

namespace cuav {
namespace geo {

// EM-P-01：L = 20·log10(4π·d/λ)，λ = c/f。d ≤ 0 或 f ≤ 0 时返回 0 且由调用方按 valid 判断，
// 不在这里静默给一个"看着合理"的数（铁律 15）。
double fspl_dB(double distance_m, double frequency_Hz);

// docs/scenario-format.md §7：doppler_Hz = −f·(dr/dt)/c，**远离为负**。
double doppler_Hz(double frequency_Hz, double range_rate_mps);

// 传播时延 d/c。
double delay_s(double distance_m);

// 热噪声功率谱密度：−174 dBm/Hz + 噪声系数。290 K 的 kT 取 −173.975 dBm/Hz，
// 工程惯例四舍五入到 −174（铁律 5：dB 域直接相加，不回线性域）。
double thermal_noise_dBm_per_Hz(double nf_dB);

struct LinkGeometry {
    double distance_m;
    double azimuth_deg;
    double elevation_deg;
    double range_rate_mps;    // > 0 表示远离
    bool line_of_sight;       // 首期平地假设恒真（铁律 2）

    LinkGeometry()
        : distance_m(0.0), azimuth_deg(0.0), elevation_deg(0.0),
          range_rate_mps(0.0), line_of_sight(true) {}
};

// site → emitter 的几何。emitter_velocity 是**地固系 ECEF 速度**；
// 径向速率 = velocity 在视线单位矢量上的投影，因此与站点、目标各自的 ENU 局部系无关，
// 不必担心两处站心不同带来的偏差。
//
// 一处自洽性说明：位置沿航段是「经纬高各自线性」（docs/scenario-format.md §5 冻结，
// 浏览器预览照此复算），而速度取「弦长 / 段时长」的常矢量。两者在 3 km 航段上相对差约 1e-5，
// 折到多普勒上是 0.001 Hz 量级，不影响任何验收数字；但它确实是两种口径，记在这里免得日后当缺陷查。
LinkGeometry link_geometry(const Lla& site, const Lla& emitter, const Ecef& emitter_velocity);

struct LinkBudget {
    double free_space_dB;
    double extra_loss_dB;             // 首期恒 0；D3 换刀口衍射附加损耗
    double path_loss_dB;              // = free_space + extra。**纯传播损耗，不含发射功率与天线增益**
    double doppler_Hz;
    double delay_s;
    double noise_floor_dBm_per_Hz;
    bool line_of_sight;
    bool valid;                       // 距离或频率非正时为 false，不拿 0 顶替（铁律 15）
    std::string reason;

    LinkBudget()
        : free_space_dB(0.0), extra_loss_dB(0.0), path_loss_dB(0.0), doppler_Hz(0.0),
          delay_s(0.0), noise_floor_dBm_per_Hz(0.0), line_of_sight(true), valid(true) {}
};

// path_loss_dB 只装传播损耗。发射功率与收发天线增益在首期是全程常量，属于"施加"类信道组件的
// 配置项，不进 10–100 Hz 的慢变帧——否则 link 事件与场景视图里的"路损"读数就名不副实了。
LinkBudget link_budget(const LinkGeometry& g, double frequency_Hz, double rx_nf_dB);

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_LINK_BUDGET_H
