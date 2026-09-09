// 测向与定位的单测（06 备忘录 §9H L-3 起；11 报告 §3.5、§9.1；决策 D-053）。
//
// 两类判据缺一不可（emcore README W4 的教训：定位 CEP 公式曾经解析看着对、蒙特卡洛才发现错）：
//   ① 解析锚点——公式本身对不对；
//   ② 蒙特卡洛——抽出来的散布与声称的 σ 是不是一回事。
// 后者正是 01 §8 跨层一致性在本线的执行形式。

#include "doctest/doctest.h"

#include <cmath>
#include <string>
#include <vector>

#include "cuav/components/locate.h"
#include "cuav/random.h"
#include <algorithm>

#include "cuav_geo/df_error.h"

using namespace cuav;

namespace {
const double kPiLocal = 3.14159265358979323846;
}  // namespace

TEST_CASE("测向误差预算：六项平方和开方，bias 不进方差") {
    geo::DfErrorBudget b;
    b.sigma_method_deg = 1.5;
    b.sigma_snr_ref_deg = 2.0;
    b.snr_ref_dB = 10.0;
    b.sigma_cal_deg = 0.5;
    b.sigma_att_deg = 0.3;
    b.sigma_mp_los_deg = 0.5;
    b.sigma_mp_nlos_deg = 5.0;
    b.sigma_mix_deg = 8.0;
    b.bias_deg = 3.0;

    // 信噪比恰在参考点：σ_snr = σ_ref
    const geo::DfSigmaParts p = geo::df_sigma_total(b, 10.0, true, false);
    CHECK(p.snr_deg == doctest::Approx(2.0));
    CHECK(p.multipath_deg == doctest::Approx(0.5));
    CHECK(p.mixture_deg == doctest::Approx(0.0));
    const double want = std::sqrt(1.5 * 1.5 + 2.0 * 2.0 + 0.5 * 0.5 + 0.3 * 0.3 + 0.5 * 0.5);
    CHECK(p.total_deg == doctest::Approx(want).epsilon(1e-12));
    // bias 不进方差：改 bias 不改 σ
    b.bias_deg = -7.0;
    CHECK(geo::df_sigma_total(b, 10.0, true, false).total_deg == doctest::Approx(want).epsilon(1e-12));

    // 非视距换多径项；混叠加第六项
    CHECK(geo::df_sigma_total(b, 10.0, false, false).multipath_deg == doctest::Approx(5.0));
    CHECK(geo::df_sigma_total(b, 10.0, true, true).mixture_deg == doctest::Approx(8.0));
}

TEST_CASE("测向误差预算：信噪比项按 √(SNR_ref/SNR) 缩放，低于 0 dB 时钳住不发散") {
    // 20 dB（比参考高 10 dB）→ σ 缩小 √10 倍
    CHECK(geo::df_sigma_snr_deg(2.0, 10.0, 20.0) == doctest::Approx(2.0 / std::sqrt(10.0)));
    // 0 dB（比参考低 10 dB）→ σ 放大 √10 倍
    CHECK(geo::df_sigma_snr_deg(2.0, 10.0, 0.0) == doctest::Approx(2.0 * std::sqrt(10.0)));
    // 负信噪比：线性值钳到 1，σ 与 0 dB 处相同，不是无穷大
    CHECK(geo::df_sigma_snr_deg(2.0, 10.0, -30.0) == doctest::Approx(2.0 * std::sqrt(10.0)));
}

TEST_CASE("测向质量分档：只看 σ；门限非降，超出末档即 invalid") {
    const std::vector<double> thr = {2.0, 5.0, 15.0, 45.0};
    CHECK(geo::df_quality_grade(1.9, thr) == "DF-Q1");
    CHECK(geo::df_quality_grade(2.0, thr) == "DF-Q2");   // 上限是开区间
    CHECK(geo::df_quality_grade(4.9, thr) == "DF-Q2");
    CHECK(geo::df_quality_grade(14.0, thr) == "DF-Q3");
    CHECK(geo::df_quality_grade(44.0, thr) == "DF-Q4");
    CHECK(geo::df_quality_grade(45.0, thr) == "invalid");
    CHECK(geo::df_quality_grade(1.0, std::vector<double>()) == "invalid");
    const std::vector<double> bad = {5.0, 2.0};
    CHECK(geo::df_quality_grade(4.0, bad) == "DF-Q1");     // 4 < 5 先命中，不到降序那一项
    CHECK(geo::df_quality_grade(6.0, bad) == "invalid");   // 走到降序项即判非法
}

TEST_CASE("测向蒙特卡洛：经验 σ 与预算 σ 差 ≤ 3%，均值偏差 ≤ 3σ/√n（11 报告 §9.1）") {
    // 直接对抽样公式做统计校验：真值 + bias + σ·N(0,1)，与组件里那一行同式。
    // 这一项检查的是「抽出来的散布与声称的 σ 是不是一回事」，即 01 §8 的跨层一致性。
    geo::DfErrorBudget b;
    const double snr = 20.0;
    const geo::DfSigmaParts p = geo::df_sigma_total(b, snr, true, false);
    Xoshiro256pp rng(20260909);
    const int n = 10000;
    double s1 = 0.0, s2 = 0.0;
    for (int i = 0; i < n; ++i) {
        const double e = p.total_deg * rng.normal();
        s1 += e;
        s2 += e * e;
    }
    const double mean = s1 / n;
    const double sd = std::sqrt(s2 / n - mean * mean);
    const double rel = std::fabs(sd - p.total_deg) / p.total_deg;
    CHECK(rel <= 0.03);
    CHECK(std::fabs(mean) <= 3.0 * p.total_deg / std::sqrt(static_cast<double>(n)));
    MESSAGE("DF 蒙特卡洛 " << n << " 次 @ SNR " << snr << " dB：预算 σ = " << p.total_deg
            << "°，经验 σ = " << sd << "°，相对差 " << rel * 100.0 << " %，均值 " << mean << "°");
}

TEST_CASE("单站测向：八个 scene 口全可选，一路都没接即 check_wiring 拒绝") {
    DirectionFinder df;
    const std::vector<PortSpec> ins = df.inputs();
    CHECK(ins.size() == 9);          // scene1..scene8 加一个可选的 det
    for (std::size_t i = 0; i < ins.size(); ++i) CHECK(ins[i].optional);
    CHECK(df.outputs().size() == 1);
    CHECK(df.outputs()[0].type == PortType::BearingReport);

    std::string err;
    std::vector<std::string> wired;
    CHECK_FALSE(df.check_wiring(wired, err));
    CHECK(err.find("至少要接一路") != std::string::npos);
    wired.push_back("det");
    CHECK_FALSE(df.check_wiring(wired, err));   // 只接检测口不算
    wired.push_back("scene3");
    CHECK(df.check_wiring(wired, err));
}

TEST_CASE("单站测向：缺场景绑定即拒，报文指向 scene_binding 而不是让它默默跑") {
    DirectionFinder df;
    std::string err;
    CHECK_FALSE(df.configure({}, {}, err));
    CHECK(err.find("scenario_path") != std::string::npos);
}

TEST_CASE("单站测向：DF-Q 的四个门限必须非降") {
    DirectionFinder df;
    std::string err;
    std::map<std::string, double> p;
    p["q_thr1_deg"] = 5.0;
    p["q_thr2_deg"] = 2.0;
    std::map<std::string, std::string> t;
    t["scenario_path"] = "/dev/null";
    CHECK_FALSE(df.configure(p, t, err));
    CHECK(err.find("非降") != std::string::npos);
}

// ---------------------------------------------- AOA 交叉定位（L-4，D-053 §3.5、§9.1）

#include "cuav_geo/locate_aoa.h"

TEST_CASE("解析锚点：两站正交交汇、各距 1 km、σ = 1° 时 σ_pos / 2σ 半轴 / CEP 三个数") {
    // 目标在原点；一站在正南 1 km（看目标方位 0°），一站在正西 1 km（看目标方位 90°）。
    // 两条测向线正交，各自的横向不确定度都是 R·σ_θ，于是协方差是 σ²I（圆形）：
    //   σ_pos = 1000 · π/180 = 17.4532925 m
    //   2σ 半轴 = 2σ_pos     = 34.906585 m
    //   CEP = 0.5887·(σ+σ)  = 1.1774·σ = 20.549... m（圆形下即 Rayleigh 中位数）
    std::vector<geo::AoaPlaneObs> obs(2);
    obs[0].x_m = 0.0;    obs[0].y_m = -1000.0;  obs[0].bearing_deg = 0.0;   obs[0].sigma_deg = 1.0;
    obs[1].x_m = -1000.0; obs[1].y_m = 0.0;     obs[1].bearing_deg = 90.0;  obs[1].sigma_deg = 1.0;

    const geo::AoaPlaneSolution s = geo::aoa_solve_plane(obs);
    REQUIRE(s.ok);
    CHECK(s.x_m == doctest::Approx(0.0).scale(1.0).epsilon(1e-9));
    CHECK(s.y_m == doctest::Approx(0.0).scale(1.0).epsilon(1e-9));

    const double sigma_pos = 1000.0 * kPiLocal / 180.0;
    CHECK(sigma_pos == doctest::Approx(17.4532925199433));
    // 协方差对角元 = σ_pos²（两轴各由一条线定），因此两个半轴都是 2σ_pos
    CHECK(std::sqrt(s.cov[0]) == doctest::Approx(sigma_pos).epsilon(1e-9));
    CHECK(std::sqrt(s.cov[2]) == doctest::Approx(sigma_pos).epsilon(1e-9));
    CHECK(std::fabs(s.cov[1]) < 1e-9);
    CHECK(s.stats.ellipse.semi_major_m == doctest::Approx(2.0 * sigma_pos).epsilon(1e-9));
    CHECK(s.stats.ellipse.semi_minor_m == doctest::Approx(2.0 * sigma_pos).epsilon(1e-9));
    CHECK(s.stats.cep_m == doctest::Approx(1.1774 * sigma_pos).epsilon(1e-9));
    MESSAGE("AOA 解析锚点：σ_pos = " << sigma_pos << " m，2σ 半轴 = " << s.stats.ellipse.semi_major_m
            << " m，CEP = " << s.stats.cep_m << " m");

    // 张角 90° → good；正交是最好的交汇几何
    CHECK(s.max_spread_deg == doctest::Approx(90.0));
    CHECK(s.quality == geo::GeometryQuality::Good);
    // 残差：无噪输入时两站都应为 0
    REQUIRE(s.residuals_deg.size() == 2);
    for (std::size_t i = 0; i < s.residuals_deg.size(); ++i) CHECK(std::fabs(s.residuals_deg[i]) < 1e-9);
}

TEST_CASE("解析锚点：2σ 椭圆的二维包含概率是 86.5%，不是一维的 95%") {
    // em-demo 的注释写「2σ (~95%)」是把一维置信搬到了二维；本项目每行报告都显式写 0.8646…
    CHECK(geo::ellipse_confidence_2sigma() == doctest::Approx(0.8646647167633873).epsilon(1e-12));
}

TEST_CASE("AOA 交汇：少于两站、或测向线平行时无解，不给一个假位置") {
    std::vector<geo::AoaPlaneObs> one(1);
    CHECK_FALSE(geo::aoa_solve_plane(one).ok);

    std::vector<geo::AoaPlaneObs> parallel(2);
    parallel[0].x_m = 0.0;   parallel[0].y_m = 0.0;    parallel[0].bearing_deg = 45.0; parallel[0].sigma_deg = 1.0;
    parallel[1].x_m = 100.0; parallel[1].y_m = 100.0;  parallel[1].bearing_deg = 45.0; parallel[1].sigma_deg = 1.0;
    CHECK_FALSE(geo::aoa_solve_plane(parallel).ok);
}

TEST_CASE("AOA 蒙特卡洛：协方差与经验散布一致，CEP 是真的 50% 半径（emcore W4 的教训）") {
    // 三站围一个目标，方位加高斯噪声后解算 1e4 次，比两件事：
    //   ① 经验协方差的迹与求解器给出的迹之比 ∈ [0.95, 1.05]；
    //   ② 经验的 50% 半径与 CEP 之比 ∈ [0.9, 1.1]。
    // 只验 ① 不够——CEP 公式曾经写成 √trace，迹对得上而 CEP 差了一大截，
    // 正是靠散布校验才发现的（EM-C-UAV 09 号方案 W4）。
    const double R = 1500.0;
    const double sigma_deg = 1.5;
    std::vector<geo::AoaPlaneObs> base(3);
    for (int i = 0; i < 3; ++i) {
        const double a = (90.0 + 120.0 * i) * kPiLocal / 180.0;   // 站在目标周围 120° 均布
        base[i].x_m = R * std::cos(a);
        base[i].y_m = R * std::sin(a);
        // 站看目标（原点）的真方位：自北顺时针 atan2(Δx, Δy)
        base[i].bearing_deg = std::fmod(std::atan2(-base[i].x_m, -base[i].y_m) * 180.0 / kPiLocal + 360.0, 360.0);
        base[i].sigma_deg = sigma_deg;
    }
    const geo::AoaPlaneSolution ref = geo::aoa_solve_plane(base);
    REQUIRE(ref.ok);
    const double pred_trace = ref.cov[0] + ref.cov[2];

    Xoshiro256pp rng(20260909);
    const int n = 10000;
    std::vector<double> rs;
    rs.reserve(n);
    double sxx = 0.0, syy = 0.0, sx = 0.0, sy = 0.0;
    for (int k = 0; k < n; ++k) {
        std::vector<geo::AoaPlaneObs> o = base;
        for (std::size_t i = 0; i < o.size(); ++i) o[i].bearing_deg += sigma_deg * rng.normal();
        const geo::AoaPlaneSolution s = geo::aoa_solve_plane(o);
        REQUIRE(s.ok);
        sx += s.x_m; sy += s.y_m;
        sxx += s.x_m * s.x_m; syy += s.y_m * s.y_m;
        rs.push_back(std::sqrt(s.x_m * s.x_m + s.y_m * s.y_m));
    }
    const double mx = sx / n, my = sy / n;
    const double emp_trace = (sxx / n - mx * mx) + (syy / n - my * my);
    const double ratio = emp_trace / pred_trace;
    CHECK(ratio >= 0.95);
    CHECK(ratio <= 1.05);

    std::sort(rs.begin(), rs.end());
    const double r50 = rs[rs.size() / 2];
    const double cepRatio = r50 / ref.stats.cep_m;
    CHECK(cepRatio >= 0.9);
    CHECK(cepRatio <= 1.1);
    MESSAGE("AOA 蒙特卡洛 " << n << " 次：协方差迹比 " << ratio
            << "，经验 50% 半径 " << r50 << " m / CEP " << ref.stats.cep_m << " m = " << cepRatio);
}

TEST_CASE("AOA 几何：最小两两交会角看得见「两条近乎平行 + 一条好线」，最大张角看不见") {
    // demo-03 上实测到的形状：两站看目标的方位只差 3.2°，第三站差 51°。
    // emcore 的分级只看**最大**张角（51° → fair，更远时 > 60° → good），
    // 完全看不出那一对近简并的线；实测那批「good」的 2σ 椭圆覆盖率只有 45%。
    std::vector<geo::AoaPlaneObs> obs(3);
    obs[0].x_m = 0.0;     obs[0].y_m = 0.0;    obs[0].bearing_deg = 210.66; obs[0].sigma_deg = 1.7;
    obs[1].x_m = 800.0;   obs[1].y_m = 600.0;  obs[1].bearing_deg = 213.81; obs[1].sigma_deg = 1.7;
    obs[2].x_m = -1200.0; obs[2].y_m = 900.0;  obs[2].bearing_deg = 261.79; obs[2].sigma_deg = 1.7;

    const geo::AoaPlaneSolution s = geo::aoa_solve_plane(obs);
    REQUIRE(s.ok);
    CHECK(s.max_spread_deg == doctest::Approx(51.13).epsilon(1e-3));
    CHECK(geo::aoa_geometry_grade(s.max_spread_deg) == geo::GeometryQuality::Fair);
    CHECK(s.min_crossing_deg == doctest::Approx(3.15).epsilon(1e-2));
    MESSAGE("最大张角 " << s.max_spread_deg << "° 判 fair，而最小交会角只有 " << s.min_crossing_deg << "°");

    // 交会角看的是两条**直线**的夹角：方位差 165° 与 15° 一样，都折到 15°。
    // 两站相向而望时最大张角接近 180°，看着「张得很开」，其实两条线快共线了。
    std::vector<geo::AoaPlaneObs> anti(2);
    anti[0].x_m = 0.0;   anti[0].y_m = 0.0;    anti[0].bearing_deg = 10.0;  anti[0].sigma_deg = 1.0;
    anti[1].x_m = 0.0;   anti[1].y_m = 2000.0; anti[1].bearing_deg = 175.0; anti[1].sigma_deg = 1.0;
    const geo::AoaPlaneSolution a = geo::aoa_solve_plane(anti);
    REQUIRE(a.ok);
    CHECK(a.max_spread_deg == doctest::Approx(165.0));
    CHECK(a.min_crossing_deg == doctest::Approx(15.0).epsilon(1e-9));
    // 最大张角 165° 会被 emcore 的分级判成最好的一档，而实际交会角只有 15°
    CHECK(geo::aoa_geometry_grade(a.max_spread_deg) == geo::GeometryQuality::Good);

    // 正交交汇是最好的：交会角 90°
    std::vector<geo::AoaPlaneObs> ortho(2);
    ortho[0].x_m = 0.0;     ortho[0].y_m = -1000.0; ortho[0].bearing_deg = 0.0;  ortho[0].sigma_deg = 1.0;
    ortho[1].x_m = -1000.0; ortho[1].y_m = 0.0;     ortho[1].bearing_deg = 90.0; ortho[1].sigma_deg = 1.0;
    CHECK(geo::aoa_solve_plane(ortho).min_crossing_deg == doctest::Approx(90.0));
}

TEST_CASE("AOA 蒙特卡洛：交会角小时协方差确实偏乐观——这是伪线性估计器的已知局限，记录不掩盖") {
    // 与上一条同一几何（最小交会角 3.15°），覆盖率明显低于 86.5%。
    // **不许为了让它「达标」去调参**（铁律 10）：正确的做法是把最小交会角作为降级判据，
    // 并在模型卡里写明有效档的范围。
    std::vector<geo::AoaPlaneObs> base(3);
    base[0].x_m = 0.0;     base[0].y_m = 0.0;    base[0].bearing_deg = 210.66; base[0].sigma_deg = 1.7;
    base[1].x_m = 800.0;   base[1].y_m = 600.0;  base[1].bearing_deg = 213.81; base[1].sigma_deg = 1.7;
    base[2].x_m = -1200.0; base[2].y_m = 900.0;  base[2].bearing_deg = 261.79; base[2].sigma_deg = 1.7;
    const geo::AoaPlaneSolution truth = geo::aoa_solve_plane(base);
    REQUIRE(truth.ok);

    Xoshiro256pp rng(20260909);
    const int n = 4000;
    int inside = 0;
    for (int k = 0; k < n; ++k) {
        std::vector<geo::AoaPlaneObs> o = base;
        for (std::size_t i = 0; i < o.size(); ++i) o[i].bearing_deg += o[i].sigma_deg * rng.normal();
        const geo::AoaPlaneSolution s = geo::aoa_solve_plane(o);
        if (!s.ok) continue;
        const double dx = truth.x_m - s.x_m;
        const double dy = truth.y_m - s.y_m;
        const double rot = s.stats.ellipse.rotation_deg * kPiLocal / 180.0;
        const double u = dx * std::cos(rot) + dy * std::sin(rot);
        const double v = -dx * std::sin(rot) + dy * std::cos(rot);
        const double a = s.stats.ellipse.semi_major_m;
        const double b = s.stats.ellipse.semi_minor_m;
        if ((u / a) * (u / a) + (v / b) * (v / b) <= 1.0) ++inside;
    }
    const double cov = static_cast<double>(inside) / n;
    // 只钉住「确实偏乐观」这个事实，不钉具体数值——它随几何而变
    CHECK(cov < 0.84);
    MESSAGE("最小交会角 " << truth.min_crossing_deg << "° 时 2σ 覆盖率 " << cov * 100.0
            << " %（理论 86.5%）——伪线性 AOA 估计器在近简并几何下协方差偏乐观");
}

// ---------------------------------------------- TDOA 时差定位（L-5，D-053 §3.5、§9.1）

#include "cuav_geo/locate_tdoa.h"

TEST_CASE("解析锚点：三站等边三角形、源在质心时不加权 GDOP = √(8/9) = 0.942809") {
    // 三站等边、源在质心：三个视线单位向量夹角 120°。以任一站为参考的两行雅可比
    // H_i = û_i − û_0 构成的 (HᵀH)⁻¹ 迹为 8/9，故 GDOP = √(8/9)。
    const double R = 2000.0;
    std::vector<geo::ToaPlaneObs> obs(3);
    for (int i = 0; i < 3; ++i) {
        const double a = (90.0 + 120.0 * i) * kPiLocal / 180.0;
        obs[i].x_m = R * std::cos(a);
        obs[i].y_m = R * std::sin(a);
        // 源在质心（原点）：三站等距，到达时刻相同
        obs[i].toa_s = R / geo::kSpeedOfLightExact;
        obs[i].sigma_pick_s = 1e-9;
        obs[i].sigma_sync_s = 3e-9;
    }
    // 从真解出发，免得迭代把无噪的对称解推走
    const double zx = 0.0, zy = 0.0;
    const geo::TdoaPlaneSolution s = geo::tdoa_solve_plane(
        obs, 0, geo::TdoaWeighting::CorrelatedReference, &zx, &zy);
    REQUIRE(s.ok);
    CHECK(s.x_m == doctest::Approx(0.0).scale(1.0).epsilon(1e-6));
    CHECK(s.y_m == doctest::Approx(0.0).scale(1.0).epsilon(1e-6));
    CHECK(s.gdop == doctest::Approx(std::sqrt(8.0 / 9.0)).epsilon(1e-9));
    CHECK(std::sqrt(8.0 / 9.0) == doctest::Approx(0.9428090415820634));
    CHECK(s.geometry_quality == geo::GeometryQuality::Good);
    MESSAGE("TDOA 解析锚点：等边三角形质心处 GDOP = " << s.gdop << "（= √(8/9)）");
}

TEST_CASE("TDOA：少于三站无解；可行性违例降级但不剔除（EM-S-07 §10.4）") {
    std::vector<geo::ToaPlaneObs> two(2);
    CHECK_FALSE(geo::tdoa_solve_plane(two, 0, geo::TdoaWeighting::CorrelatedReference).ok);

    // 造一个可行性违例：把一站的到达时刻推到超过基线所能解释的程度。
    // 用**四站**而不是三站：三站时只有两条约束，|Δr| 越过基线正好是双曲线退化的地方，
    // 解会直接奇异（实测扫过：Δr 3598 m 时 ok = false）——那种情形本来就该判无解，
    // 而这一条要验的是「越线但还解得出来时仍给解、只标降级」。四站有冗余，留得住解。
    const double R = 2000.0;
    std::vector<geo::ToaPlaneObs> obs(4);
    for (int i = 0; i < 4; ++i) {
        const double a = (90.0 + 90.0 * i) * kPiLocal / 180.0;
        obs[i].x_m = R * std::cos(a);
        obs[i].y_m = R * std::sin(a);
        obs[i].toa_s = R / geo::kSpeedOfLightExact;
        obs[i].sigma_pick_s = 1e-9;
        obs[i].sigma_sync_s = 3e-9;
    }
    // 违例放在**短基线**那一对上：参考站到相邻站是 2828 m（正方形边长），到对角站是 4000 m。
    // 3.0 km 的距离差对相邻站已越线，而系统整体还解得出来。
    obs[1].toa_s += 1.05e-5;
    const geo::TdoaPlaneSolution s = geo::tdoa_solve_plane(obs, 0, geo::TdoaWeighting::CorrelatedReference,
                                                          0, 0, 50.0);
    REQUIRE(s.ok);                                  // 仍出解
    CHECK(s.feasibility_violations >= 1);           // 但记下违例
    CHECK(s.geometry_quality == geo::GeometryQuality::Poor);
    CHECK(s.time_quality == geo::TimeQuality::TQ4);
}

TEST_CASE("TDOA 时统分级：站钟越差档位越低，保持态与失锁看得出来") {
    CHECK(geo::tdoa_time_grade(3.0, 1.0, false) == geo::TimeQuality::TQ1);
    CHECK(geo::tdoa_time_grade(10.0, 1.0, false) == geo::TimeQuality::TQ2);   // > 5 ns
    CHECK(geo::tdoa_time_grade(3.0, 3.0, false) == geo::TimeQuality::TQ2);    // χ² > 2
    CHECK(geo::tdoa_time_grade(50.0, 1.0, false) == geo::TimeQuality::TQ3);   // > 30 ns
    CHECK(geo::tdoa_time_grade(200.0, 1.0, false) == geo::TimeQuality::TQ4);  // > 100 ns
    CHECK(geo::tdoa_time_grade(3.0, 1.0, true) == geo::TimeQuality::TQ4);     // 可行性违例
    CHECK(std::string(geo::to_string(geo::TimeQuality::TQ1)) == "TQ-1");
}

TEST_CASE("TDOA 两种加权：相关参考站的协方差自洽，独立站对保守偏大——数值进模型卡，不调参") {
    // 判据是「经验协方差的迹 / 求解器给出的迹」，两种加权用**同一样本**，差别才只来自加权。
    //
    // **实测纠正了计划里的一个假设**（11 报告 §11.3）：原以为「参考站的噪声进了每个站对，
    // 按独立处理会低估协方差、结果偏乐观」。真跑下来方向相反——independent_pairs 的
    // 迹比在 0.755–0.915（五种站数与 σ 配比都试过），即它报的协方差**比实际散布大**，
    // 是保守而不是乐观；而且站数 ≥ 4 时它的估计本身也略差（没用上噪声的相关结构）。
    // correlated_reference 的迹比 1.004–1.013，自洽。
    // 两个口径都保留、数值都进模型卡，**不许调参使二者一致**（铁律 10）。
    const double R = 2000.0;
    std::vector<geo::ToaPlaneObs> base(4);
    for (int i = 0; i < 4; ++i) {
        const double a = (90.0 + 90.0 * i) * kPiLocal / 180.0;
        base[i].x_m = R * std::cos(a);
        base[i].y_m = R * std::sin(a);
        base[i].toa_s = R / geo::kSpeedOfLightExact;
        base[i].sigma_pick_s = 2e-9;
        base[i].sigma_sync_s = 5e-9;
    }
    const double zx = 0.0, zy = 0.0;
    Xoshiro256pp rng(20260909);
    const int n = 6000;
    double ratios[2] = {0.0, 0.0};
    const geo::TdoaWeighting modes[2] = {geo::TdoaWeighting::CorrelatedReference,
                                         geo::TdoaWeighting::IndependentPairs};
    for (int m = 0; m < 2; ++m) {
        Xoshiro256pp r2(20260909);       // 两种加权用同一样本，差别才只来自加权
        const geo::TdoaPlaneSolution ref = geo::tdoa_solve_plane(base, 0, modes[m], &zx, &zy);
        REQUIRE(ref.ok);
        const double pred = ref.cov[0] + ref.cov[2];
        double sx = 0.0, sy = 0.0, sxx = 0.0, syy = 0.0;
        int got = 0;
        for (int k = 0; k < n; ++k) {
            std::vector<geo::ToaPlaneObs> o = base;
            // 站钟误差是每站一个、拾取误差也是每站一个；参考站的那一份进每个站对，
            // 这正是「站对之间相关」的来源
            for (std::size_t i = 0; i < o.size(); ++i) {
                o[i].toa_s += o[i].sigma_pick_s * r2.normal() + o[i].sigma_sync_s * r2.normal();
            }
            const geo::TdoaPlaneSolution s = geo::tdoa_solve_plane(o, 0, modes[m], &zx, &zy);
            if (!s.ok) continue;
            sx += s.x_m; sy += s.y_m;
            sxx += s.x_m * s.x_m; syy += s.y_m * s.y_m;
            ++got;
        }
        const double mx = sx / got, my = sy / got;
        const double emp = (sxx / got - mx * mx) + (syy / got - my * my);
        ratios[m] = emp / pred;
    }
    MESSAGE("TDOA 加权对比：correlated_reference 迹比 " << ratios[0]
            << "，independent_pairs 迹比 " << ratios[1] << "（同一样本）");
    CHECK(ratios[0] >= 0.95);
    CHECK(ratios[0] <= 1.05);
    // 独立站对：报的协方差比实际散布大 → 迹比明显小于 1，也明显小于相关口径
    CHECK(ratios[1] < 0.95);
    CHECK(ratios[1] < ratios[0]);
    (void)rng;
}
