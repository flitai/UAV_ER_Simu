#include "cuav_geo/propagation.h"

#include <algorithm>
#include <cmath>
#include <complex>

#include "cuav_geo/link_budget.h"

namespace cuav {
namespace geo {
namespace {

const double kPi = 3.14159265358979323846;
// 真空介电常数（CODATA 2018 精确值），只用于双径的复介电常数。
const double kEps0 = 8.8541878128e-12;
// 正态分布 90% 分位。城市经验取 mean_with_shadow_margin 时的裕度系数（EM-P-08 §10.10）。
const double kZ90 = 1.2815515655446004;

double clamp01(double v) { return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }

}  // namespace

const char* const kTermFreeSpace = "free_space";
const char* const kTermGroundReflection = "ground_reflection";
const char* const kTermUrbanMean = "urban_mean";
const char* const kTermDiffraction = "diffraction";
const char* const kTermShadow = "shadow";
const char* const kTermWeather = "weather";

// ---------------------------------------------------------------- 枚举文本

const char* to_string(PropLevel v) {
    switch (v) {
        case PropLevel::E1: return "E1";
        case PropLevel::E2: return "E2";
        case PropLevel::E3: return "E3";
    }
    return "E1";
}

const char* to_string(PrimaryModel v) {
    switch (v) {
        case PrimaryModel::FreeSpace: return "free_space";
        case PrimaryModel::TwoRay: return "two_ray";
        case PrimaryModel::UrbanEmpirical: return "urban_empirical";
    }
    return "free_space";
}

const char* to_string(EnvClass v) {
    switch (v) {
        case EnvClass::Open: return "open";
        case EnvClass::Suburban: return "suburban";
        case EnvClass::Urban: return "urban";
        case EnvClass::DenseUrban: return "dense_urban";
    }
    return "urban";
}

const char* to_string(GroundType v) {
    switch (v) {
        case GroundType::Paved: return "paved";
        case GroundType::Grass: return "grass";
        case GroundType::Water: return "water";
        case GroundType::Dirt: return "dirt";
        case GroundType::Unknown: return "unknown";
    }
    return "unknown";
}

const char* to_string(UrbanLossMode v) {
    switch (v) {
        case UrbanLossMode::Mean: return "mean";
        case UrbanLossMode::MeanWithShadowMargin: return "mean_with_shadow_margin";
    }
    return "mean";
}

const char* to_string(FadeState v) {
    switch (v) {
        case FadeState::NotApplicable: return "not_applicable";
        case FadeState::Constructive: return "constructive";
        case FadeState::Neutral: return "neutral";
        case FadeState::Destructive: return "destructive";
        case FadeState::DeepFade: return "deep_fade";
        case FadeState::Averaged: return "averaged";
    }
    return "not_applicable";
}

bool parse_prop_level(const std::string& s, PropLevel& out) {
    if (s == "E1") { out = PropLevel::E1; return true; }
    if (s == "E2") { out = PropLevel::E2; return true; }
    if (s == "E3") { out = PropLevel::E3; return true; }
    return false;
}

bool parse_primary_model(const std::string& s, PrimaryModel& out) {
    if (s == "free_space") { out = PrimaryModel::FreeSpace; return true; }
    if (s == "two_ray") { out = PrimaryModel::TwoRay; return true; }
    if (s == "urban_empirical") { out = PrimaryModel::UrbanEmpirical; return true; }
    return false;
}

bool parse_env_class(const std::string& s, EnvClass& out) {
    if (s == "open") { out = EnvClass::Open; return true; }
    if (s == "suburban") { out = EnvClass::Suburban; return true; }
    if (s == "urban") { out = EnvClass::Urban; return true; }
    if (s == "dense_urban") { out = EnvClass::DenseUrban; return true; }
    return false;
}

bool parse_ground_type(const std::string& s, GroundType& out) {
    if (s == "paved") { out = GroundType::Paved; return true; }
    if (s == "grass") { out = GroundType::Grass; return true; }
    if (s == "water") { out = GroundType::Water; return true; }
    if (s == "dirt") { out = GroundType::Dirt; return true; }
    if (s == "unknown") { out = GroundType::Unknown; return true; }
    return false;
}

bool parse_urban_loss_mode(const std::string& s, UrbanLossMode& out) {
    if (s == "mean") { out = UrbanLossMode::Mean; return true; }
    if (s == "mean_with_shadow_margin") { out = UrbanLossMode::MeanWithShadowMargin; return true; }
    return false;
}

// ---------------------------------------------------------------- 参数表

// 《天津机场_地表材质与建筑数据工作流》§3.5 的默认表，逐行照抄。
GroundParams ground_params(GroundType t) {
    GroundParams g;
    switch (t) {
        case GroundType::Paved:   g.eps_r = 5.0;  g.sigma_S_per_m = 0.008; g.roughness_m = 0.003; break;
        case GroundType::Grass:   g.eps_r = 15.0; g.sigma_S_per_m = 0.020; g.roughness_m = 0.010; break;
        case GroundType::Water:   g.eps_r = 80.0; g.sigma_S_per_m = 5.0;   g.roughness_m = 0.002; break;
        case GroundType::Dirt:    g.eps_r = 8.0;  g.sigma_S_per_m = 0.010; g.roughness_m = 0.010; break;
        case GroundType::Unknown: g.eps_r = 8.0;  g.sigma_S_per_m = 0.010; g.roughness_m = 0.005; break;
    }
    return g;
}

// EM-P-05 §10.6 的 log-distance 模板 + EM-P-08 §10.4 的 σ 表。全部 assumed（D-028）。
// open 行 n = 2 / X = 0，于是城市经验在该档**恒等于自由空间**（12 §3.3 B1）。
EnvTemplate env_template(EnvClass c) {
    EnvTemplate t;
    switch (c) {
        case EnvClass::Open:
            t.path_loss_exponent = 2.0; t.env_bias_dB = 0.0;
            t.shadow_sigma_los_dB = 3.0; t.shadow_sigma_nlos_dB = 5.0; break;
        case EnvClass::Suburban:
            t.path_loss_exponent = 2.6; t.env_bias_dB = 3.0;
            t.shadow_sigma_los_dB = 4.0; t.shadow_sigma_nlos_dB = 6.0; break;
        case EnvClass::Urban:
            t.path_loss_exponent = 3.0; t.env_bias_dB = 6.0;
            t.shadow_sigma_los_dB = 5.0; t.shadow_sigma_nlos_dB = 8.0; break;
        case EnvClass::DenseUrban:
            t.path_loss_exponent = 3.5; t.env_bias_dB = 9.0;
            t.shadow_sigma_los_dB = 6.0; t.shadow_sigma_nlos_dB = 10.0; break;
    }
    return t;
}

// ---------------------------------------------------------------- 配置校验

bool PropagationConfig::validate(std::string& err) const {
    // E3 与两个「建筑遮挡的统计等效」互斥——闸三与闸四（07 报告 §5.2、§6.5，D-074 ⑥）。
    // 两者都在用统计量描述同一件事（建筑挡住了视线），与按几何算出来的确定性绕射同时开
    // 就是同源双计（EM-P-13 §10.9）。报错并说明，不静默禁用其中一个（铁律 15）。
    if (level == PropLevel::E3) {
        if (shadow) {
            err = "prop_level = E3 已按建筑几何确定性地算出遮挡损耗，统计阴影（EM-P-08）是"
                  "同一效应的统计等效，同时开即同源双计；请关掉 prop_shadow，或把档位降回 E2";
            return false;
        }
        if (primary == PrimaryModel::UrbanEmpirical) {
            err = "prop_level = E3 已按建筑几何确定性地算出遮挡损耗，城市经验（EM-P-05）的"
                  "路损指数与环境偏置本身就是建筑密度的经验拟合，同时开即同源双计；"
                  "E3 下 prop_primary 只能是 free_space 或 two_ray";
            return false;
        }
    }
    if (level == PropLevel::E1) {
        // E1 只算自由空间路损、多普勒与时延。选了别的却停在 E1，不静默忽略（铁律 15）。
        if (primary != PrimaryModel::FreeSpace) {
            err = std::string("prop_level = E1 只算自由空间路损，与 prop_primary = ")
                  + to_string(primary) + " 冲突；要用它请把 prop_level 改为 E2";
            return false;
        }
        if (shadow || weather) {
            err = "prop_level = E1 只算自由空间路损、多普勒与时延；"
                  "统计阴影与大气降雨请把 prop_level 改为 E2";
            return false;
        }
    }
    if (!(coherence_rho >= 0.0) || !(coherence_rho <= 1.0)) {
        err = "coherence_rho（相干因子 ρ_c）必须在 0 到 1 之间";
        return false;
    }
    if (!(max_fade_depth_dB >= 0.0)) {
        err = "max_fade_depth_dB（相消限幅）不得为负";
        return false;
    }
    if (!(ref_distance_m > 0.0)) {
        err = "ref_distance_m（城市经验的参考距离 d0）必须为正";
        return false;
    }
    if (path_loss_exponent >= 0.0 && !(path_loss_exponent > 0.0)) {
        err = "path_loss_exponent（路损指数 n）必须为正；填 -1 表示按环境类别取表值";
        return false;
    }
    if (!(rain_rate_mmh >= 0.0)) {
        err = "rain_rate_mmh（降雨率）不得为负";
        return false;
    }
    // 闸二（EM-P-13 §10.9「若 EM-P-05 已抽样则禁用 EM-P-08」）：城市经验带 90% 分位裕度时
    // 已经含了阴影，再开统计阴影就是同源双计。报错并说明，不静默禁用（铁律 15）。
    if (shadow && primary == PrimaryModel::UrbanEmpirical
        && urban_mode == UrbanLossMode::MeanWithShadowMargin) {
        err = "城市经验取 urban_loss_mode = mean_with_shadow_margin 时已含 90% 分位阴影裕度，"
              "再开 prop_shadow 即同源双计（EM-P-13 §10.9）；"
              "请把 urban_loss_mode 改回 mean，或关掉 prop_shadow";
        return false;
    }
    return true;
}

// ---------------------------------------------------------------- 地面双径

void two_ray(double distance_m, double frequency_Hz, double h_t_m, double h_r_m,
             const std::string& polarization, const PropagationConfig& cfg,
             PropagationTerms& out) {
    out.two_ray_correction_dB = 0.0;
    out.fade = FadeState::NotApplicable;

    if (!(distance_m > 0.0) || !(frequency_Hz > 0.0)) {
        out.degraded = true;
        out.reason = "距离或频率非正，无法计算地面双径";
        return;
    }
    if (!(h_t_m > 0.0) || !(h_r_m > 0.0)) {
        // 收发端在参考平面之下或之上零高：镜像法给不出反射点。退回自由空间但**标出来**（铁律 15）。
        out.degraded = true;
        out.reason = "收发高度不在参考平面之上，无地面反射路径，本帧退回自由空间";
        return;
    }

    const double lambda = speed_of_light_mps() / frequency_Hz;
    const double dh = h_t_m - h_r_m;
    const double rho2 = distance_m * distance_m - dh * dh;
    const double rho = std::sqrt(rho2 > 0.0 ? rho2 : 0.0);
    const double hs = h_t_m + h_r_m;
    const double d_r = std::sqrt(rho * rho + hs * hs);
    out.path_diff_m = d_r - distance_m;
    out.breakpoint_m = 4.0 * h_t_m * h_r_m / lambda;

    // 掠射角 α：sinα = (h_t + h_r)/d_r；入射角自法向量起算，故 cosθ_i = sinα（EM-P-02 §10.4）
    const double cos_ti = (d_r > 0.0) ? hs / d_r : 0.0;
    const double sin2_ti = std::max(0.0, 1.0 - cos_ti * cos_ti);

    const GroundParams g = ground_params(cfg.ground);
    const double sigma_h = (cfg.roughness_m >= 0.0) ? cfg.roughness_m : g.roughness_m;
    const double omega = 2.0 * kPi * frequency_Hz;
    const std::complex<double> eps_c(g.eps_r, -g.sigma_S_per_m / (omega * kEps0));
    const std::complex<double> s = std::sqrt(eps_c - sin2_ti);

    const std::complex<double> gh = (cos_ti - s) / (cos_ti + s);
    const std::complex<double> gv = (eps_c * cos_ti - s) / (eps_c * cos_ti + s);

    std::complex<double> gpol;
    if (polarization == "vertical") {
        gpol = gv;
    } else if (polarization == "horizontal") {
        gpol = gh;
    } else {
        // §10.4：极化信息缺失时不得默认高可信相干深衰落。取幅度较小者（更保守）并标降级。
        gpol = (std::abs(gv) <= std::abs(gh)) ? gv : gh;
        out.degraded = true;
        out.reason = "发射极化不是线极化（" + polarization
                     + "），双径反射系数取水平与垂直中幅度较小者作保守值";
    }

    const double arg_rough = 4.0 * kPi * sigma_h * cos_ti / lambda;
    const double a_rough = std::exp(-arg_rough * arg_rough);
    const std::complex<double> g_eff = gpol * a_rough;

    out.reflection_mag = std::abs(g_eff);
    out.reflection_phase_rad = std::arg(g_eff);

    // 部分相干叠加（§10.6）：P = P_d·[1 + r² + 2ρ_c·r·cos(Δφ)]，r = |Γ_eff|·d_d/d_r
    const double r = (d_r > 0.0) ? out.reflection_mag * distance_m / d_r : 0.0;
    const double dphi = out.reflection_phase_rad - 2.0 * kPi * out.path_diff_m / lambda;
    double lin = 1.0 + r * r + 2.0 * cfg.coherence_rho * r * std::cos(dphi);
    if (!(lin > 0.0)) lin = 1e-30;           // 完全相消时 log10 会发散，先兜住再限幅
    double c_dB = 10.0 * std::log10(lin);

    if (c_dB < -cfg.max_fade_depth_dB) {
        c_dB = -cfg.max_fade_depth_dB;
        out.fade_clipped = true;
    }
    out.two_ray_correction_dB = c_dB;

    // 衰落状态（§10.8）。ρ_c < 1 一律降为 averaged：深衰落只有在完全相干且参数可信时
    // 才允许作强裁决输出。
    if (cfg.coherence_rho < 1.0) {
        out.fade = FadeState::Averaged;
    } else if (c_dB >= 3.0) {
        out.fade = FadeState::Constructive;
    } else if (c_dB > -3.0) {
        out.fade = FadeState::Neutral;
    } else if (c_dB > -10.0) {
        out.fade = FadeState::Destructive;
    } else {
        out.fade = FadeState::DeepFade;
    }
}

// ---------------------------------------------------------------- 城市经验

double urban_excess_dB(double distance_m, double frequency_Hz, bool line_of_sight,
                       const PropagationConfig& cfg, bool& degraded, std::string& reason) {
    if (!(distance_m > 0.0) || !(frequency_Hz > 0.0)) {
        degraded = true;
        reason = "距离或频率非正，无法计算城市经验路损";
        return 0.0;
    }
    const double d0 = cfg.ref_distance_m;
    if (!(d0 > 0.0)) {
        degraded = true;
        reason = "参考距离 d0 非正，城市经验退回自由空间";
        return 0.0;
    }
    if (distance_m <= d0) {
        // §10.18 out_of_range：log-distance 在 d0 以内没有意义，近区退回自由空间并标出来。
        degraded = true;
        reason = "距离小于参考距离 d0，近区退回自由空间";
        return 0.0;
    }
    const EnvTemplate t = env_template(cfg.env);
    const double n = (cfg.path_loss_exponent > 0.0) ? cfg.path_loss_exponent : t.path_loss_exponent;
    double l_emp = fspl_dB(d0, frequency_Hz)
                 + 10.0 * n * std::log10(distance_m / d0)
                 + t.env_bias_dB;
    if (cfg.urban_mode == UrbanLossMode::MeanWithShadowMargin) {
        l_emp += kZ90 * shadow_sigma_dB(cfg, line_of_sight);
    }
    return l_emp - fspl_dB(distance_m, frequency_Hz);
}

// ---------------------------------------------------------------- 大气与降雨（emcore 移植）

// 逐字移植自 C-UAV Model Demo/emcore/src/models/propagation.cpp 的 atmosphericLoss_dB，
// 保留原分段与原常数（D-009）。本式不含光速常数，与 geo/ 的 c = 299792458 不冲突。
double atmospheric_loss_dB(double distance_km, double frequency_GHz) {
    double gamma = 0.0;
    if (frequency_GHz < 10.0) {
        gamma = 0.005 + 0.001 * frequency_GHz;
    } else if (frequency_GHz < 50.0) {
        gamma = 0.01 * frequency_GHz - 0.05;
    } else {
        gamma = 0.5 + 0.02 * (frequency_GHz - 50.0);
    }
    return gamma * distance_km;
}

// 同上，移植自 rainAttenuation_dB。
double rain_attenuation_dB(double distance_km, double frequency_GHz, double rain_rate_mmh) {
    if (rain_rate_mmh <= 0.0) return 0.0;
    const double k = 0.0001 * std::pow(frequency_GHz, 1.5);
    const double alpha = 1.0 + 0.02 * frequency_GHz;
    return k * std::pow(rain_rate_mmh, alpha) * distance_km;
}

// ---------------------------------------------------------------- 统计阴影

double shadow_sigma_dB(const PropagationConfig& cfg, bool line_of_sight) {
    if (cfg.shadow_sigma_dB >= 0.0) return cfg.shadow_sigma_dB;
    const EnvTemplate t = env_template(cfg.env);
    // 本期 line_of_sight 恒真，NLOS 一列取不到；D3 接上视距判定后自动生效（12 §3.4）。
    return line_of_sight ? t.shadow_sigma_los_dB : t.shadow_sigma_nlos_dB;
}

ShadowSequence::ShadowSequence() {}

void ShadowSequence::build(const std::vector<double>& steps, double sigma_dB,
                           double corr_distance_m, INormalSource& rng) {
    values_.clear();
    if (!(sigma_dB > 0.0) || steps.empty()) return;
    values_.resize(steps.size());
    double x = sigma_dB * rng.normal();
    values_[0] = x;
    for (std::size_t k = 1; k < steps.size(); ++k) {
        // 每一步都抽一个正态量，与 rho 无关——少抽一次整条序列就与另一档对不上，
        // 固定种子的逐位复现要求抽样次数只由帧数决定。
        const double z = rng.normal();
        double rho = 0.0;
        if (corr_distance_m > 0.0) {
            const double ds = steps[k] > 0.0 ? steps[k] : 0.0;
            rho = clamp01(std::exp(-ds / corr_distance_m));
        }
        x = rho * x + std::sqrt(std::max(0.0, 1.0 - rho * rho)) * sigma_dB * z;
        values_[k] = x;
    }
}

double ShadowSequence::at(std::size_t k) const {
    if (values_.empty()) return 0.0;
    return k < values_.size() ? values_[k] : values_.back();
}

// ---------------------------------------------------------------- 组合

PropagationTerms combine(double distance_m, double frequency_Hz,
                         double h_t_m, double h_r_m, bool line_of_sight,
                         const std::string& polarization,
                         const PropagationConfig& cfg, double shadow_sample_dB,
                         double diffraction_sample_dB) {
    PropagationTerms t;
    t.free_space_dB = fspl_dB(distance_m, frequency_Hz);

    bool has_ground = false, has_urban = false, has_diffraction = false;
    bool has_shadow = false, has_weather = false;

    // E1：只算自由空间。代码路径与本方案之前逐字相同，缺省档因此逐数值等于今天。
    // validate() 已经拒过「E1 却选了别的」，这里再兜一道——combine 也被单测直接调用。
    if (cfg.effects_enabled()) {
        switch (cfg.primary) {
            case PrimaryModel::FreeSpace:
                break;
            case PrimaryModel::TwoRay:
                two_ray(distance_m, frequency_Hz, h_t_m, h_r_m, polarization, cfg, t);
                // 替代型主模型：L_2ray = L_fs − C_2ray，故 excess = −C_2ray（§10.7）
                t.primary_excess_dB = -t.two_ray_correction_dB;
                // 反射路径不成立时（h ≤ 0）已退回自由空间，不能声明含地面反射项
                has_ground = (t.two_ray_correction_dB != 0.0) || !t.degraded;
                break;
            case PrimaryModel::UrbanEmpirical: {
                bool deg = false;
                std::string why;
                t.primary_excess_dB = urban_excess_dB(distance_m, frequency_Hz, line_of_sight,
                                                      cfg, deg, why);
                if (deg) { t.degraded = true; t.reason = why; }
                has_urban = !deg;
                if (!deg && cfg.urban_mode == UrbanLossMode::MeanWithShadowMargin) has_shadow = true;
                break;
            }
        }

        // E3 的建筑刀口衍射（EM-P-04，D3-5）。**加项，不是替代型主模型**：它与自由空间
        // 或双径叠加，故 included 里 free_space（乃至 ground_reflection）照旧在。
        // 单程 ×1 不乘 2——emcore 的原注写的是雷达双程，本系统是电子侦察单向链路。
        if (cfg.level == PropLevel::E3) {
            t.diffraction_dB = diffraction_sample_dB;
            // 视距时损耗为零，但 E3 这一档确实「算过了遮挡」，清单照样声明：
            // 下游据 included 判断「能不能再叠加一个建筑遮挡的统计等效」，
            // 答案与这一帧恰好挡没挡住无关（EM-P-13 §10.9）。
            has_diffraction = true;
        }

        if (cfg.shadow) {
            t.shadow_dB = shadow_sample_dB;
            has_shadow = true;
        }

        if (cfg.weather) {
            const double d_km = distance_m / 1000.0;
            const double f_GHz = frequency_Hz / 1e9;
            t.atmospheric_dB = atmospheric_loss_dB(d_km, f_GHz);
            t.rain_dB = rain_attenuation_dB(d_km, f_GHz, cfg.rain_rate_mmh);
            t.weather_dB = t.atmospheric_dB + t.rain_dB;
            has_weather = true;
        }
    }

    t.extra_dB = t.primary_excess_dB + t.diffraction_dB + t.shadow_dB + t.weather_dB;

    // included_loss_terms 按固定顺序，下游据此判断能不能再叠加（EM-P-13 §10.9）
    t.included.push_back(kTermFreeSpace);
    if (has_ground) t.included.push_back(kTermGroundReflection);
    if (has_urban) t.included.push_back(kTermUrbanMean);
    if (has_diffraction) t.included.push_back(kTermDiffraction);
    if (has_shadow) t.included.push_back(kTermShadow);
    if (has_weather) t.included.push_back(kTermWeather);
    return t;
}

namespace legacy {

// 自 emcore `src/models/propagation.cpp` 逐字移植（D3-3）。**光速取 3e8 守黄金基准，
// 不许改成 299792458**（D-009；理由见 cuav_geo/propagation.h 里这一节的头注）。
namespace {
const double kSpeedOfLightGolden = 3e8;
}

double fresnel_v(double obstacle_height_m, double d1_m, double d2_m, double frequency_Hz) {
    const double lambda = kSpeedOfLightGolden / frequency_Hz;
    return obstacle_height_m * std::sqrt((2.0 * (d1_m + d2_m)) / (lambda * d1_m * d2_m));
}

double knife_edge_loss_dB(double v) {
    if (v <= -0.78) return 0.0;
    const double t = v - 0.1;
    return 6.9 + 20.0 * std::log10(std::sqrt(t * t + 1.0) + t);
}

}  // namespace legacy

}  // namespace geo
}  // namespace cuav
