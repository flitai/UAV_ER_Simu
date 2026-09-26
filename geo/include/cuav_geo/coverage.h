// 探测范围（覆盖场）的单格链路预算（D-079）。
//
// 场景页「探测范围」图层对网格上每一格、每一个侦测站问同一个问题：一架发射参数给定的无人机
// 若在这一格、这个离地高度上，站上检测器的带内信噪比是多少。**本文件只组合已有的三件**，
// 不新造任何物理：
//   - 几何与建筑遮挡：link_geometry()（与链路帧同一个函数、同一条遮挡通路，D3-5）；
//   - 自由空间路损：fspl_dB()；
//   - 热噪声：thermal_noise_dBm_per_Hz()。
// 于是覆盖图在某一格上读出的路损，与引擎跑 E3 档（主模型自由空间、不开阴影与天气）时
// 链路帧在同一点给出的 path_loss_dB 是**同一个数**——验收就按这句话对拍。
//
// 浏览器侧 `web/src/scene/coverage/cell.ts` 逐行复算，两侧同守 tests/golden/coverage-cells.json
// （rel ≤ 1e-9；C++ 是真理源，改动顺序 C++ → 重生成 golden → TS 对拍，D-074 ①）。
// 检测概率不在这里：Pd 的真理源是 algos/reference/energy_detector.py 与 tests/golden/analytic-pd.json，
// 浏览器侧 results/analytic.ts 已守着它，覆盖图直接复用。
//
// 口径（与 tests/regression/crosslayer_pd_chain.py 的解析侧同式）：
//   S = P_tx + G_t + G_r − FSPL − L_diff
//   N = −174 + nf + 10·log10(noise_bw_Hz)，noise_bw_Hz = M · fs / nfft（检测频段的等效噪声带宽）
// 接收机前端增益在 S 与 N 里各出现一次，两边抵消，不进公式。

#ifndef CUAV_GEO_COVERAGE_H
#define CUAV_GEO_COVERAGE_H

#include "cuav_geo/geodesy.h"
#include "cuav_geo/link_budget.h"

namespace cuav {
namespace geo {

struct CoverageLink {
    double tx_power_dBm;
    double tx_gain_dBi;
    double rx_gain_dBi;
    double nf_dB;
    double noise_bw_Hz;
    double frequency_Hz;
    CoverageLink()
        : tx_power_dBm(0.0), tx_gain_dBi(0.0), rx_gain_dBi(0.0), nf_dB(0.0),
          noise_bw_Hz(0.0), frequency_Hz(0.0) {}
};

struct CoverageCell {
    double distance_m;
    double fspl_dB;
    double diffraction_dB;   // 单程刀口衍射，未被切断或没有地图时为 0
    bool blocked;            // 几何上被楼切断（与损耗大小无关，同链路帧的 line_of_sight 取反）
    double signal_dBm;
    double noise_dBm;
    double snr_dB;
    bool valid;              // 距离、频率或噪声带宽非正时为 false，数值不可用（铁律 15）
    CoverageCell()
        : distance_m(0.0), fspl_dB(0.0), diffraction_dB(0.0), blocked(false),
          signal_dBm(0.0), noise_dBm(0.0), snr_dB(0.0), valid(false) {}
};

// site / target 的 alt_m 按场景 coordinate.alt_ref 解释（与 link_geometry 相同），
// terrain_height_m 是显式平地假设的参考平面（铁律 2）。occ 为空即不算建筑遮挡；
// occ 里的 frequency_Hz 不读，刀口衍射一律按 link.frequency_Hz 算（与自由空间同一个频率）。
CoverageCell coverage_cell(const Lla& site, const Lla& target, double terrain_height_m,
                           const OcclusionQuery* occ, const CoverageLink& link);

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_COVERAGE_H
