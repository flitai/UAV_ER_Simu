// 链路预算：自由空间路损、多普勒、时延、热噪声底、视线角。
//
// 依据：docs/scenario-format.md §7（从场景到参数帧的契约）；概念模型 EM-P-01（自由空间传播）；
// CLAUDE.md 铁律 5（SI 单位，dB 域与线性域不混算）、铁律 2（平地假设）、铁律 15（不静默降级）、
// 决策 D-009（c = 299792458）。
//
// 自 D-058（2026-09-10）起，传播效应按档位组合，逐项计算在 cuav_geo/propagation.h：
// **缺省配置 = E1 = 自由空间**，代码路径与此前逐字相同（extra_loss_dB 恒 0）；
// E2 档加地面双径 / 城市经验（二选一）、统计阴影、大气与降雨。
// 替代型主模型也走 extra_loss_dB（extra = L_primary − L_fs），于是
// path_loss_dB = free_space_dB + extra_loss_dB 这个恒等式在任何档位下都成立——
// 「只改 extra_loss_dB 与 line_of_sight 两处，帧结构与本接口不变」这句承诺照旧兑现。
// 自 D3-5（2026-09-18）起 E3 档接入建筑遮挡（EM-P-04）：line_of_sight 由几何给出、
// 刀口衍射损耗只进 extra_loss_dB。**帧结构与本接口的承诺照旧兑现**——只改了这两处。

#ifndef CUAV_GEO_LINK_BUDGET_H
#define CUAV_GEO_LINK_BUDGET_H

#include <string>

#include "cuav_geo/geodesy.h"
#include "cuav_geo/map.h"
#include "cuav_geo/propagation.h"

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
    // 视线在**几何上**有没有被建筑切断。**与损耗大小无关**：掠射只损 0.2 dB 也算非视距
    // （07 报告 §5.1，D-074 ⑤）。这个布尔量的含义只有一个——楼挡没挡住；界面据它给链路线
    // 上色，颜色要摆事实、不摆实施方挑的门限（D-039）。没有地图时恒真（显式平地假设，铁律 2）。
    bool line_of_sight;
    // 收发端**离地高度** = alt_m − terrainHeight_m（铁律 2 的显式平地假设、铁律 2 禁止隐式相加）。
    // 只有地面双径用得上；E1 档不读它。tx = 辐射源、rx = 站点。
    double tx_height_m;
    double rx_height_m;
    // E3 档下的建筑刀口衍射（EM-P-04），**单程 ×1**；没有地图或未被切断时为 0。
    // intrusion_m 是视线侵入体块的竖直深度，只作解释不参与计算。
    double diffraction_dB;
    double intrusion_m;

    LinkGeometry()
        : distance_m(0.0), azimuth_deg(0.0), elevation_deg(0.0),
          range_rate_mps(0.0), line_of_sight(true),
          tx_height_m(0.0), rx_height_m(0.0),
          diffraction_dB(0.0), intrusion_m(0.0) {}
};

// E3 档的建筑遮挡查询：地图、平面工作帧与频率捆在一起，作为 link_geometry() 的可选输入。
//
// **频率必须逐帧给**，不能在建链路时定死：跳频源的中心频点每次停留都在变，而菲涅尔参数
// v ∝ 1/√λ 依赖它（D-069 记过「参数帧里的 tx_center_Hz 是瞬时频点」）。
//
// frame 是 geo::SceneFrame（cuav_geo/map.h）：**必须与建筑进适配器时用的是同一个**，
// 否则整份建筑集相对视线平移，而且不会报警（D3-4 立的口径）。
struct OcclusionQuery {
    const IMapQuery* map;
    SceneFrame frame;
    double frequency_Hz;
    OcclusionQuery() : map(0), frequency_Hz(0.0) {}
};

// site → emitter 的几何。emitter_velocity 是**地固系 ECEF 速度**；
// 径向速率 = velocity 在视线单位矢量上的投影，因此与站点、目标各自的 ENU 局部系无关，
// 不必担心两处站心不同带来的偏差。
//
// 一处自洽性说明：位置沿航段是「经纬高各自线性」（docs/scenario-format.md §5 冻结，
// 浏览器预览照此复算），而速度取「弦长 / 段时长」的常矢量。两者在 3 km 航段上相对差约 1e-5，
// 折到多普勒上是 0.001 Hz 量级，不影响任何验收数字；但它确实是两种口径，记在这里免得日后当缺陷查。
// terrain_height_m 是场景 coordinate.terrainHeight_m（显式平地假设的参考平面海拔）；
// 缺省 0 保持既有调用点一字不改。
// occ 非空即按建筑几何判视距并算刀口衍射（E3，D3-5）；为空时 line_of_sight 恒真、
// diffraction_dB 恒 0，代码路径与 D3-5 之前逐字相同。
LinkGeometry link_geometry(const Lla& site, const Lla& emitter, const Ecef& emitter_velocity,
                           double terrain_height_m = 0.0, const OcclusionQuery* occ = 0);

struct LinkBudget {
    double free_space_dB;
    double extra_loss_dB;             // E1 恒 0；E2 起装主模型差额 / 阴影 / 天气，E3 再加刀口衍射
    double path_loss_dB;              // = free_space + extra。**纯传播损耗，不含发射功率与天线增益**
    double doppler_Hz;
    double delay_s;
    double noise_floor_dBm_per_Hz;
    bool line_of_sight;
    bool valid;                       // 距离或频率非正时为 false，不拿 0 顶替（铁律 15）
    // 传播模型自身的降级（如双径拿不到反射点、城市经验在 d0 以内）。与 valid 正交：
    // 降级仍给得出可用的数，只是可信度降一档，不静默（铁律 15、05 §6.2.3 的四态）。
    bool degraded;
    PropagationTerms terms;           // 逐项分解与 included_loss_terms
    std::string reason;

    LinkBudget()
        : free_space_dB(0.0), extra_loss_dB(0.0), path_loss_dB(0.0), doppler_Hz(0.0),
          delay_s(0.0), noise_floor_dBm_per_Hz(0.0), line_of_sight(true), valid(true),
          degraded(false) {}
};

// path_loss_dB 只装传播损耗。发射功率与收发天线增益在首期是全程常量，属于"施加"类信道组件的
// 配置项，不进 10–100 Hz 的慢变帧——否则 link 事件与场景视图里的"路损"读数就名不副实了。
// cfg 缺省即 E1（自由空间），与本函数在 D-058 之前的行为逐数值相同。
// shadow_sample_dB 由调用方从 ShadowSequence 取好传进来：本函数保持纯函数、不持有随机状态。
// polarization 取场景 emission.polarization，只有地面双径读它。
LinkBudget link_budget(const LinkGeometry& g, double frequency_Hz, double rx_nf_dB,
                       const PropagationConfig& cfg = PropagationConfig(),
                       double shadow_sample_dB = 0.0,
                       const std::string& polarization = std::string("vertical"));

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_LINK_BUDGET_H
