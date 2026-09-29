// OFDM 族波形的单测（Q-2，14 号报告 §2，决策 D-088）。
//
// 分组：
//   ① 预设表：geo/src/radiator_presets.cpp 与 models/radiator/presets-v1.json 逐项相同，
//      且表文件的 sha256 与生成时记下的一致（防「改了 JSON 忘了重生成」）；
//   ② 原生率调制器（engine/src/ofdm.cpp）：缓存旋转因子的 FFT 与原版逐位相同、结构性质
//      （子载波数、CP、ZC 功率）、对 Python 参考与 MATLAB 一方的黄金基准（算法核尺度 1e-9）。
//   ③ 重采样原型表（models/radiator/fir_rsmp_v1.json）：逐位、结构约束、按赫兹的物理锚点；
//   ④ 有理重采样封装（engine/src/resampler.cpp + Coder 核）：对 Python 与 MATLAB 两方、冲激对齐。
//   ⑤ 帧排布（geo/src/ofdm_frame.cpp）：整张突发表对 Python 复刻逐位相同、随机访问 = 顺序铺开。
// 源的生成路径的用例随后续步骤加在这里。

#include <cmath>
#include <complex>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "cuav/dsp.h"
#include "cuav/ofdm.h"
#include "cuav/random.h"
#include "cuav/resampler.h"
#include "cuav/sha256.h"
#include "cuav_geo/ofdm_frame.h"
#include "cuav_geo/radiator_presets.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif

std::string repo_path(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

std::string read_bytes(const std::string& path) {
    std::ifstream f(path.c_str(), std::ios::binary);
    REQUIRE_MESSAGE(f.good(), "读不到 " << path);
    return std::string(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
}

int bits_per_axis(const std::string& c) {
    if (c == "qpsk") return 1;
    if (c == "16qam") return 2;
    if (c == "64qam") return 3;
    return -1;
}
}  // namespace

TEST_CASE("预设表：生成的 C++ 与 models/radiator/presets-v1.json 逐项相同") {
    const std::string raw = read_bytes(repo_path("models/radiator/presets-v1.json"));
    CHECK_MESSAGE(sha256_hex(raw) == std::string(geo::radiator_presets_v1_sha256()),
                  "表文件变了而 C++ 没重生成：uv run --quiet python scripts/gen_radiator_presets.py");
    const nlohmann::json j = nlohmann::json::parse(raw);
    CHECK(j.at("schema").get<std::string>() == "cuav-radiator-presets/1");

    std::vector<nlohmann::json> nums;
    for (const auto& n : j.at("numerologies")) nums.push_back(n);
    auto find_num = [&](const std::string& id) -> const nlohmann::json& {
        for (const auto& n : nums)
            if (n.at("id").get<std::string>() == id) return n;
        FAIL("未知数值结构 " << id);
        return nums.front();
    };

    const auto& ps = j.at("presets");
    REQUIRE(ps.size() == geo::radiator_preset_v1_count());
    for (std::size_t i = 0; i < ps.size(); ++i) {
        const auto& p = ps[i];
        const std::string id = p.at("id").get<std::string>();
        CAPTURE(id);
        const geo::RadiatorPreset* c = geo::radiator_preset_v1(id);
        REQUIRE(c != 0);
        CHECK(c == &geo::radiator_preset_v1_at(i));  // 顺序与 JSON 相同
        CHECK(std::string(c->type) == p.at("type").get<std::string>());
        CHECK(std::string(c->role) == p.at("role").get<std::string>());
        CHECK(std::string(c->credibility) == p.at("credibility").get<std::string>());
        const auto& n = find_num(p.at("numerology").get<std::string>());
        CHECK(c->fft_size == n.at("fft_size").get<int>());
        CHECK(c->fs_native_Hz == n.at("fs_native_Hz").get<double>());
        CHECK(c->subcarrier_spacing_Hz == n.at("subcarrier_spacing_Hz").get<double>());
        CHECK(c->half_subcarriers == p.at("half_subcarriers").get<int>());
        CHECK(c->occupied_bw_Hz == p.at("occupied_bw_Hz").get<double>());
        CHECK(c->occupied_bw_Hz == (2 * c->half_subcarriers + 1) * c->subcarrier_spacing_Hz);
        CHECK(c->bits_per_axis == bits_per_axis(p.at("constellation").get<std::string>()));

        const auto& bs = p.at("bursts");
        REQUIRE(c->n_bursts == static_cast<int>(bs.size()));
        for (int b = 0; b < c->n_bursts; ++b) {
            const auto& jb = bs[static_cast<std::size_t>(b)];
            const geo::RadiatorBurst& cb = c->bursts[b];
            REQUIRE(cb.n_symbols == jb.at("n_symbols").get<int>());
            const int cs = jb.count("cp_short") ? jb.at("cp_short").get<int>() : n.at("cp_short").get<int>();
            const int cl = jb.count("cp_long") ? jb.at("cp_long").get<int>() : n.at("cp_long").get<int>();
            std::vector<int> want_cp(static_cast<std::size_t>(cb.n_symbols), cs);
            for (const auto& li : jb.at("cp_long_at")) want_cp[li.get<std::size_t>()] = cl;
            std::vector<int> want_zc(static_cast<std::size_t>(cb.n_symbols), 0);
            for (const auto& z : jb.at("zc")) want_zc[z.at(0).get<std::size_t>()] = z.at(1).get<int>();
            std::int64_t len = 0;
            for (int s = 0; s < cb.n_symbols; ++s) {
                CHECK(cb.cp[s] == want_cp[static_cast<std::size_t>(s)]);
                CHECK(cb.zc_root[s] == want_zc[static_cast<std::size_t>(s)]);
                len += c->fft_size + cb.cp[s];
            }
            CHECK(cb.length_n == len);
        }

        const double slot = p.at("frame").at("slot_s").get<double>() * c->fs_native_Hz;
        CHECK(static_cast<double>(c->slot_n) == slot);  // 整数个原生样点，逐位
        const auto& cyc = p.at("frame").at("cycle");
        REQUIRE(c->cycle_len == static_cast<int>(cyc.size()));
        for (int r = 0; r < c->cycle_len; ++r) {
            const auto& row = cyc[static_cast<std::size_t>(r)];
            REQUIRE(row.size() == static_cast<std::size_t>(c->n_bursts + 1));
            for (int k = 0; k <= c->n_bursts; ++k)
                CHECK(c->cycle[r * (c->n_bursts + 1) + k] == row[static_cast<std::size_t>(k)].get<double>());
        }
    }
    CHECK(geo::radiator_preset_v1("no-such-preset") == 0);
}

TEST_CASE("预设表：DroneID 的结构逐项对 NDSS 2023 §III-B") {
    const geo::RadiatorPreset* d = geo::radiator_preset_v1("dji-droneid");
    REQUIRE(d != 0);
    CHECK(std::string(d->type) == "droneid");
    CHECK(d->fft_size == 1024);
    CHECK(d->fs_native_Hz == 15360000.0);
    CHECK(d->half_subcarriers == 300);           // 600 数据 + 1 直流
    REQUIRE(d->n_bursts == 1);
    const geo::RadiatorBurst& b = d->bursts[0];
    REQUIRE(b.n_symbols == 9);
    const int cp[9] = {80, 72, 72, 72, 72, 72, 72, 72, 80};
    const int zc[9] = {0, 0, 0, 600, 0, 147, 0, 0, 0};
    for (int s = 0; s < 9; ++s) {
        CHECK(b.cp[s] == cp[s]);
        CHECK(b.zc_root[s] == zc[s]);
    }
    CHECK(b.length_n == 9880);                   // 643.23 µs
    CHECK(d->slot_n == 9830400);                 // 640 ms
}

// ---------------------------------------------------------------- ② 原生率调制器

TEST_CASE("FftPlan：与 fft_inplace(double) 逐位相同") {
    Xoshiro256pp rng(77);
    for (std::size_t n : {std::size_t(8), std::size_t(1024), std::size_t(2048), std::size_t(4096)}) {
        std::vector<std::complex<double>> a(n);
        for (std::size_t i = 0; i < n; ++i) a[i] = std::complex<double>(rng.normal(), rng.normal());
        std::vector<std::complex<double>> b = a;
        dsp::fft_inplace(a);
        dsp::FftPlan plan(n);
        plan.forward(b);
        bool same = true;
        for (std::size_t i = 0; i < n; ++i)
            same = same && a[i].real() == b[i].real() && a[i].imag() == b[i].imag();
        CHECK_MESSAGE(same, "n = " << n);
    }
    CHECK_THROWS(dsp::FftPlan(1000));
}

TEST_CASE("调制器：每个符号恰 2K 个非零子载波、直流空、CP 逐位循环、ZC 符号功率恰为 1") {
    for (std::size_t pi = 0; pi < geo::radiator_preset_v1_count(); ++pi) {
        const geo::RadiatorPreset& p = geo::radiator_preset_v1_at(pi);
        CAPTURE(p.id);
        ofdm::Modulator m;
        std::string err;
        REQUIRE(m.init(p, err));
        for (int v = 0; v < p.n_bursts; ++v) {
            std::vector<std::complex<double>> y;
            m.burst(v, 12345u + static_cast<unsigned>(v), y);
            REQUIRE(static_cast<std::int64_t>(y.size()) == p.bursts[v].length_n);
            const std::size_t N = static_cast<std::size_t>(p.fft_size);
            std::size_t off = 0;
            for (int s = 0; s < p.bursts[v].n_symbols; ++s) {
                const std::size_t cp = static_cast<std::size_t>(p.bursts[v].cp[s]);
                std::vector<std::complex<double>> sym(y.begin() + static_cast<long>(off + cp),
                                                      y.begin() + static_cast<long>(off + cp + N));
                for (std::size_t i = 0; i < cp; ++i) REQUIRE(y[off + i] == sym[N - cp + i]);
                std::vector<std::complex<double>> X = sym;
                dsp::fft_inplace(X);
                int nz = 0;
                for (std::size_t i = 0; i < N; ++i) nz += std::abs(X[i]) > 1e-6 ? 1 : 0;
                CHECK(nz == 2 * p.half_subcarriers);
                CHECK(std::abs(X[0]) < 1e-9);
                if (p.bursts[v].zc_root[s] != 0) {
                    double pw = 0.0;
                    for (std::size_t i = 0; i < N; ++i) pw += std::norm(sym[i]);
                    CHECK(std::fabs(pw / static_cast<double>(N) - 1.0) < 1e-12);
                }
                off += cp + N;
            }
        }
    }
}

TEST_CASE("调制器：ZC 相位下标按整数取模（大下标不失真）") {
    // n = 2400、根 29、长 2401：u·n(n+1) ≈ 1.7e8，直接乘 π 再取 cos 会在 1e-9 量级上失真
    const std::complex<double> z = ofdm::zc_value(29, 2401, 2400);
    CHECK(std::fabs(std::abs(z) - 1.0) < 1e-15);
    // n(n+1) = 2400·2401 ≡ 0 (mod 2·2401) —— 恰为 1
    CHECK(z.real() == 1.0);
    CHECK(z.imag() == 0.0);
}

namespace {
void check_ofdm_golden(const nlohmann::json& g, const std::string& who) {
    const double tol = g.at("tolerance").at("kernel_rel").get<double>();
    double worst_all = 0.0;
    for (const auto& c : g.at("cases")) {
        const std::string pid = c.at("preset").get<std::string>();
        CAPTURE(who);
        CAPTURE(pid);
        const geo::RadiatorPreset* p = geo::radiator_preset_v1(pid);
        REQUIRE(p != 0);
        ofdm::Modulator m;
        std::string err;
        REQUIRE(m.init(*p, err));
        const int v = c.at("variant").get<int>();
        std::vector<std::complex<double>> y;
        m.burst(v, c.at("seed").get<std::uint64_t>(), y);
        if (c.count("burst_length")) CHECK(static_cast<int>(y.size()) == c.at("burst_length").get<int>());
        Xoshiro256pp rng(c.at("seed").get<std::uint64_t>());
        std::vector<std::complex<double>> carriers;
        int next_sym = 0;
        for (const auto& sym : c.at("symbols")) {
            const int s = sym.at("symbol").get<int>();
            // 把随机源推进到第 s 个符号：前面的数据符号每个耗 2K 个 next_u64
            for (; next_sym <= s; ++next_sym) m.symbol_carriers(v, next_sym, rng, carriers);
            if (sym.count("carriers")) {
                const auto& jc = sym.at("carriers");
                REQUIRE(jc.size() == carriers.size());
                bool same = true;
                for (std::size_t i = 0; i < carriers.size(); ++i)
                    same = same && carriers[i].real() == jc[i][0].get<double>() &&
                           carriers[i].imag() == jc[i][1].get<double>();
                CHECK_MESSAGE(same, "符号 " << s << " 的子载波值应逐位相同");
            }
            const std::size_t start = sym.at("start").get<std::size_t>();
            const auto& js = sym.at("samples");
            double ss = 0.0, worst = 0.0;
            for (std::size_t i = 0; i < js.size(); ++i) {
                const std::complex<double> w(js[i][0].get<double>(), js[i][1].get<double>());
                ss += std::norm(w);
                worst = std::max(worst, std::abs(y[start + i] - w));
            }
            const double rms = std::sqrt(ss / static_cast<double>(js.size()));
            CHECK_MESSAGE(worst / rms <= tol, "符号 " << s << "：max|差|/rms = " << worst / rms);
            worst_all = std::max(worst_all, worst / rms);
        }
    }
    MESSAGE(who << "：max|差|/rms 最差 " << worst_all);
}
}  // namespace

TEST_CASE("调制器：对 Python 参考（numpy ifft）的黄金基准，算法核尺度 1e-9") {
    const std::string raw = read_bytes(repo_path("engine/tests/golden/ofdm.json"));
    const nlohmann::json g = nlohmann::json::parse(raw);
    CHECK_MESSAGE(g.at("presets").at("sha256").get<std::string>() ==
                      std::string(geo::radiator_presets_v1_sha256()),
                  "黄金基准是按旧预设表生成的：uv run --quiet --with numpy python "
                  "algos/reference/gen_engine_golden.py --mode ofdm -o engine/tests/golden/ofdm.json");
    check_ofdm_golden(g, "python");
}

TEST_CASE("调制器：对 MATLAB 一方（通信工具箱 ofdmmod）的黄金基准，算法核尺度 1e-9") {
    const nlohmann::json g = nlohmann::json::parse(read_bytes(repo_path("engine/tests/golden/ofdm.matlab.json")));
    // 防陈旧：MATLAB 一方记着它生成那一刻读到的预设表与脚本的 sha256
    CHECK_MESSAGE(g.at("guards").at("presets_sha256").get<std::string>() ==
                      std::string(geo::radiator_presets_v1_sha256()),
                  "预设表变了而 MATLAB 一方没重跑：MATLAB_ROOT=<MATLAB 安装目录> sh matlab/run_matlab.sh");
    for (const auto& h : g.at("guards").at("source_m_sha256")) {
        const std::string rel = h.at("path").get<std::string>();
        CHECK_MESSAGE(sha256_hex(read_bytes(repo_path(rel))) == h.at("sha256").get<std::string>(),
                      rel << " 改过而 MATLAB 一方没重跑");
    }
    CHECK(g.at("matlab_vs_python_max_rel").get<double>() <= 1e-9);
    check_ofdm_golden(g, "matlab");
}

// ---------------------------------------------------------------- ③ 重采样原型表

TEST_CASE("重采样表：编译进来的表与 models/radiator/fir_rsmp_v1.json 逐位相同") {
    const std::string raw = read_bytes(repo_path("models/radiator/fir_rsmp_v1.json"));
    CHECK_MESSAGE(sha256_hex(raw) == std::string(dsp::rsmp_fir_v1_sha256()),
                  "表文件变了而 C++ 没重生成：uv run --quiet python scripts/gen_fir_taps.py --kind rsmp");
    const nlohmann::json j = nlohmann::json::parse(raw);
    const auto& e = j.at("entries").at(0);
    const dsp::RsmpTable& t = dsp::rsmp_fir_v1();
    CHECK(t.interp == e.at("interp_L").get<int>());
    CHECK(t.taps_per_phase == e.at("taps_per_phase").get<int>());
    CHECK(t.ntaps == e.at("ntaps").get<int>());
    CHECK(t.group_delay == e.at("group_delay_proto").get<int>());
    const auto& half = e.at("half");
    REQUIRE(half.size() == static_cast<std::size_t>((t.ntaps + 1) / 2));
    bool same = true;
    for (std::size_t k = 0; k < half.size(); ++k) same = same && t.half[k] == half[k].get<double>();
    CHECK(same);
}

TEST_CASE("重采样表：结构约束（N = L·T+1、T 偶、群时延 T/2 个原生样点、直流增益 L）") {
    const dsp::RsmpTable& t = dsp::rsmp_fir_v1();
    CHECK(t.ntaps == t.interp * t.taps_per_phase + 1);
    CHECK(t.taps_per_phase % 2 == 0);
    CHECK(t.group_delay == t.interp * t.taps_per_phase / 2);
    CHECK(t.group_delay % t.interp == 0);
    // 两个突发之间的最小间隔要盖住滤波器的整个支撑，两个突发的输出才不会重叠（D-088 ⑦）
    CHECK(t.taps_per_phase + 2 <= geo::kBurstMinGapNative);
    std::vector<double> h;
    dsp::rsmp_fir_expand(t, h);
    double sum = 0.0;
    for (std::size_t k = 0; k < h.size(); ++k) sum += h[k];
    CHECK(std::fabs(sum - t.interp) <= 1e-12 * t.interp);
    for (std::size_t k = 0; k < h.size(); ++k) REQUIRE(h[k] == h[h.size() - 1 - k]);
}

namespace {
// 原型滤波器在「相对原生采样率 fs_n 的频率 f_rel」处的增益（dB，已除以 L）。
double rsmp_gain_dB(double f_rel) {
    const dsp::RsmpTable& t = dsp::rsmp_fir_v1();
    std::vector<double> h;
    dsp::rsmp_fir_expand(t, h);
    std::complex<double> acc(0.0, 0.0);
    for (std::size_t n = 0; n < h.size(); ++n) {
        const double ang = -2.0 * 3.14159265358979323846 * f_rel * static_cast<double>(n) / t.interp;
        acc += h[n] * std::complex<double>(std::cos(ang), std::sin(ang));
    }
    return 20.0 * std::log10(std::abs(acc) / t.interp);
}
}  // namespace

TEST_CASE("重采样表：物理锚点（按赫兹量，20 MHz 档 fs_n = 30.72 MHz）") {
    // M-2 的教训：设计脚本拿自己那套带边去量，量不出「周 / 样点与奈奎斯特归一」差的那个 2。
    // 这里按赫兹换算，与设计脚本无关。
    const double fs_n = 30.72e6;
    const double edge = 600 * 15e3;                  // 最高子载波 9.0 MHz
    CHECK(std::fabs(rsmp_gain_dB(edge / fs_n)) < 0.05);
    CHECK(std::fabs(rsmp_gain_dB(0.0)) < 1e-9);
    CHECK(rsmp_gain_dB(15.36e6 / fs_n) < -60.0);     // 原生奈奎斯特
    CHECK(rsmp_gain_dB((fs_n - edge) / fs_n) < -60.0);   // 第一镜像的下沿 21.72 MHz
    CHECK(rsmp_gain_dB((fs_n + edge) / fs_n) < -60.0);
}

// ---------------------------------------------------------------- ④ 有理重采样封装

namespace {
// 站点样点 [m_lo, m_hi) 的输出：原生序列 x 从原生序号 x0 起，其余按 0。逐拍调 Coder 核。
std::vector<std::complex<double>> resample_range(const RationalResampler& r,
                                                 const std::vector<std::complex<double>>& x,
                                                 std::int64_t x0, std::int64_t m_lo, std::int64_t m_hi) {
    const std::int64_t L = r.interp();
    std::vector<std::complex<double>> out;
    std::vector<std::complex<double>> win(static_cast<std::size_t>(r.window_len()));
    std::vector<std::complex<double>> y(static_cast<std::size_t>(L));
    std::int64_t have = -1;
    for (std::int64_t m = m_lo; m < m_hi; ++m) {
        const std::int64_t c = m >= 0 ? m / L : -((-m + L - 1) / L);
        if (c != have) {
            const std::int64_t ws = r.window_start(c);
            for (std::int64_t j = 0; j < r.window_len(); ++j) {
                const std::int64_t n = ws + j - x0;
                win[static_cast<std::size_t>(j)] =
                    (n >= 0 && n < static_cast<std::int64_t>(x.size())) ? x[static_cast<std::size_t>(n)]
                                                                         : std::complex<double>(0.0, 0.0);
            }
            r.cycle(&win[0], &y[0]);
            have = c;
        }
        out.push_back(y[static_cast<std::size_t>(m - c * L)]);
    }
    return out;
}

double rel_err(const std::vector<std::complex<double>>& got, const nlohmann::json& want) {
    REQUIRE(got.size() == want.size());
    double ss = 0.0, worst = 0.0;
    for (std::size_t i = 0; i < got.size(); ++i) {
        const std::complex<double> w(want[i][0].get<double>(), want[i][1].get<double>());
        ss += std::norm(w);
        worst = std::max(worst, std::abs(got[i] - w));
    }
    return worst / std::sqrt(ss / static_cast<double>(got.size()));
}
}  // namespace

TEST_CASE("有理重采样：支持的抽取比与冻结表一致，其余报错并列出可取值") {
    const nlohmann::json j = nlohmann::json::parse(read_bytes(repo_path("models/radiator/fir_rsmp_v1.json")));
    std::vector<int> want;
    for (const auto& m : j.at("spec").at("decim_M_supported")) want.push_back(m.get<int>());
    CHECK(rsmp_supported_decim() == want);
    RationalResampler r;
    std::string err;
    CHECK_FALSE(r.init(25, err));
    CHECK(err.find("24 / 48 / 96") != std::string::npos);
    for (int m : want) CHECK(r.init(m, err));
}

TEST_CASE("有理重采样：Coder 核对 Python 参考（直接型）与 MATLAB 一方（入口 + upfirdn），1e-9") {
    const nlohmann::json g = nlohmann::json::parse(read_bytes(repo_path("engine/tests/golden/rsmp.json")));
    CHECK(g.at("fir").at("table_sha256").get<std::string>() == std::string(dsp::rsmp_fir_v1_sha256()));
    const nlohmann::json gm = nlohmann::json::parse(read_bytes(repo_path("engine/tests/golden/rsmp.matlab.json")));
    CHECK_MESSAGE(gm.at("guards").at("table_sha256").get<std::string>() == std::string(dsp::rsmp_fir_v1_sha256()),
                  "冻结表变了而 MATLAB 一方没重跑：MATLAB_ROOT=<MATLAB 安装目录> sh matlab/run_matlab.sh");
    for (const auto& h : gm.at("guards").at("source_m_sha256")) {
        const std::string rel = h.at("path").get<std::string>();
        CHECK_MESSAGE(sha256_hex(read_bytes(repo_path(rel))) == h.at("sha256").get<std::string>(),
                      rel << " 改过而 MATLAB 一方没重跑");
    }
    const double tol = g.at("tolerance").at("kernel_rel").get<double>();
    double worst_py = 0.0, worst_ml = 0.0;
    const auto& kc = g.at("kernel_check");
    const auto& kcm = gm.at("kernel_check");
    REQUIRE(kc.size() == kcm.size());
    for (std::size_t i = 0; i < kc.size(); ++i) {
        const int M = kc[i].at("M").get<int>();
        CAPTURE(M);
        RationalResampler r;
        std::string err;
        REQUIRE(r.init(M, err));
        const auto& jw = kc[i].at("window");
        REQUIRE(jw.size() == static_cast<std::size_t>(r.window_len()));
        std::vector<std::complex<double>> win(jw.size());
        for (std::size_t k = 0; k < jw.size(); ++k) win[k] = std::complex<double>(jw[k][0].get<double>(), jw[k][1].get<double>());
        CHECK(kc[i].at("window_start").get<std::int64_t>() == r.window_start(kc[i].at("cycle").get<std::int64_t>()));
        std::vector<std::complex<double>> y(static_cast<std::size_t>(r.interp()));
        r.cycle(&win[0], &y[0]);
        const double ep = rel_err(y, kc[i].at("expected"));
        const double em = rel_err(y, kcm[i].at("expected"));
        CHECK(ep <= tol);
        CHECK(em <= tol);
        worst_py = std::max(worst_py, ep);
        worst_ml = std::max(worst_ml, em);
    }
    MESSAGE("有理重采样核：对 Python " << worst_py << "、对 MATLAB " << worst_ml);
}

TEST_CASE("有理重采样：真实上行突发整段重采样，对 Python 参考 1e-9") {
    const nlohmann::json g = nlohmann::json::parse(read_bytes(repo_path("engine/tests/golden/rsmp.json")));
    const auto& b = g.at("burst");
    const geo::RadiatorPreset* p = geo::radiator_preset_v1(b.at("preset").get<std::string>());
    REQUIRE(p != 0);
    ofdm::Modulator mod;
    std::string err;
    REQUIRE(mod.init(*p, err));
    std::vector<std::complex<double>> x;
    mod.burst(b.at("variant").get<int>(), b.at("seed").get<std::uint64_t>(), x);
    REQUIRE(static_cast<int>(x.size()) == b.at("native_length").get<int>());
    RationalResampler r;
    REQUIRE(r.init(b.at("M").get<int>(), err));
    const std::int64_t n0 = b.at("native_start").get<std::int64_t>();
    const std::int64_t hs = b.at("head_start").get<std::int64_t>();
    const std::int64_t ts = b.at("tail_start").get<std::int64_t>();
    const std::size_t keep = b.at("head").size();
    const double tol = g.at("tolerance").at("kernel_rel").get<double>();
    const double eh = rel_err(resample_range(r, x, n0, hs, hs + static_cast<std::int64_t>(keep)), b.at("head"));
    const double et = rel_err(resample_range(r, x, n0, ts, ts + static_cast<std::int64_t>(keep)), b.at("tail"));
    CHECK(eh <= tol);
    CHECK(et <= tol);
    MESSAGE("上行突发重采样：支撑开头 " << eh << "、结尾 " << et);
    // 支撑外恰为零：支撑前一个与后一个站点样点
    const auto sup = b.at("support");
    const std::vector<std::complex<double>> before = resample_range(r, x, n0, sup[0].get<std::int64_t>() - 1, sup[0].get<std::int64_t>());
    const std::vector<std::complex<double>> after = resample_range(r, x, n0, sup[1].get<std::int64_t>(), sup[1].get<std::int64_t>() + 1);
    CHECK(std::abs(before[0]) == 0.0);
    CHECK(std::abs(after[0]) == 0.0);
}

TEST_CASE("有理重采样：冲激对齐偏差 0 样点（三档抽取比）") {
    for (int M : rsmp_supported_decim()) {
        CAPTURE(M);
        RationalResampler r;
        std::string err;
        REQUIRE(r.init(M, err));
        const std::int64_t k = 11;
        std::vector<std::complex<double>> x(1, std::complex<double>(1.0, 0.0));
        const std::int64_t lo = 125 * k - 300, hi = 125 * k + 300;
        const std::vector<std::complex<double>> y = resample_range(r, x, k * M, lo, hi);
        std::size_t arg = 0;
        for (std::size_t i = 1; i < y.size(); ++i) if (std::abs(y[i]) > std::abs(y[arg])) arg = i;
        CHECK(static_cast<std::int64_t>(arg) + lo == 125 * k);
        // 峰值就是原型中心抽头
        std::vector<double> h;
        dsp::rsmp_fir_expand(dsp::rsmp_fir_v1(), h);
        CHECK(y[arg].real() == h[h.size() / 2]);
    }
}

// ---------------------------------------------------------------- ⑤ 帧排布

TEST_CASE("帧排布：整张突发表对 Python 复刻逐位相同（每个预设 10 万个时隙）") {
    const nlohmann::json g = nlohmann::json::parse(read_bytes(repo_path("engine/tests/golden/ofdm_frame.json")));
    CHECK_MESSAGE(g.at("presets").at("sha256").get<std::string>() == std::string(geo::radiator_presets_v1_sha256()),
                  "黄金基准是按旧预设表生成的：uv run --quiet --with numpy python "
                  "algos/reference/gen_engine_golden.py --mode ofdm_frame -o engine/tests/golden/ofdm_frame.json");
    for (const auto& c : g.at("cases")) {
        const std::string pid = c.at("preset").get<std::string>();
        const std::string eid = c.at("emitter_id").get<std::string>();
        CAPTURE(pid);
        CAPTURE(eid);
        const geo::RadiatorPreset* p = geo::radiator_preset_v1(pid);
        REQUIRE(p != 0);
        geo::FrameSchedule fs;
        fs.build(*p, c.at("seed").get<std::uint64_t>(), eid, c.at("offset_n").get<std::int64_t>(),
                 c.at("end_n").get<std::int64_t>());
        const std::vector<geo::FrameBurst>& bs = fs.bursts();
        CHECK(bs.size() == c.at("n_bursts").get<std::size_t>());
        std::string text;
        for (std::size_t i = 0; i < bs.size(); ++i)
            text += std::to_string(bs[i].slot) + "," + std::to_string(bs[i].start_n) + "," +
                    std::to_string(bs[i].variant) + "\n";
        CHECK(sha256_hex(text) == c.at("sha256_lines").get<std::string>());
        const auto& first = c.at("first");
        for (std::size_t i = 0; i < first.size() && i < bs.size(); ++i) {
            CHECK(bs[i].slot == first[i][0].get<std::int64_t>());
            CHECK(bs[i].start_n == first[i][1].get<std::int64_t>());
            CHECK(bs[i].variant == first[i][2].get<int>());
        }
        // 突发互不重叠，且相邻两个之间至少隔 kBurstMinGapNative（重采样输出支撑不重叠的前提）
        for (std::size_t i = 1; i < bs.size(); ++i)
            REQUIRE(bs[i].start_n >= bs[i - 1].start_n + bs[i - 1].length_n + geo::kBurstMinGapNative);
    }
}

TEST_CASE("帧排布：随机访问（bursts_in）与顺序铺开逐项相同") {
    const geo::RadiatorPreset* p = geo::radiator_preset_v1("dji-video-20m-a");
    REQUIRE(p != 0);
    geo::FrameSchedule fs;
    fs.build(*p, 42u, "uav-9", 0, 5000 * p->slot_n);
    const std::vector<geo::FrameBurst>& all = fs.bursts();
    Xoshiro256pp rng(3);
    for (int trial = 0; trial < 200; ++trial) {
        const std::int64_t a = static_cast<std::int64_t>(rng.uniform() * 5000.0 * p->slot_n);
        const std::int64_t b = a + static_cast<std::int64_t>(rng.uniform() * 20.0 * p->slot_n);
        std::vector<geo::FrameBurst> got;
        fs.bursts_in(a, b, got);
        std::vector<geo::FrameBurst> want;
        for (std::size_t i = 0; i < all.size(); ++i)
            if (all[i].start_n < b && all[i].start_n + all[i].length_n > a) want.push_back(all[i]);
        REQUIRE(got.size() == want.size());
        for (std::size_t i = 0; i < got.size(); ++i) CHECK(got[i].start_n == want[i].start_n);
    }
}

TEST_CASE("帧排布：占空与长突发占比对预设的拟合目标（10 万个时隙）") {
    const nlohmann::json j = nlohmann::json::parse(read_bytes(repo_path("models/radiator/presets-v1.json")));
    for (const auto& pj : j.at("presets")) {
        if (!pj.count("frame_fit") || !pj.at("frame_fit").count("duty")) continue;
        const std::string pid = pj.at("id").get<std::string>();
        CAPTURE(pid);
        const geo::RadiatorPreset* p = geo::radiator_preset_v1(pid);
        geo::FrameSchedule fs;
        fs.build(*p, 20260904u, "uav-1", 0, 100000 * p->slot_n);
        std::int64_t on = 0;
        std::size_t longs = 0;
        for (const auto& b : fs.bursts()) {
            on += b.length_n;
            longs += b.variant == 1 ? 1u : 0u;
        }
        const double duty = static_cast<double>(on) / static_cast<double>(100000 * p->slot_n);
        const double lam = static_cast<double>(longs) / static_cast<double>(fs.bursts().size());
        CHECK(std::fabs(duty - pj.at("frame_fit").at("duty").get<double>()) < 0.005);
        CHECK(std::fabs(lam - pj.at("frame_fit").at("long_share").get<double>()) < 0.01);
    }
}
