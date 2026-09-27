// 覆盖场（探测范围，D-080；D-079 的计算落点改到引擎）。
//
// 问的问题：焦点目标若在观测区域网格上的某一格、某个离地高度，每个侦测站的能量检测器单帧检出
// 概率是多少。**每一格都走引擎链路帧的同一条路**：
//   link_geometry()（E3 才带建筑遮挡，与链路帧同一个地图、同一个平面帧）
//   → link_budget(g, f, nf, cfg, 0, polarization)（框图里选的传播档位与效应，一个不少）
//   → S = P_tx + G_t + G_r − path_loss；N = −174 + nf + 10·log10(M·fs/nfft)
//   → Pd = pd_random(M, η, 10^((S−N)/10))，η = threshold_for_pfa(M, pfa)
// 于是覆盖图在任一点读出的路损就是引擎在那一点给链路帧算的路损（tests/regression/coverage_field.py 对拍）。
//
// 统计阴影是时间上的随机过程，一张静态图取的是**对阴影分布平均的 Pd**：
// Pd̄ = E_X[Pd(snr − X)]，X ~ N(0, σ)，σ = shadow_sigma_dB(cfg, 视距) 与链路帧同取（scenario.cpp 取视距那一档）。
// 先在 0.01 dB 细格上算 Pd 再与离散高斯卷积成一张表、逐格插值（16 点 Gauss–Hermite 在 M≈921 的陡坎上
// 偏 0.016，实测），不开阴影就直接代公式、与不平均逐位相同。
//
// 输入：请求 JSON（cuav-field-request/1，docs/api-versions.md §3.1f）+ 场景 + 观测区域清单（网格边界取 aoi.bbox）。
// 输出：逐站与合并的 Pd 网格（float32，行主序、第 0 行在北）与一份事实摘要。

#ifndef CUAV_FIELD_H
#define CUAV_FIELD_H

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"
#include "cuav_geo/propagation.h"
#include "cuav_geo/scenario.h"

namespace cuav {

struct FieldDetector {
    int nfft = 0;
    double pfa = 0.0;
    double band_lo_Hz = 0.0;   // 相对站的接收中心频率
    double band_hi_Hz = 0.0;
};

struct FieldRequest {
    std::string emitter_id;
    double height_agl_m = 0.0;
    double res_m = 100.0;
    std::map<std::string, double> prop_num;       // 十五个传播参数里的数值与布尔
    std::map<std::string, std::string> prop_txt;  // 十五个传播参数里的枚举
    std::map<std::string, FieldDetector> detectors;   // 站 id → 检测器；场景里的每个站都要有
    // 额外逐点求值，对拍用，可空：[经度, 纬度] 或 [经度, 纬度, 离地高度]（缺第三个即取 height_agl_m）
    struct Point { double lon, lat, height_agl_m; };
    std::vector<Point> points;
};

// 请求 JSON → FieldRequest。键认不出、类型不对、取值越界都失败并写 err（铁律 15）。
bool parse_field_request(const nlohmann::json& j, FieldRequest& out, std::string& err);

struct FieldSite {
    std::string id;
    int m_bins = 0;
    double eta = 0.0;
    double noise_bw_Hz = 0.0;
    bool out_of_band = false;          // 目标中心在检测频段外：逐格 Pd = 虚警率
    std::uint64_t blocked = 0;         // 被楼切断的格数（E3 才可能非零）
    std::uint64_t degraded = 0;        // 传播模型自身降级的格数（如双径拿不到反射点）
    double shadow_sigma_dB = 0.0;      // 用来平均的 σ；不开阴影为 0
    std::vector<float> pd;
};

struct FieldPointSite {
    double distance_m = 0.0;
    double path_loss_dB = 0.0;
    double diffraction_dB = 0.0;
    bool line_of_sight = true;
    double snr_dB = 0.0;
    double pd = 0.0;
    bool valid = false;
};

struct FieldPoint {
    double lon = 0.0, lat = 0.0, height_agl_m = 0.0;
    std::map<std::string, FieldPointSite> sites;
};

struct FieldResult {
    int nx = 0, ny = 0;
    double bbox[4] = {0, 0, 0, 0};   // 西、南、东、北
    std::vector<FieldSite> sites;     // 与场景 sites 同序
    std::vector<float> combined;      // 1 − Π(1 − Pd_i)
    std::vector<FieldPoint> points;
    std::vector<std::string> included_loss_terms;   // 取自第一格的链路预算，说明这张图计入了哪几项
    std::string prop_level;
    std::vector<std::string> notes;   // 建筑装载统计等，照实给出
};

// 网格：包围盒按 res_m 等分（纬向 111132 m/度、经向按中纬度余弦），格心 = 等分点的中点。
// 只决定格心摆在哪，不进物理。
void field_grid(const double bbox[4], double res_m, int& nx, int& ny);

// 计算。scene_root 是观测区域数据包根目录（读清单的 aoi.bbox；E3 时读建筑）。
bool compute_field(const geo::Scenario& sc, const FieldRequest& req, const std::string& scene_root,
                   FieldResult& out, std::string& err);


}  // namespace cuav

#endif  // CUAV_FIELD_H
