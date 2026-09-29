// OFDM 族波形的单测（Q-2，14 号报告 §2，决策 D-088）。
//
// 分组：
//   ① 预设表：geo/src/radiator_presets.cpp 与 models/radiator/presets-v1.json 逐项相同，
//      且表文件的 sha256 与生成时记下的一致（防「改了 JSON 忘了重生成」）；
//   ② 原生率调制器（engine/src/ofdm.cpp）：缓存旋转因子的 FFT 与原版逐位相同、结构性质
//      （子载波数、CP、ZC 功率）、对 Python 参考与 MATLAB 一方的黄金基准（算法核尺度 1e-9）。
// 重采样、帧排布、源的生成路径各自的用例随后续步骤加在这里。

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
#include "cuav/sha256.h"
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
