// 多相 FFT 信道化 Channelizer 的单测（M-3，D-071）。
//
// 分四组，与 test_ddc.cpp 同构：
//   ① 系数表：编译进来的表与 models/channelizer/fir_pfb_v1.json 逐位相同；
//   ② 黄金基准：与 algos/reference/channelizer.py 及 MATLAB 一方对拍（两个尺度：
//      组件 1e-6、算法核 1e-9，理由见 channelizer.json 的 tolerance.note）；
//   ③ 标准算例第 8 项（宽带 IQ 到信道化 IQ，04 §15.2）的解析锚点；
//   ④ 引擎口径：块长无关、reset 复现、元数据与四态、错误路径。
//

#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "cuav/components/channelizer.h"
#include "cuav/dsp.h"
#include "cuav/random.h"
#include "cuav/sha256.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif

std::string repo_path(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

nlohmann::json load_json(const std::string& path, const char* hint) {
    std::ifstream f(path.c_str());
    REQUIRE_MESSAGE(f.good(), hint);
    nlohmann::json j;
    f >> j;
    return j;
}
}  // namespace

TEST_CASE("多相原型表：编译进来的表与 models/channelizer/fir_pfb_v1.json 逐位相同") {
    const nlohmann::json j = load_json(repo_path("models/channelizer/fir_pfb_v1.json"),
                                       "系数表缺失：uv run --quiet --with scipy --with numpy "
                                       "python scripts/design_pfb_fir.py --write");
    const auto& entries = j.at("entries");
    CHECK(entries.size() == dsp::pfb_fir_v1_count());
    std::size_t checked = 0;
    for (const auto& e : entries) {
        const int m = e.at("channels").get<int>();
        const dsp::PfbTable* t = dsp::pfb_fir_v1(m);
        REQUIRE_MESSAGE(t != 0, "子信道数 " << m << " 不在编译进来的表里："
                                            "重跑 scripts/gen_fir_taps.py --kind pfb");
        CHECK(t->ntaps == e.at("ntaps").get<int>());
        CHECK(t->taps_per_branch == e.at("taps_per_branch").get<int>());
        CHECK(t->pad_to == e.at("pad_to").get<int>());
        CHECK(t->group_delay == e.at("group_delay_in").get<int>());

        // M 必须是不小于 2 的 2 的幂：多相 + FFT 的结构要求它
        CHECK(m >= 2);
        CHECK((m & (m - 1)) == 0);
        // 群时延必须是整数样点（08 §8 口径二），由奇数抽头保证
        CHECK(t->ntaps % 2 == 1);
        CHECK(t->group_delay * 2 == t->ntaps - 1);
        // 本表独有的一条：gd 必须是 M 的整数倍，常数相位 exp(-j2πk·gd/M) 才恒为 1。
        // 这一条一破，M 路输出就要逐信道乘一个相位，三方还得各对一遍（方案 §2）。
        CHECK_MESSAGE(t->group_delay % m == 0,
                      "M = " << m << " 的群时延 " << t->group_delay << " 不是 M 的整数倍");
        // N = M·T+1 且 T 为偶数
        const int tt = t->taps_per_branch - 1;
        CHECK(t->ntaps == m * tt + 1);
        CHECK(tt % 2 == 0);
        CHECK(t->pad_to == m * (tt + 1));

        const auto& half = e.at("half");
        REQUIRE(half.size() == static_cast<std::size_t>((t->ntaps + 1) / 2));
        std::size_t bad = 0;
        for (std::size_t k = 0; k < half.size(); ++k) {
            // 逐位：两侧是同一份十进制字面量，不许有任何容差
            if (t->half[k] != half[k].get<double>()) ++bad;
        }
        CHECK_MESSAGE(bad == 0u, "M = " << m << " 有 " << bad << " 个系数与 JSON 不逐位相同");

        std::vector<double> h;
        dsp::pfb_fir_expand(*t, h);
        REQUIRE(h.size() == static_cast<std::size_t>(t->pad_to));
        std::size_t asym = 0;
        for (int k = 0; k < t->ntaps / 2; ++k) {
            if (h[static_cast<std::size_t>(k)] != h[static_cast<std::size_t>(t->ntaps - 1 - k)]) ++asym;
        }
        CHECK_MESSAGE(asym == 0u, "M = " << m << " 镜像后不逐位对称");
        // 零填充区必须是精确的零：支路等长靠它，补的若不是零就改变了 H(ω)
        std::size_t nz = 0;
        for (int k = t->ntaps; k < t->pad_to; ++k) {
            if (h[static_cast<std::size_t>(k)] != 0.0) ++nz;
        }
        CHECK_MESSAGE(nz == 0u, "M = " << m << " 的零填充区不是精确的零");

        double sum = 0.0;
        for (std::size_t k = 0; k < h.size(); ++k) sum += h[k];
        CHECK(std::fabs(sum - 1.0) < 1e-12);   // 通带增益归一：子信道中心单音幅度不变
        ++checked;
    }
    MESSAGE("多相原型表逐位核对：" << checked << " 档");
}

TEST_CASE("多相原型表：查不到的子信道数返回空指针，不静默顶替") {
    CHECK(dsp::pfb_fir_v1(1) == 0);     // 恒等变换不在表里：不做信道化要走槽位旁路
    CHECK(dsp::pfb_fir_v1(3) == 0);     // 不是 2 的幂
    CHECK(dsp::pfb_fir_v1(128) == 0);   // 超出表的范围
    CHECK(dsp::pfb_fir_v1(0) == 0);
    CHECK(dsp::pfb_fir_v1(-8) == 0);
    REQUIRE(dsp::pfb_fir_v1_count() > 0);
    // 表里每一档都查得到，且与按下标取到的是同一条
    for (std::size_t i = 0; i < dsp::pfb_fir_v1_count(); ++i) {
        const dsp::PfbTable& t = dsp::pfb_fir_v1_at(i);
        CHECK(dsp::pfb_fir_v1(t.channels) == &t);
    }
    CHECK(std::string(dsp::pfb_fir_v1_sha256()).size() == 64u);
}

// --- Coder 算法核的可调用性与解析锚点（M-3 第 4 步）---------------------------
//
// 生成的 .h 自带 extern "C" 守卫，C++ 这边直接 include 即可，不用自己包一层。
extern "C" {
#include "cuav_pfb_m16.h"
#include "cuav_pfb_m2.h"
#include "cuav_pfb_m2_initialize.h"
#include "cuav_pfb_m4.h"
#include "cuav_pfb_m8.h"
}

TEST_CASE("Coder 内核可从 C++ 调用：子信道中心的单音增益恰为 1，邻道泄漏等于原型阻带") {
    const int M = 8;
    const dsp::PfbTable* t = dsp::pfb_fir_v1(M);
    REQUIRE(t != 0);
    const std::size_t P = static_cast<std::size_t>(t->pad_to);
    REQUIRE(P == 232u);   // 与生成的 C 的定长接口一致：改了表要重跑 codegen

    std::vector<double> h;
    dsp::pfb_fir_expand(*t, h);
    // 内核吃**正序**窗口与**反转后**的抽头（封装层算一次、反复用）
    std::vector<double> hr(P);
    for (std::size_t i = 0; i < P; ++i) hr[i] = h[P - 1 - i];

    cuav_pfb_m2_initialize();   // 六个入口共用一个库初始化，名字跟着首个入口走

    const double two_pi = 6.28318530717958647692;
    for (int k = 0; k < M; ++k) {
        // 锚在输入样点 n0 = m·M + gd；gd 是 M 的整数倍，故该处单音相位恰为零，y[k] 应是实的 1
        const long n0 = 40L * M + t->group_delay;
        std::vector<creal_T> w(P);
        for (std::size_t j = 0; j < P; ++j) {
            const long n = n0 - static_cast<long>(P) + 1 + static_cast<long>(j);
            const double th = two_pi * static_cast<double>(k) * static_cast<double>(n)
                              / static_cast<double>(M);
            w[j].re = std::cos(th);
            w[j].im = std::sin(th);
        }
        creal_T y[8];
        cuav_pfb_m8(&w[0], &hr[0], y);

        const double mag = std::sqrt(y[k].re * y[k].re + y[k].im * y[k].im);
        CHECK_MESSAGE(std::fabs(mag - 1.0) < 1e-9,
                      "k = " << k << " 的中心单音增益 " << mag << "，应为 1（sum(h) = 1 的直接后果）");
        // 常数相位恒为 1 的直接可观测后果：输出是实的，虚部在舍入量级
        CHECK(std::fabs(y[k].im) < 1e-9);

        double worst = 0.0;
        for (int j = 0; j < M; ++j) {
            if (j == k) continue;
            const double m2 = std::sqrt(y[j].re * y[j].re + y[j].im * y[j].im);
            if (m2 > worst) worst = m2;
        }
        const double leak_dB = 20.0 * std::log10(worst);
        CHECK_MESSAGE(leak_dB <= -60.0,
                      "k = " << k << " 的邻道泄漏 " << leak_dB << " dB，应不高于 -60");
        if (k == 0) MESSAGE("M = 8：中心增益 " << mag << "，最坏邻道泄漏 " << leak_dB << " dB");
    }
}

// --- 黄金基准对拍与引擎口径（M-3 第 8 步）------------------------------------

namespace {

// 与 algos/reference/gen_engine_golden.py 的 _m3_input 逐字同序：噪声 + 三个单音（第三个门控）
std::vector<Complex> build_chan_input(const nlohmann::json& p) {
    const std::size_t n = p.at("samples").get<std::size_t>();
    const double fs = p.at("sample_rate_Hz").get<double>();
    const double amp = p.at("tone_amplitude").get<double>();
    const auto tones = p.at("tones_Hz").get<std::vector<double> >();
    const std::uint64_t g0 = p.at("gate_start").get<std::uint64_t>();
    const std::uint64_t g1 = p.at("gate_stop").get<std::uint64_t>();
    const double two_pi = 2.0 * 3.14159265358979323846;

    Xoshiro256pp rng(p.at("seed").get<std::uint64_t>());
    std::vector<Complex> x(n);
    for (std::size_t i = 0; i < n; ++i) {
        float re = 0.0f, im = 0.0f;
        rng.complex_normal(re, im);
        x[i] = Complex(re, im);
    }
    for (std::size_t ti = 0; ti < tones.size(); ++ti) {
        const double w = two_pi * tones[ti] / fs;
        const bool gated = (ti == 2);
        for (std::size_t i = 0; i < n; ++i) {
            if (gated && (i < g0 || i >= g1)) continue;
            const double ph = w * static_cast<double>(i);
            x[i] += Complex(static_cast<float>(amp * std::cos(ph)),
                            static_cast<float>(amp * std::sin(ph)));
        }
    }
    return x;
}

bool drive_chan(Channelizer& c, const std::vector<Complex>& x, double fs, std::size_t block,
                std::vector<Complex>& out, std::string& err) {
    out.clear();
    std::uint64_t start = 0;
    for (std::size_t off = 0; off < x.size(); off += block) {
        const std::size_t n = std::min(block, x.size() - off);
        PortMap in, o;
        PortData pd;
        pd.type = PortType::IQStream;
        pd.has_data = true;
        pd.iq.samples.assign(x.begin() + static_cast<std::ptrdiff_t>(off),
                             x.begin() + static_cast<std::ptrdiff_t>(off + n));
        pd.iq.meta.sample_rate_Hz = fs;
        pd.iq.meta.center_frequency_Hz = 2.441e9;
        pd.iq.meta.start_sample = start;
        pd.iq.meta.continuous_with_previous = true;
        in["in"] = pd;
        const Step st = c.process(in, o, err);
        if (st == Step::Error) return false;
        if (st == Step::Produced && o.count("out")) {
            const std::vector<Complex>& s = o["out"].iq.samples;
            out.insert(out.end(), s.begin(), s.end());
        }
        start += n;
    }
    PortMap fo;
    return c.flush(fo, err) != Step::Error;
}

bool make_chan(Channelizer& c, int m, int j, std::string& err) {
    std::map<std::string, double> p;
    std::map<std::string, std::string> t;
    p["channels"] = m;
    p["select_channel"] = j;
    if (!c.configure(p, t, err)) return false;
    Xoshiro256pp rng(1);
    return c.init(rng, err);
}

}  // namespace

TEST_CASE("表里每一档都有对应的 Coder 内核（加了档位忘了重跑 codegen 会在这里红）") {
    std::string err;
    for (std::size_t i = 0; i < dsp::pfb_fir_v1_count(); ++i) {
        const int m = dsp::pfb_fir_v1_at(i).channels;
        Channelizer c;
        CHECK_MESSAGE(make_chan(c, m, m / 2, err), "channels = " << m << "：" << err);
        CHECK(c.channels() == m);
        CHECK(c.raw_bin() == 0);                      // j = M/2 就是零频那一路
        CHECK(c.group_delay() % m == 0);
    }
    MESSAGE("原型表 " << dsp::pfb_fir_v1_count() << " 档，内核齐备");
}

TEST_CASE("黄金基准：Channelizer 与 algos/reference/channelizer.py 逐样点对拍（M-3，D-071）") {
    const nlohmann::json g = load_json(
        std::string(CUAV_SOURCE_DIR) + "/tests/golden/channelizer.json",
        "黄金基准缺失：uv run --quiet --with numpy python algos/reference/gen_engine_golden.py "
        "--mode channelizer -o engine/tests/golden/channelizer.json");

    CHECK_MESSAGE(g.at("fir").at("table_sha256").get<std::string>() ==
                      std::string(dsp::pfb_fir_v1_sha256()),
                  "黄金基准与编译进来的表来自不同版本的 fir_pfb_v1.json，两边都要重生成");

    const nlohmann::json& p = g.at("params");
    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::vector<Complex> x = build_chan_input(p);

    const auto& ih = g.at("input").at("head");
    std::size_t bad_in = 0;
    for (std::size_t i = 0; i < ih.size(); ++i) {
        if (x[i].real() != static_cast<float>(ih[i][0].get<double>()) ||
            x[i].imag() != static_cast<float>(ih[i][1].get<double>())) ++bad_in;
    }
    REQUIRE_MESSAGE(bad_in == 0u, "输入复刻与黄金基准不一致（" << bad_in << " / " << ih.size()
                                   << "）：随机源或单音公式漂了");

    const double tol = g.at("tolerance").at("sample_rel").get<double>();
    std::size_t cases = 0;
    double worst_all = 0.0;
    for (auto it = g.at("expected").at("python").begin();
         it != g.at("expected").at("python").end(); ++it) {
        const nlohmann::json& e = it.value();
        const int m = e.at("channels").get<int>();
        const int j = e.at("select_channel").get<int>();
        Channelizer c;
        std::string err;
        REQUIRE_MESSAGE(make_chan(c, m, j, err), err);
        std::vector<Complex> y;
        REQUIRE_MESSAGE(drive_chan(c, x, fs, 4096, y, err), err);

        CHECK(c.raw_bin() == e.at("raw_bin").get<int>());
        CHECK(c.ntaps() == e.at("ntaps").get<int>());
        CHECK(c.pad_to() == e.at("pad_to").get<int>());
        CHECK(c.group_delay() == e.at("group_delay_in").get<int>());
        CHECK(c.sample_rate_out_Hz() == e.at("sample_rate_out_Hz").get<double>());
        CHECK(y.size() == e.at("n_out").get<std::size_t>());

        const auto& head = e.at("head");
        double worst = 0.0, scale = 0.0;
        for (std::size_t i = 0; i < head.size() && i < y.size(); ++i) {
            const double wr = head[i][0].get<double>(), wi = head[i][1].get<double>();
            scale = std::max(scale, std::sqrt(wr * wr + wi * wi));
            const double dr = y[i].real() - wr, di = y[i].imag() - wi;
            worst = std::max(worst, std::sqrt(dr * dr + di * di));
        }
        CHECK_MESSAGE(worst <= tol * scale,
                      it.key() << " 前 " << head.size() << " 个输出的最大相对差 "
                               << (worst / scale) << " 超过 " << tol);
        worst_all = std::max(worst_all, worst / scale);
        ++cases;
    }
    CHECK(cases == 5u);
    MESSAGE("五个算例，组件尺度最大相对差 " << worst_all << "（判据 " << tol << "）");
}

TEST_CASE("算法核尺度：Coder 内核对同一批窗口与直接式一致到 1e-9（06 §9D 的验收判据）") {
    const nlohmann::json g = load_json(
        std::string(CUAV_SOURCE_DIR) + "/tests/golden/channelizer.json", "黄金基准缺失");
    // 窗口与抽头是黄金文件里的**显式数据**，三方谁也不再各自算一遍公式 ——
    // 共享输入必须共享比特不能共享公式，这是 M-3 第 5 步踩实过的（见 channelizer.py 头注）。
    const double tol = g.at("tolerance").at("kernel_rel").get<double>();
    double worst = 0.0;
    std::size_t n_win = 0;
    for (const auto& kc : g.at("kernel_check")) {
        const int m = kc.at("channels").get<int>();
        const std::size_t P = kc.at("pad_to").get<std::size_t>();
        const auto hr = kc.at("taps_reversed").get<std::vector<double> >();
        REQUIRE(hr.size() == P);
        std::vector<creal_T> w(P);
        const auto& wj = kc.at("window_forward");
        REQUIRE(wj.size() == P);
        for (std::size_t i = 0; i < P; ++i) {
            w[i].re = wj[i][0].get<double>();
            w[i].im = wj[i][1].get<double>();
        }
        std::vector<creal_T> y(static_cast<std::size_t>(m));
        cuav_pfb_m2_initialize();
        switch (m) {
            case 2:  cuav_pfb_m2(&w[0], &hr[0], &y[0]); break;
            case 4:  cuav_pfb_m4(&w[0], &hr[0], &y[0]); break;
            case 8:  cuav_pfb_m8(&w[0], &hr[0], &y[0]); break;
            case 16: cuav_pfb_m16(&w[0], &hr[0], &y[0]); break;
            default: FAIL("核对窗口用了没有内核的 channels = " << m);
        }
        const auto& exp = kc.at("expected_bins");
        REQUIRE(exp.size() == static_cast<std::size_t>(m));
        double scale = 0.0, d = 0.0;
        for (int k = 0; k < m; ++k) {
            const double er = exp[k][0].get<double>(), ei = exp[k][1].get<double>();
            scale = std::max(scale, std::sqrt(er * er + ei * ei));
            const double dr = y[k].re - er, di = y[k].im - ei;
            d = std::max(d, std::sqrt(dr * dr + di * di));
        }
        CHECK_MESSAGE(d <= tol * scale, "M = " << m << " 的窗口相对差 " << (d / scale)
                                               << " 超过 " << tol);
        worst = std::max(worst, d / scale);
        ++n_win;
    }
    CHECK(n_win >= 4u);
    MESSAGE(n_win << " 条窗口，算法核尺度最大相对差 " << worst << "（判据 " << tol << "）");
}

TEST_CASE("标准算例第 8 项：宽带 IQ 到信道化 IQ 的解析锚点（04 §15.2）") {
    const double fs = 1.0e7;
    const int M = 8;
    const std::size_t n = 40000;
    std::string err;

    SUBCASE("采样率与中心频率：fs_out = fs/M，中心按 (j − M/2)·fs_out 偏移") {
        for (int j = 0; j < M; ++j) {
            Channelizer c;
            REQUIRE(make_chan(c, M, j, err));
            std::vector<Complex> x(n, Complex(0.0f, 0.0f));
            PortMap in, o;
            PortData pd;
            pd.type = PortType::IQStream;
            pd.has_data = true;
            pd.iq.samples = x;
            pd.iq.meta.sample_rate_Hz = fs;
            pd.iq.meta.center_frequency_Hz = 2.441e9;
            pd.iq.meta.start_sample = 0;
            pd.iq.meta.continuous_with_previous = true;
            in["in"] = pd;
            REQUIRE(c.process(in, o, err) == Step::Produced);
            const BlockMeta& mt = o["out"].iq.meta;
            CHECK(mt.sample_rate_Hz == fs / M);
            CHECK(mt.center_frequency_Hz == doctest::Approx(2.441e9 + (j - M / 2) * (fs / M)));
        }
    }

    SUBCASE("子信道中心的单音：增益 1（纹波内），落到邻道被压到原型阻带") {
        const double two_pi = 2.0 * 3.14159265358979323846;
        for (int j = 0; j < M; ++j) {
            const double f = (j - M / 2) * (fs / M);
            std::vector<Complex> x(n);
            const double w = two_pi * f / fs;
            for (std::size_t i = 0; i < n; ++i) {
                const double ph = w * static_cast<double>(i);
                x[i] = Complex(static_cast<float>(std::cos(ph)), static_cast<float>(std::sin(ph)));
            }
            Channelizer c;
            REQUIRE(make_chan(c, M, j, err));
            std::vector<Complex> y;
            REQUIRE(drive_chan(c, x, fs, 4096, y, err));
            double s = 0.0;
            std::size_t cnt = 0;
            for (std::size_t i = 200; i < y.size(); ++i) { s += std::abs(y[i]); ++cnt; }
            const double amp = s / static_cast<double>(cnt);
            CHECK_MESSAGE(std::fabs(20.0 * std::log10(amp)) < 0.2,
                          "j = " << j << " 的中心增益 " << (20.0 * std::log10(amp)) << " dB");

            // 同一个单音，交给隔壁那一路读
            Channelizer c2;
            REQUIRE(make_chan(c2, M, (j + 1) % M, err));
            std::vector<Complex> y2;
            REQUIRE(drive_chan(c2, x, fs, 4096, y2, err));
            double s2 = 0.0;
            cnt = 0;
            for (std::size_t i = 2000; i < y2.size(); ++i) { s2 += std::abs(y2[i]); ++cnt; }
            const double att = -20.0 * std::log10(std::max(s2 / static_cast<double>(cnt), 1e-30));
            CHECK_MESSAGE(att >= 60.0, "j = " << j << " 的邻道抑制只有 " << att << " dB");
            if (j == M / 2) MESSAGE("零频那一路：中心增益 " << (20.0 * std::log10(amp))
                                     << " dB，邻道抑制 " << att << " dB");
        }
    }

    SUBCASE("群时延：输入 n0 处的冲激，输出峰值在 m = n0/M，偏差 0 样点") {
        const int ms[] = {2, 4, 8, 16};
        for (std::size_t mi = 0; mi < 4; ++mi) {
            const int m = ms[mi];
            Channelizer c;
            REQUIRE(make_chan(c, m, m / 2, err));
            const std::size_t n0 = static_cast<std::size_t>(m) * 400;
            std::vector<Complex> x(n0 + 8 * static_cast<std::size_t>(c.group_delay()) + 8 * m,
                                   Complex(0.0f, 0.0f));
            x[n0] = Complex(1.0f, 0.0f);
            std::vector<Complex> y;
            REQUIRE(drive_chan(c, x, fs, 4096, y, err));
            std::size_t peak = 0;
            double best = -1.0;
            for (std::size_t i = 0; i < y.size(); ++i) {
                const double v = std::abs(y[i]);
                if (v > best) { best = v; peak = i; }
            }
            CHECK_MESSAGE(peak == n0 / static_cast<std::size_t>(m),
                          "M = " << m << " 的冲激峰值在 " << peak << "，应当是 " << (n0 / m));
        }
    }

    SUBCASE("输出样点数合闭式，收尾丢不满一个输出周期的那几个") {
        Channelizer c;
        REQUIRE(make_chan(c, M, 3, err));
        std::vector<Complex> x(n, Complex(0.5f, -0.25f));
        std::vector<Complex> y;
        REQUIRE(drive_chan(c, x, fs, 997, y, err));
        const std::size_t gd = static_cast<std::size_t>(c.group_delay());
        const std::size_t want = n > gd ? (n - 1 - gd) / static_cast<std::size_t>(M) + 1 : 0;
        CHECK(y.size() == want);
    }
}

TEST_CASE("Channelizer 的引擎口径：块长无关、reset 复现、元数据与四态") {
    const double fs = 1.0e7;
    const std::size_t n = 30000;
    std::vector<Complex> x(n);
    Xoshiro256pp rng(20260917);
    for (std::size_t i = 0; i < n; ++i) {
        float re = 0.0f, im = 0.0f;
        rng.complex_normal(re, im);
        x[i] = Complex(re, im);
    }
    std::string err;

    SUBCASE("块长无关：1 / 7 / 997 / 整块的结果逐位相同") {
        Channelizer a;
        REQUIRE(make_chan(a, 8, 5, err));
        std::vector<Complex> ref;
        REQUIRE(drive_chan(a, x, fs, 4096, ref, err));
        const std::size_t blocks[] = {1, 7, 997, n};
        for (std::size_t bi = 0; bi < 4; ++bi) {
            Channelizer b;
            REQUIRE(make_chan(b, 8, 5, err));
            std::vector<Complex> got;
            REQUIRE(drive_chan(b, x, fs, blocks[bi], got, err));
            REQUIRE(got.size() == ref.size());
            std::size_t diff = 0;
            for (std::size_t i = 0; i < got.size(); ++i) if (got[i] != ref[i]) ++diff;
            CHECK_MESSAGE(diff == 0u, "块长 " << blocks[bi] << " 有 " << diff << " 个样点不同");
        }
    }

    SUBCASE("reset 之后重跑逐位相同（铁律 9）") {
        Channelizer c;
        REQUIRE(make_chan(c, 4, 1, err));
        std::vector<Complex> a, b;
        REQUIRE(drive_chan(c, x, fs, 2048, a, err));
        c.reset();
        REQUIRE(drive_chan(c, x, fs, 2048, b, err));
        REQUIRE(a.size() == b.size());
        std::size_t diff = 0;
        for (std::size_t i = 0; i < a.size(); ++i) if (a[i] != b[i]) ++diff;
        CHECK(diff == 0u);
    }

    SUBCASE("元数据：削顶计数与四态照传，首块留一条记录性说明") {
        Channelizer c;
        REQUIRE(make_chan(c, 8, 2, err));
        PortMap in, o;
        PortData pd;
        pd.type = PortType::IQStream;
        pd.has_data = true;
        pd.iq.samples.assign(x.begin(), x.begin() + 8192);
        pd.iq.meta.sample_rate_Hz = fs;
        pd.iq.meta.center_frequency_Hz = 2.441e9;
        pd.iq.meta.start_sample = 0;
        pd.iq.meta.continuous_with_previous = true;
        pd.iq.meta.clip_count = 5;
        pd.iq.meta.state = State::Degraded;
        in["in"] = pd;
        REQUIRE(c.process(in, o, err) == Step::Produced);
        const Block& b = o["out"].iq;
        CHECK(b.meta.start_sample == 0u);
        CHECK(b.meta.clip_count == 5u);
        CHECK(b.meta.state == State::Degraded);
        CHECK(c.status().state == State::Degraded);
        CHECK(b.meta.trace.parameter_version == "chan-pfb_v1-m8-j2");
        bool has_note = false;
        for (std::size_t i = 0; i < b.meta.state_reasons.size(); ++i) {
            if (b.meta.state_reasons[i].substr(0, 10) == "chan_rate:") has_note = true;
        }
        CHECK_MESSAGE(has_note, "首块应当留一条记录性的说明（08 §8 口径四）");
    }
}

TEST_CASE("Channelizer 的错误路径：每一条都说得出缘由，不静默顶替") {
    std::string err;
    const double fs = 1.0e7;

    SUBCASE("channels 不在表里") {
        Channelizer c;
        std::map<std::string, double> p;
        std::map<std::string, std::string> t;
        p["channels"] = 6;
        p["select_channel"] = 3;
        CHECK_FALSE(c.configure(p, t, err));
        CHECK(err.find("不在冻结原型表内") != std::string::npos);
        CHECK_MESSAGE(err.find("旁路") != std::string::npos,
                      "要提示「不做信道化走槽位旁路」而不是让人去填 channels = 1：" << err);
    }
    SUBCASE("channels = 1 不是「不做信道化」的写法") {
        Channelizer c;
        std::map<std::string, double> p;
        std::map<std::string, std::string> t;
        p["channels"] = 1;
        CHECK_FALSE(c.configure(p, t, err));
    }
    SUBCASE("select_channel 越界：报错里说清零频那一路是第几路") {
        Channelizer c;
        std::map<std::string, double> p;
        std::map<std::string, std::string> t;
        p["channels"] = 4;
        p["select_channel"] = 4;      // 合法范围是 [0, 4)
        CHECK_FALSE(c.configure(p, t, err));
        CHECK(err.find("select_channel") != std::string::npos);
        CHECK(err.find("零频") != std::string::npos);
        MESSAGE(err);
    }
    SUBCASE("未知的 fir_version") {
        Channelizer c;
        std::map<std::string, double> p;
        std::map<std::string, std::string> t;
        p["channels"] = 8;
        p["select_channel"] = 4;
        t["fir_version"] = "pfb_v9";
        CHECK_FALSE(c.configure(p, t, err));
    }
    SUBCASE("采样率不能被 channels 整除") {
        Channelizer c;
        REQUIRE(make_chan(c, 8, 4, err));
        std::vector<Complex> x(100, Complex(0.0f, 0.0f));
        std::vector<Complex> y;
        CHECK_FALSE(drive_chan(c, x, 1.0e7 + 3.0, 100, y, err));
        CHECK(err.find("整除") != std::string::npos);
    }
    SUBCASE("输入块不连续") {
        Channelizer c;
        REQUIRE(make_chan(c, 8, 4, err));
        std::vector<Complex> x(4096, Complex(1.0f, 0.0f));
        PortMap in, o;
        PortData pd;
        pd.type = PortType::IQStream;
        pd.has_data = true;
        pd.iq.samples = x;
        pd.iq.meta.sample_rate_Hz = fs;
        pd.iq.meta.start_sample = 0;
        pd.iq.meta.continuous_with_previous = true;
        in["in"] = pd;
        REQUIRE(c.process(in, o, err) != Step::Error);
        PortMap in2, o2;
        pd.iq.meta.start_sample = 12345;
        in2["in"] = pd;
        CHECK(c.process(in2, o2, err) == Step::Error);
        CHECK(err.find("不连续") != std::string::npos);
    }
}

// --- MATLAB 一方（三方互证的第三家，M-3 第 9 步）-------------------------------

namespace {

// 防陈旧：黄金文件里记着它生成那一刻读到的 .m 与冻结表的 sha256。改了其中任何一份却没重跑
// MATLAB，这里当场红（铁律 10）。文件是**入库的**，所以这条守卫在没有 MATLAB 的机器上照样成立 ——
// CI 与 scripts/build-all.sh 都不调用 MATLAB（D-036）。
void check_matlab_guards(const nlohmann::json& m, const char* table_rel) {
    const nlohmann::json& srcs = m.at("guards").at("source_m_sha256");
    REQUIRE_MESSAGE(srcs.size() > 0u, "MATLAB 一方没记来源 .m 的哈希");
    for (nlohmann::json::const_iterator it = srcs.begin(); it != srcs.end(); ++it) {
        const std::string rel = it->at("path").get<std::string>();
        std::string hex, err;
        REQUIRE_MESSAGE(sha256_file(repo_path(rel), hex, err), "读不到 " << rel << "：" << err);
        CHECK_MESSAGE(hex == it->at("sha256").get<std::string>(),
                      rel << " 改过而 MATLAB 一方没重生成："
                             "MATLAB_ROOT=<安装目录> sh matlab/run_matlab.sh");
    }
    std::string hex, err;
    REQUIRE_MESSAGE(sha256_file(repo_path(table_rel), hex, err), err);
    CHECK_MESSAGE(hex == m.at("guards").at("table_sha256").get<std::string>(),
                  std::string(table_rel) << " 改过而 MATLAB 一方没重生成");
}

void run_pfb(int m, const std::vector<creal_T>& w, const std::vector<double>& hr,
             std::vector<creal_T>& y) {
    y.assign(static_cast<std::size_t>(m), creal_T());
    cuav_pfb_m2_initialize();
    switch (m) {
        case 2:  cuav_pfb_m2(&w[0], &hr[0], &y[0]); break;
        case 4:  cuav_pfb_m4(&w[0], &hr[0], &y[0]); break;
        case 8:  cuav_pfb_m8(&w[0], &hr[0], &y[0]); break;
        case 16: cuav_pfb_m16(&w[0], &hr[0], &y[0]); break;
        default: FAIL("没有 channels = " << m << " 的内核");
    }
}

}  // namespace

TEST_CASE("MATLAB 一方：Coder 内核与 channelizer.matlab.json 一致到 1e-9（06 §9D 的验收判据）") {
    const nlohmann::json g = load_json(
        std::string(CUAV_SOURCE_DIR) + "/tests/golden/channelizer.json", "黄金基准缺失");
    // 与 M-1 的 spectrum_welch.matlab.json 不同，这一份是**必需**的：P1-8 的验收判据
    // （06 §9D「Coder 组件与 MATLAB 黄金向量 rel ≤ 1e-9」）只有它能兑现，缺了就不是三方互证。
    const nlohmann::json m = load_json(
        std::string(CUAV_SOURCE_DIR) + "/tests/golden/channelizer.matlab.json",
        "MATLAB 一方的黄金向量缺失：MATLAB_ROOT=<MATLAB 安装目录> sh matlab/run_matlab.sh");
    check_matlab_guards(m, "models/channelizer/fir_pfb_v1.json");

    const double tol = m.at("tolerance").at("kernel_rel").get<double>();
    CHECK_MESSAGE(tol <= 1e-9, "判据被放宽了：06 §9D 写的是 1e-9");
    // MATLAB 侧在生成时已把入口对直接式、对 Python 参考各核过一遍，数值记在文件里
    CHECK(m.at("entry_vs_direct_max_rel").get<double>() <= tol);
    CHECK(m.at("matlab_vs_python_max_rel").get<double>() <= tol);

    double worst = 0.0;
    std::size_t n = 0;
    for (nlohmann::json::const_iterator mb = m.at("kernel_check").begin();
         mb != m.at("kernel_check").end(); ++mb) {
        // 窗口与抽头只有一份，在 channelizer.json 里；MATLAB 与 Coder 都读它。
        // 按 (M, m_out, p_in, pad_to) 认领，认不到就是两边脱节了。
        const nlohmann::json* src = 0;
        for (nlohmann::json::const_iterator kc = g.at("kernel_check").begin();
             kc != g.at("kernel_check").end(); ++kc) {
            if (kc->at("channels") == mb->at("channels") && kc->at("m_out") == mb->at("m_out") &&
                kc->at("p_in") == mb->at("p_in") && kc->at("pad_to") == mb->at("pad_to")) {
                src = &(*kc);
                break;
            }
        }
        const int mm = mb->at("channels").get<int>();
        REQUIRE_MESSAGE(src != 0, "MATLAB 一方有 channelizer.json 里没有的窗口（M = "
                                      << mm << "）：两边要一起重生成");

        const std::size_t P = src->at("pad_to").get<std::size_t>();
        const std::vector<double> hr = src->at("taps_reversed").get<std::vector<double> >();
        REQUIRE(hr.size() == P);
        std::vector<creal_T> w(P);
        const nlohmann::json& wj = src->at("window_forward");
        REQUIRE(wj.size() == P);
        for (std::size_t i = 0; i < P; ++i) {
            w[i].re = wj[i][0].get<double>();
            w[i].im = wj[i][1].get<double>();
        }
        std::vector<creal_T> y;
        run_pfb(mm, w, hr, y);

        const nlohmann::json& exp = mb->at("expected_bins");
        REQUIRE(exp.size() == static_cast<std::size_t>(mm));
        double scale = 0.0, d = 0.0;
        for (int k = 0; k < mm; ++k) {
            const double er = exp[k][0].get<double>(), ei = exp[k][1].get<double>();
            scale = std::max(scale, std::sqrt(er * er + ei * ei));
            const double dr = y[k].re - er, di = y[k].im - ei;
            d = std::max(d, std::sqrt(dr * dr + di * di));
        }
        CHECK_MESSAGE(d <= tol * scale, "M = " << mm << " 的窗口对 MATLAB 相对差 "
                                               << (d / scale) << " 超过 " << tol);
        worst = std::max(worst, d / scale);
        ++n;
    }
    // 每条窗口都要有 MATLAB 一方，否则三方互证只盖到一部分
    CHECK_MESSAGE(n == g.at("kernel_check").size(),
                  "MATLAB 一方只盖到 " << n << " / " << g.at("kernel_check").size() << " 条窗口");
    MESSAGE(n << " 条窗口，Coder 内核对 MATLAB 最大相对差 " << worst << "（判据 " << tol
              << "）；MATLAB 对 Python 参考 " << m.at("matlab_vs_python_max_rel").get<double>());
}
