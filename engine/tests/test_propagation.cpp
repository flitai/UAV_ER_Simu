// 传播效应的组合与逐项模型（12 号报告 §3、§9；决策 D-058）。
//
// geo/ 零第三方依赖，它的 doctest 单测按既有惯例寄放在 engine/tests/（同 test_geo.cpp）。
//
// 本文件覆盖 12 §9 的判据 1、5、6、7、8、9：
//   · E1 缺省档逐数值等于自由空间（判据 1 的库侧部分；产品字节比对在 R-1 的收口里另做）
//   · 天气两式对 emcore 黄金基准 64 例 rel ≤ 1e-9（判据 5）
//   · 城市经验 open 档对 fspl_dB rel ≤ 1e-9（判据 6）
//   · 地面双径解析锚点 A1–A5（判据 7）
//   · 统计阴影 C1–C5（判据 8）
//   · 两道闸与 E3（判据 9）

#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav_geo/link_budget.h"
#include "cuav_geo/propagation.h"

using namespace cuav;
using namespace cuav::geo;

namespace {

const double kTol = 1e-9;

std::string repo_path(const char* rel) {
    return std::string(CUAV_SOURCE_DIR) + "/../" + rel;
}

void check_rel(double got, double want, double tol, const char* what) {
    const double denom = std::fabs(want) > 1e-12 ? std::fabs(want) : 1.0;
    const double rel = std::fabs(got - want) / denom;
    CHECK_MESSAGE((rel <= tol || std::fabs(got - want) <= 1e-12),
                  what << "：得 " << got << "，基准 " << want << "，相对误差 " << rel);
}

// 确定性的正态源，只用于测试。真正的发生器在引擎侧（Xoshiro256pp），
// geo/ 只认 INormalSource 这个抽象（铁律 9）。
class SeqNormal : public INormalSource {
public:
    explicit SeqNormal(std::uint64_t seed) : s_(seed ? seed : 1u) {}
    double normal() override {
        // Box–Muller，配一个最简 splitmix64。测试用，不追求统计学上的讲究，
        // 但必须逐位可复现——C1 判据靠它。
        const double u1 = next_unit();
        const double u2 = next_unit();
        return std::sqrt(-2.0 * std::log(u1)) * std::cos(2.0 * 3.14159265358979323846 * u2);
    }

private:
    double next_unit() {
        s_ += 0x9E3779B97F4A7C15ull;
        std::uint64_t z = s_;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
        z = z ^ (z >> 31);
        const double u = static_cast<double>(z >> 11) * (1.0 / 9007199254740992.0);
        return u > 0.0 ? u : 1e-300;   // log(0) 会炸
    }
    std::uint64_t s_;
};

PropagationConfig e2_base() {
    PropagationConfig c;
    c.level = PropLevel::E2;
    return c;
}

}  // namespace

// ------------------------------------------------------------ 判据 1：E1 缺省档

TEST_CASE("E1 缺省档只有自由空间：extra 恒 0，included 只有 free_space") {
    PropagationConfig cfg;   // 缺省
    CHECK(cfg.level == PropLevel::E1);
    CHECK(cfg.primary == PrimaryModel::FreeSpace);
    CHECK_FALSE(cfg.effects_enabled());

    const double f = 2.4405e9;
    for (double d = 10.0; d < 20000.0; d *= 3.0) {
        const PropagationTerms t = combine(d, f, 50.0, 30.0, true, "vertical", cfg, 7.0);
        // 逐位相等：E1 的代码路径与 D-058 之前逐字相同
        CHECK(t.free_space_dB == fspl_dB(d, f));
        CHECK(t.extra_dB == 0.0);
        CHECK(t.shadow_dB == 0.0);
        CHECK(t.weather_dB == 0.0);
        CHECK(t.included.size() == 1u);
        CHECK(t.included[0] == std::string(kTermFreeSpace));
        CHECK_FALSE(t.degraded);
    }
}

TEST_CASE("E1 档下 link_budget 与不给配置时逐位相同") {
    LinkGeometry g;
    g.distance_m = 1234.5;
    g.range_rate_mps = -12.0;
    g.tx_height_m = 50.0;
    g.rx_height_m = 30.0;
    const LinkBudget a = link_budget(g, 2.4e9, 6.0);
    const LinkBudget b = link_budget(g, 2.4e9, 6.0, PropagationConfig(), 0.0, "vertical");
    CHECK(a.path_loss_dB == b.path_loss_dB);
    CHECK(a.free_space_dB == b.free_space_dB);
    CHECK(a.extra_loss_dB == 0.0);
    CHECK(a.path_loss_dB == a.free_space_dB);
    CHECK_FALSE(a.degraded);
    // FSPL 解析锚点（与 test_geo.cpp 同一个）：2.4 GHz、1 km
    LinkGeometry g1;
    g1.distance_m = 1000.0;
    const LinkBudget c = link_budget(g1, 2.4e9, 6.0);
    check_rel(c.path_loss_dB, 100.0520080561155, 1e-12, "FSPL@2.4GHz/1km");
}

// ------------------------------------------------------------ 判据 9：两道闸与 E3

TEST_CASE("E3 未实现：configure 级校验必须拒，报文写明待 D3") {
    PropagationConfig cfg;
    cfg.level = PropLevel::E3;
    std::string err;
    CHECK_FALSE(cfg.validate(err));
    CHECK(err.find("E3") != std::string::npos);
    CHECK(err.find("D3") != std::string::npos);
}

TEST_CASE("E1 档却选了效应：不静默忽略，报错并指路") {
    std::string err;
    {
        PropagationConfig cfg;
        cfg.primary = PrimaryModel::TwoRay;      // 仍停在 E1
        CHECK_FALSE(cfg.validate(err));
        CHECK(err.find("E2") != std::string::npos);
    }
    {
        PropagationConfig cfg;
        cfg.shadow = true;
        CHECK_FALSE(cfg.validate(err));
    }
    {
        PropagationConfig cfg;
        cfg.weather = true;
        CHECK_FALSE(cfg.validate(err));
    }
}

TEST_CASE("闸二：城市经验带分位裕度 + 统计阴影 = 同源双计，报错不静默禁用") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::UrbanEmpirical;
    cfg.urban_mode = UrbanLossMode::MeanWithShadowMargin;
    cfg.shadow = true;
    std::string err;
    CHECK_FALSE(cfg.validate(err));
    CHECK(err.find("双计") != std::string::npos);

    // 只开一边都合法
    cfg.shadow = false;
    CHECK(cfg.validate(err));
    cfg.urban_mode = UrbanLossMode::Mean;
    cfg.shadow = true;
    CHECK(cfg.validate(err));
}

TEST_CASE("参数范围的跨参数约束") {
    std::string err;
    PropagationConfig cfg = e2_base();
    cfg.coherence_rho = 1.5;
    CHECK_FALSE(cfg.validate(err));
    cfg = e2_base();
    cfg.ref_distance_m = 0.0;
    CHECK_FALSE(cfg.validate(err));
    cfg = e2_base();
    cfg.path_loss_exponent = 0.0;             // 显式给 0 是错的；-1 才是「按表取」
    CHECK_FALSE(cfg.validate(err));
    cfg = e2_base();
    cfg.path_loss_exponent = -1.0;
    CHECK(cfg.validate(err));
    cfg = e2_base();
    cfg.rain_rate_mmh = -1.0;
    CHECK_FALSE(cfg.validate(err));
}

// ------------------------------------------------------------ 判据 5：天气两式对 emcore golden

TEST_CASE("黄金基准：大气与降雨两式与 emcore 逐值相符（相对误差 ≤ 1e-9）") {
    const std::string path = repo_path("tests/golden/propagation.json");
    std::ifstream f(path.c_str(), std::ios::binary);
    REQUIRE_MESSAGE(f.good(), "读不到 " << path);
    std::stringstream ss;
    ss << f.rdbuf();
    const nlohmann::json g = nlohmann::json::parse(ss.str());
    CHECK(g["_meta"]["tolerance_rel"].get<double>() == doctest::Approx(kTol));

    std::size_t n = 0;
    for (const auto& c : g["atmosphericLoss_dB"]) {
        const double got = atmospheric_loss_dB(c["in"][0].get<double>(), c["in"][1].get<double>());
        check_rel(got, c["out"].get<double>(), kTol, "atmosphericLoss_dB");
        ++n;
    }
    CHECK(n == 40u);

    n = 0;
    for (const auto& c : g["rainAttenuation_dB"]) {
        const double got = rain_attenuation_dB(c["in"][0].get<double>(), c["in"][1].get<double>(),
                                               c["in"][2].get<double>());
        check_rel(got, c["out"].get<double>(), kTol, "rainAttenuation_dB");
        ++n;
    }
    CHECK(n == 24u);
    MESSAGE("大气与降雨黄金基准对拍 64 例（自 emcore 移植，保留原常数与原分段，D-009）");
}

TEST_CASE("天气项在本项目的频段与距离上是 0.1 dB 量级——模型卡据此写适用范围") {
    const double d_km = 20.0, f_GHz = 2.4405;
    const double atm = atmospheric_loss_dB(d_km, f_GHz);
    const double rain = rain_attenuation_dB(d_km, f_GHz, 25.0);   // 25 mm/h 中雨
    CHECK(atm < 0.2);
    CHECK(rain < 0.3);
    MESSAGE("2.4405 GHz / 20 km：大气 " << atm << " dB，25 mm/h 降雨 " << rain << " dB");
}

TEST_CASE("天气是加项：included 多一项 weather，总额等于两式之和") {
    PropagationConfig cfg = e2_base();
    cfg.weather = true;
    cfg.rain_rate_mmh = 25.0;
    const double d = 20000.0, f = 2.4405e9;
    const PropagationTerms t = combine(d, f, 50.0, 30.0, true, "vertical", cfg, 0.0);
    CHECK(t.weather_dB == doctest::Approx(t.atmospheric_dB + t.rain_dB));
    CHECK(t.extra_dB == doctest::Approx(t.weather_dB));
    REQUIRE(t.included.size() == 2u);
    CHECK(t.included[1] == std::string(kTermWeather));
}

// ------------------------------------------------------------ 判据 6：城市经验 B1–B4

TEST_CASE("B1 城市经验 open 档恒等于自由空间（替代关系的钉子）") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::UrbanEmpirical;
    cfg.env = EnvClass::Open;
    const EnvTemplate t = env_template(EnvClass::Open);
    CHECK(t.path_loss_exponent == 2.0);
    CHECK(t.env_bias_dB == 0.0);

    for (double f = 4e8; f <= 6e9; f *= 2.5) {
        for (double d = 200.0; d < 30000.0; d *= 2.7) {
            bool deg = false;
            std::string why;
            const double ex = urban_excess_dB(d, f, true, cfg, deg, why);
            CHECK_FALSE(deg);
            CHECK_MESSAGE(std::fabs(ex) <= 1e-9, "d=" << d << " f=" << f << " 差 " << ex << " dB");
        }
    }
}

TEST_CASE("B2 / B3 城市经验的两个解析锚点：d0 处偏置精确，每十倍程 10n dB") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::UrbanEmpirical;
    cfg.env = EnvClass::Urban;
    const EnvTemplate t = env_template(EnvClass::Urban);
    const double f = 2.4405e9, d0 = cfg.ref_distance_m;

    bool deg = false;
    std::string why;
    // B2：d 略大于 d0（d == d0 落在近区分支里），偏置趋于 X_env
    const double ex0 = urban_excess_dB(d0 * (1.0 + 1e-9), f, true, cfg, deg, why);
    CHECK_FALSE(deg);
    check_rel(ex0, t.env_bias_dB, 1e-6, "d0 处的城市偏置");

    // B3：十倍程斜率
    const double e1 = urban_excess_dB(1000.0, f, true, cfg, deg, why)
                    + fspl_dB(1000.0, f);
    const double e2 = urban_excess_dB(10000.0, f, true, cfg, deg, why)
                    + fspl_dB(10000.0, f);
    check_rel(e2 - e1, 10.0 * t.path_loss_exponent, 1e-9, "每十倍程的斜率");
}

TEST_CASE("B4 城市经验的分位裕度正好是 1.2816 σ") {
    PropagationConfig a = e2_base();
    a.primary = PrimaryModel::UrbanEmpirical;
    a.env = EnvClass::Urban;
    PropagationConfig b = a;
    b.urban_mode = UrbanLossMode::MeanWithShadowMargin;

    bool deg = false;
    std::string why;
    const double d = 3000.0, f = 2.4405e9;
    const double da = urban_excess_dB(d, f, true, a, deg, why);
    const double db = urban_excess_dB(d, f, true, b, deg, why);
    const double sigma = env_template(EnvClass::Urban).shadow_sigma_los_dB;
    check_rel(db - da, 1.2815515655446004 * sigma, 1e-9, "90% 分位裕度");
    CHECK(sigma == 5.0);
}

TEST_CASE("城市经验的近区退回自由空间且标降级，不静默外推") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::UrbanEmpirical;
    bool deg = false;
    std::string why;
    const double ex = urban_excess_dB(50.0, 2.4405e9, true, cfg, deg, why);   // d0 = 100
    CHECK(ex == 0.0);
    CHECK(deg);
    CHECK(why.find("d0") != std::string::npos);

    // 走 combine 时降级要传出来，且不声明含 urban_mean
    const PropagationTerms t = combine(50.0, 2.4405e9, 50.0, 30.0, true, "vertical", cfg, 0.0);
    CHECK(t.degraded);
    CHECK(t.included.size() == 1u);
    CHECK(t.extra_dB == 0.0);
}

TEST_CASE("城市经验是替代型主模型：城市档的路损明显高于自由空间且随环境等级单调") {
    const double d = 5000.0, f = 2.4405e9;
    double prev = -1e9;
    const EnvClass order[4] = {EnvClass::Open, EnvClass::Suburban, EnvClass::Urban, EnvClass::DenseUrban};
    for (int i = 0; i < 4; ++i) {
        PropagationConfig cfg = e2_base();
        cfg.primary = PrimaryModel::UrbanEmpirical;
        cfg.env = order[i];
        const PropagationTerms t = combine(d, f, 50.0, 30.0, true, "vertical", cfg, 0.0);
        CHECK(t.extra_dB > prev);
        prev = t.extra_dB;
        REQUIRE(t.included.size() == 2u);
        CHECK(t.included[1] == std::string(kTermUrbanMean));
    }
    CHECK(prev > 20.0);   // dense_urban 在 5 km 上比自由空间差二十几 dB
}

// ------------------------------------------------------------ 判据 7：地面双径 A1–A5

TEST_CASE("A5 断点距离：demo-01 的收发高度下 d_bp 远大于观测区域尺度") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    PropagationTerms t;
    two_ray(3000.0, 2.4405e9, 50.0, 30.0, "vertical", cfg, t);
    const double lambda = speed_of_light_mps() / 2.4405e9;
    check_rel(t.breakpoint_m, 4.0 * 50.0 * 30.0 / lambda, 1e-12, "d_bp");
    CHECK(t.breakpoint_m > 40000.0);
    MESSAGE("demo-01 的 d_bp = " << t.breakpoint_m / 1000.0 << " km：20 km 的观测区域内恒在干涉区");
}

TEST_CASE("A3 粗糙面：σ_h 大到一定程度双径退化为自由空间") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    cfg.roughness_m = 100.0;                 // 远大于波长
    PropagationTerms t;
    two_ray(3000.0, 2.4405e9, 50.0, 30.0, "vertical", cfg, t);
    CHECK(std::fabs(t.two_ray_correction_dB) < 1e-9);
    CHECK(t.reflection_mag < 1e-12);
    CHECK(t.fade == FadeState::Neutral);
}

TEST_CASE("A2 接收端贴地：Δd = 0，修正量退化为 20·log10|1 + Γ_eff|") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    cfg.ground = GroundType::Water;
    cfg.roughness_m = 0.0;
    PropagationTerms t;
    const double d = 5000.0, f = 2.4405e9;
    // h_r 取一个极小的正值：0 会落进「不在参考平面之上」的降级分支
    two_ray(d, f, 100.0, 1e-9, "vertical", cfg, t);
    CHECK(std::fabs(t.path_diff_m) < 1e-6);
    const double want = 20.0 * std::log10(std::fabs(1.0 + t.reflection_mag
                                                    * std::cos(t.reflection_phase_rad)));
    // Δd = 0 时相位只剩 arg(Γ)，复数和退化为 |1 + Γ|
    CHECK(std::fabs(t.two_ray_correction_dB - want) < 0.5);
}

TEST_CASE("A1 掠射极限：水面光滑掠射时 Γ_H ≈ −1，相消到限幅、相长接近 +6 dB") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    cfg.ground = GroundType::Water;
    cfg.roughness_m = 0.0;
    cfg.max_fade_depth_dB = 20.0;
    const double f = 2.4405e9;
    const double lambda = speed_of_light_mps() / f;

    // **必须用水平极化**。Γ_H 在掠射下很快趋于 −1；Γ_V 有伪 Brewster 凹陷，
    // 同样的 0.7° 掠射角上 |Γ_V| 只有 0.80，相长上界因此只到 +5.1 dB 而不是 +6.02
    // （最初按 vertical 写的这条断言就是这么红的）。这是物理，不是缺陷，记进模型卡。
    PropagationTerms t;
    two_ray(20000.0, f, 5.0, 5.0, "horizontal", cfg, t);
    CHECK(t.reflection_mag > 0.95);
    CHECK(std::fabs(std::fabs(t.reflection_phase_rad) - 3.14159265358979323846) < 0.2);

    // 扫距离取**第一片干涉条纹所在的区间**：等高时 Δd ≈ 2·h_t·h_r/d，
    // 相长（Δφ = 0，即 Δd = λ/2）出现在 d ≈ 2·h_t·h_r/(λ/2) = 814 m，
    // 相消（Δd = λ）在 d ≈ 407 m。取 [300, 2000] m 正好覆盖一个完整的亮暗。
    // 若像最初那样从 3 km 起扫，Δd 已经远小于 λ/2，全程停在相消一侧——
    // 这不是模型错，是扫描窗口选错了。
    double hi = -1e9, lo = 1e9;
    for (int i = 0; i < 3400; ++i) {
        const double d = 300.0 + i * 0.5;
        PropagationTerms s;
        two_ray(d, f, 5.0, 5.0, "horizontal", cfg, s);
        if (s.two_ray_correction_dB > hi) hi = s.two_ray_correction_dB;
        if (s.two_ray_correction_dB < lo) lo = s.two_ray_correction_dB;
    }
    CHECK(hi > 5.5);
    CHECK(hi <= 6.03);
    CHECK(lo == doctest::Approx(-20.0));
    MESSAGE("掠射水面扫距离 [300, 2000] m：C_2ray ∈ [" << lo << ", " << hi
            << "] dB，λ = " << lambda << " m");
}

TEST_CASE("A4 远场：d ≫ d_bp 时趋于 d^-4，路损斜率接近 40 dB/十倍程") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    cfg.ground = GroundType::Water;
    cfg.roughness_m = 0.0;
    // **限幅必须放宽**：远场的深零点比缺省的 20 dB 深得多，20 dB 限幅会把 d^-4 的斜率削平——
    // 实测第一次跑出来 l2 − l1 恰好等于 20 dB（自由空间的斜率），正是两端都被限住的结果。
    // 这不是缺陷，是限幅的语义；模型卡要写清楚「限幅比零点浅时看不到远场渐近」。
    cfg.max_fade_depth_dB = 60.0;
    const double f = 2.4405e9;
    const double h = 2.0;                    // 低天线 ⇒ d_bp 小
    PropagationTerms probe;
    two_ray(1000.0, f, h, h, "vertical", cfg, probe);
    REQUIRE(probe.breakpoint_m < 500.0);

    // 断点之外取两个十倍程点，比较等效双径路损
    const double d1 = 20000.0, d2 = 200000.0;
    PropagationTerms a, b;
    two_ray(d1, f, h, h, "vertical", cfg, a);
    two_ray(d2, f, h, h, "vertical", cfg, b);
    const double l1 = fspl_dB(d1, f) - a.two_ray_correction_dB;
    const double l2 = fspl_dB(d2, f) - b.two_ray_correction_dB;
    CHECK(l2 - l1 > 36.0);
    CHECK(l2 - l1 < 44.0);
    MESSAGE("d_bp = " << probe.breakpoint_m << " m，20 km → 200 km 的双径路损增加 "
            << (l2 - l1) << " dB（自由空间只增 20 dB）");
}

TEST_CASE("收发高度不在参考平面之上：退回自由空间但标降级，不静默") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    PropagationTerms t;
    two_ray(3000.0, 2.4405e9, -5.0, 30.0, "vertical", cfg, t);
    CHECK(t.two_ray_correction_dB == 0.0);
    CHECK(t.degraded);
    CHECK(t.reason.find("参考平面") != std::string::npos);

    const PropagationTerms c = combine(3000.0, 2.4405e9, -5.0, 30.0, true, "vertical", cfg, 0.0);
    CHECK(c.extra_dB == 0.0);
    CHECK(c.degraded);
    CHECK(c.included.size() == 1u);          // 不声明含地面反射项
}

TEST_CASE("非线极化：取保守值并标降级（不默认高可信深衰落）") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    PropagationTerms t;
    two_ray(3000.0, 2.4405e9, 50.0, 30.0, "rhcp", cfg, t);
    CHECK(t.degraded);
    CHECK(t.reason.find("极化") != std::string::npos);

    PropagationTerms v, h;
    two_ray(3000.0, 2.4405e9, 50.0, 30.0, "vertical", cfg, v);
    two_ray(3000.0, 2.4405e9, 50.0, 30.0, "horizontal", cfg, h);
    CHECK(t.reflection_mag <= std::fmax(v.reflection_mag, h.reflection_mag) + 1e-12);
}

TEST_CASE("相干因子：ρ_c = 0 时干涉项消失、状态降为 averaged") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    cfg.ground = GroundType::Water;
    cfg.roughness_m = 0.0;
    cfg.coherence_rho = 0.0;
    PropagationTerms t;
    two_ray(3000.0, 2.4405e9, 50.0, 30.0, "vertical", cfg, t);
    CHECK(t.fade == FadeState::Averaged);
    // 非相干只作功率相加：1 + r² > 1，故 C_2ray > 0 且小于 3 dB
    CHECK(t.two_ray_correction_dB > 0.0);
    CHECK(t.two_ray_correction_dB <= 3.02);
}

TEST_CASE("地表材质表逐行等于工作流文档 §3.5 的默认表") {
    CHECK(ground_params(GroundType::Paved).eps_r == 5.0);
    CHECK(ground_params(GroundType::Paved).sigma_S_per_m == 0.008);
    CHECK(ground_params(GroundType::Paved).roughness_m == 0.003);
    CHECK(ground_params(GroundType::Grass).eps_r == 15.0);
    CHECK(ground_params(GroundType::Water).eps_r == 80.0);
    CHECK(ground_params(GroundType::Water).sigma_S_per_m == 5.0);
    CHECK(ground_params(GroundType::Dirt).eps_r == 8.0);
    CHECK(ground_params(GroundType::Unknown).roughness_m == 0.005);
}

// ------------------------------------------------------------ 判据 8：统计阴影 C1–C5

TEST_CASE("C1 固定种子逐位复现") {
    std::vector<double> steps(500, 10.0);
    ShadowSequence a, b;
    SeqNormal r1(12345), r2(12345);
    a.build(steps, 5.0, 50.0, r1);
    b.build(steps, 5.0, 50.0, r2);
    REQUIRE(a.size() == b.size());
    for (std::size_t k = 0; k < a.size(); ++k) CHECK(a.at(k) == b.at(k));

    // 乱序、重复取值不改变结果
    CHECK(a.at(499) == b.at(499));
    CHECK(a.at(0) == b.at(0));
    CHECK(a.at(250) == b.at(250));
    CHECK(a.at(250) == b.at(250));
    // 越界返回最后一个值，不崩不返回 0
    CHECK(a.at(10000) == a.at(a.size() - 1));
}

TEST_CASE("C2 / C3 / C5 矩校验：经验 σ 与设定值相对差 ≤ 3%，均值近零，方差不随 k 漂移") {
    const std::size_t n = 40000;
    const double sigma = 6.0;
    // Δs ≫ d_corr ⇒ ρ → 0，退化为独立抽样（C2）
    std::vector<double> steps(n, 1000.0);
    ShadowSequence s;
    SeqNormal rng(20260910);
    s.build(steps, sigma, 50.0, rng);
    REQUIRE(s.size() == n);

    double sum = 0.0, sum2 = 0.0;
    for (std::size_t k = 0; k < n; ++k) { sum += s.at(k); sum2 += s.at(k) * s.at(k); }
    const double mean = sum / static_cast<double>(n);
    const double var = sum2 / static_cast<double>(n) - mean * mean;
    const double emp = std::sqrt(var);
    CHECK(std::fabs(emp - sigma) / sigma <= 0.03);
    CHECK(std::fabs(mean) <= 0.05 * sigma);

    // C5 平稳性：前后两半的方差都在同一档（递推的稳态方差恒为 σ²）
    double s1 = 0.0, s2 = 0.0;
    for (std::size_t k = 0; k < n / 2; ++k) s1 += s.at(k) * s.at(k);
    for (std::size_t k = n / 2; k < n; ++k) s2 += s.at(k) * s.at(k);
    const double v1 = s1 / static_cast<double>(n / 2), v2 = s2 / static_cast<double>(n / 2);
    CHECK(std::fabs(std::sqrt(v1) - sigma) / sigma <= 0.05);
    CHECK(std::fabs(std::sqrt(v2) - sigma) / sigma <= 0.05);
    MESSAGE("独立抽样 " << n << " 帧：经验 σ = " << emp << "（设定 " << sigma
            << "），均值 " << mean);
}

TEST_CASE("C4 空间相关：相邻帧相关系数与 exp(−Δs/d_corr) 相对差 ≤ 5%") {
    const std::size_t n = 60000;
    const double sigma = 5.0, dcorr = 50.0, ds = 20.0;
    std::vector<double> steps(n, ds);
    ShadowSequence s;
    SeqNormal rng(777);
    s.build(steps, sigma, dcorr, rng);

    double sxy = 0.0, sx = 0.0, sy = 0.0, sxx = 0.0, syy = 0.0;
    const std::size_t m = n - 1;
    for (std::size_t k = 1; k < n; ++k) {
        const double x = s.at(k - 1), y = s.at(k);
        sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
    }
    const double mx = sx / m, my = sy / m;
    const double cov = sxy / m - mx * my;
    const double r = cov / std::sqrt((sxx / m - mx * mx) * (syy / m - my * my));
    const double want = std::exp(-ds / dcorr);
    CHECK(std::fabs(r - want) / want <= 0.05);
    MESSAGE("Δs = " << ds << " m、d_corr = " << dcorr << " m：经验相关 " << r
            << "，理论 " << want);
}

TEST_CASE("σ 表：给了正值就用它，否则按环境与视距查表；本期只取得到 LOS 一列") {
    PropagationConfig cfg = e2_base();
    cfg.env = EnvClass::DenseUrban;
    CHECK(shadow_sigma_dB(cfg, true) == 6.0);
    CHECK(shadow_sigma_dB(cfg, false) == 10.0);     // D3 接上视距判定后才取得到
    cfg.shadow_sigma_dB = 2.5;
    CHECK(shadow_sigma_dB(cfg, true) == 2.5);
    CHECK(shadow_sigma_dB(cfg, false) == 2.5);
}

TEST_CASE("阴影是加项：extra 恰好等于样本，included 多一项 shadow") {
    PropagationConfig cfg = e2_base();
    cfg.shadow = true;
    const PropagationTerms t = combine(3000.0, 2.4405e9, 50.0, 30.0, true, "vertical", cfg, -3.25);
    CHECK(t.shadow_dB == -3.25);
    CHECK(t.extra_dB == -3.25);
    REQUIRE(t.included.size() == 2u);
    CHECK(t.included[1] == std::string(kTermShadow));
}

TEST_CASE("σ ≤ 0 或帧数为零时序列为空，at() 恒返回 0，不当作异常") {
    std::vector<double> steps(10, 5.0);
    ShadowSequence s;
    SeqNormal rng(1);
    s.build(steps, 0.0, 50.0, rng);
    CHECK(s.empty());
    CHECK(s.at(0) == 0.0);
    ShadowSequence e;
    SeqNormal rng2(1);
    e.build(std::vector<double>(), 5.0, 50.0, rng2);
    CHECK(e.empty());
}

// ------------------------------------------------------------ 组合的顺序与去重

TEST_CASE("included_loss_terms 的顺序固定，且分位裕度也算 shadow") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::UrbanEmpirical;
    cfg.urban_mode = UrbanLossMode::MeanWithShadowMargin;
    cfg.weather = true;
    cfg.rain_rate_mmh = 10.0;
    const PropagationTerms t = combine(3000.0, 2.4405e9, 50.0, 30.0, true, "vertical", cfg, 0.0);
    REQUIRE(t.included.size() == 4u);
    CHECK(t.included[0] == std::string(kTermFreeSpace));
    CHECK(t.included[1] == std::string(kTermUrbanMean));
    CHECK(t.included[2] == std::string(kTermShadow));
    CHECK(t.included[3] == std::string(kTermWeather));
}

TEST_CASE("双径 + 阴影 + 天气：extra 是三项之和，路损恒等式成立") {
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    cfg.shadow = true;
    cfg.weather = true;
    cfg.rain_rate_mmh = 5.0;
    const double d = 4000.0, f = 2.4405e9;
    const PropagationTerms t = combine(d, f, 50.0, 30.0, true, "vertical", cfg, 2.0);
    CHECK(t.extra_dB == doctest::Approx(t.primary_excess_dB + t.shadow_dB + t.weather_dB));
    CHECK(t.primary_excess_dB == doctest::Approx(-t.two_ray_correction_dB));
    CHECK(t.free_space_dB == fspl_dB(d, f));
    REQUIRE(t.included.size() == 4u);
    CHECK(t.included[1] == std::string(kTermGroundReflection));
}

TEST_CASE("枚举文本双向可逆") {
    PropLevel l; PrimaryModel p; EnvClass e; GroundType g; UrbanLossMode u;
    CHECK(parse_prop_level("E2", l));
    CHECK(std::string(to_string(l)) == "E2");
    CHECK_FALSE(parse_prop_level("e2", l));
    CHECK(parse_primary_model("two_ray", p));
    CHECK(std::string(to_string(p)) == "two_ray");
    CHECK(parse_env_class("dense_urban", e));
    CHECK(std::string(to_string(e)) == "dense_urban");
    CHECK(parse_ground_type("paved", g));
    CHECK(std::string(to_string(g)) == "paved");
    CHECK(parse_urban_loss_mode("mean_with_shadow_margin", u));
    CHECK(std::string(to_string(u)) == "mean_with_shadow_margin");
    CHECK_FALSE(parse_ground_type("asphalt", g));
}

TEST_CASE("垂直极化的伪 Brewster 凹陷：同一掠射角上 |Γ_V| 明显小于 |Γ_H|") {
    // A1 的注脚。水面 0.7° 掠射（d ≈ 814 m、收发各 5 m）：Γ_H 已经接近 −1，
    // 而 Γ_V 还在 0.8 上下，于是垂直极化的相长上界只有约 +5.1 dB。
    PropagationConfig cfg = e2_base();
    cfg.primary = PrimaryModel::TwoRay;
    cfg.ground = GroundType::Water;
    cfg.roughness_m = 0.0;
    PropagationTerms v, h;
    two_ray(814.0, 2.4405e9, 5.0, 5.0, "vertical", cfg, v);
    two_ray(814.0, 2.4405e9, 5.0, 5.0, "horizontal", cfg, h);
    CHECK(h.reflection_mag > 0.99);
    CHECK(v.reflection_mag < 0.85);
    CHECK(h.two_ray_correction_dB > v.two_ray_correction_dB);
    MESSAGE("0.7° 掠射水面：|Γ_H| = " << h.reflection_mag << "（C = " << h.two_ray_correction_dB
            << " dB），|Γ_V| = " << v.reflection_mag << "（C = " << v.two_ray_correction_dB << " dB）");
}
