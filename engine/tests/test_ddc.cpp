// DDC 组件的单测（M-2，D-070）。
//
// 四组验收：
//   ① 冻结系数表与 models/adc-ddc/fir_lp_v1.json 逐位一致（生成物没跟真理源脱节）；
//   ② 与 Python 参考 algos/reference/ddc.py 的黄金基准对拍（三方互证的必需一路）；
//   ③ 04 §15.2 标准算例第 7 项的解析锚点：频移搬对、带外压住、抽取比、群时延对齐；
//   ④ 引擎口径：块长无关、reset 后逐位复现、四态与元数据、六条错误路径。

#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "cuav/components/ddc.h"
#include "cuav/dsp.h"
#include "cuav/random.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif

std::string engine_path(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/" + rel; }
std::string repo_path(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

nlohmann::json load_json(const std::string& path, const char* hint) {
    std::ifstream f(path.c_str());
    REQUIRE_MESSAGE(f.good(), hint);
    nlohmann::json j;
    f >> j;
    return j;
}

// 黄金基准的输入配方：噪声 + 通带单音 + 门控的阻带单音，三项按此次序相加、每步 float32。
// 与 algos/reference/gen_engine_golden.py 的 write_ddc 逐字同序。
std::vector<Complex> build_input(const nlohmann::json& p) {
    const std::size_t n = p.at("samples").get<std::size_t>();
    const double fs = p.at("sample_rate_Hz").get<double>();
    const double amp = p.at("tone_amplitude").get<double>();
    const double fp = p.at("tone_passband_Hz").get<double>();
    const double fst = p.at("tone_stopband_Hz").get<double>();
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
    const double wp = two_pi * fp / fs;
    const double ws = two_pi * fst / fs;
    for (std::size_t i = 0; i < n; ++i) {
        const double ph = wp * static_cast<double>(i);
        x[i] += Complex(static_cast<float>(amp * std::cos(ph)),
                        static_cast<float>(amp * std::sin(ph)));
    }
    for (std::size_t i = 0; i < n; ++i) {
        if (i < g0 || i >= g1) continue;
        const double ph = ws * static_cast<double>(i);
        x[i] += Complex(static_cast<float>(amp * std::cos(ph)),
                        static_cast<float>(amp * std::sin(ph)));
    }
    return x;
}

// 把一条流按固定块长喂给 DDC，收集全部输出。返回 false 表示运行出错。
bool drive(DDC& d, const std::vector<Complex>& x, double fs, std::size_t block,
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
        const Step st = d.process(in, o, err);
        if (st == Step::Error) return false;
        if (st == Step::Produced && o.count("out")) {
            const std::vector<Complex>& s = o["out"].iq.samples;
            out.insert(out.end(), s.begin(), s.end());
        }
        start += n;
    }
    PortMap fo;
    return d.flush(fo, err) != Step::Error;
}

std::vector<Complex> tone(std::size_t n, double fs, double f, double amp) {
    const double w = 2.0 * 3.14159265358979323846 * f / fs;
    std::vector<Complex> x(n);
    for (std::size_t i = 0; i < n; ++i) {
        const double ph = w * static_cast<double>(i);
        x[i] = Complex(static_cast<float>(amp * std::cos(ph)),
                       static_cast<float>(amp * std::sin(ph)));
    }
    return x;
}

double mean_abs(const std::vector<Complex>& y, std::size_t skip) {
    double a = 0.0;
    std::size_t c = 0;
    for (std::size_t i = skip; i < y.size(); ++i) {
        a += std::sqrt(static_cast<double>(y[i].real()) * y[i].real() +
                       static_cast<double>(y[i].imag()) * y[i].imag());
        ++c;
    }
    return c ? a / static_cast<double>(c) : 0.0;
}

bool make(DDC& d, int decim, double shift, std::string& err) {
    std::map<std::string, double> p;
    p["decim"] = decim;
    p["f_shift_Hz"] = shift;
    std::map<std::string, std::string> t;
    if (!d.configure(p, t, err)) return false;
    Xoshiro256pp rng(1);
    return d.init(rng, err);
}

}  // namespace

TEST_CASE("DDC 系数表：编译进来的表与 models/adc-ddc/fir_lp_v1.json 逐位相同") {
    const nlohmann::json j = load_json(repo_path("models/adc-ddc/fir_lp_v1.json"),
                                       "系数表缺失：uv run --quiet --with scipy --with numpy "
                                       "python scripts/design_ddc_fir.py --write");
    const auto& entries = j.at("entries");
    CHECK(entries.size() == dsp::ddc_fir_lp_v1_count());
    std::size_t checked = 0;
    for (const auto& e : entries) {
        const int d = e.at("decim").get<int>();
        const dsp::FirTable* t = dsp::ddc_fir_lp_v1(d);
        REQUIRE_MESSAGE(t != 0, "抽取比 " << d << " 不在编译进来的表里：重跑 scripts/gen_ddc_taps.py");
        CHECK(t->ntaps == e.at("ntaps").get<int>());
        CHECK(t->group_delay == e.at("group_delay_in").get<int>());
        // 群时延必须是整数样点（08 §8 口径二），这由奇数抽头保证
        CHECK(t->ntaps % 2 == 1);
        CHECK(t->group_delay * 2 == t->ntaps - 1);
        const auto& half = e.at("half");
        REQUIRE(half.size() == static_cast<std::size_t>((t->ntaps + 1) / 2));
        std::size_t bad = 0;
        for (std::size_t k = 0; k < half.size(); ++k) {
            // 逐位：两侧是同一份十进制字面量，不许有任何容差（coeff_rel = 0）
            if (t->half[k] != half[k].get<double>()) ++bad;
        }
        CHECK_MESSAGE(bad == 0u, "D = " << d << " 有 " << bad << " 个系数与 JSON 不逐位相同");
        // 镜像展开后逐位对称
        std::vector<double> h;
        dsp::ddc_fir_expand(*t, h);
        REQUIRE(h.size() == static_cast<std::size_t>(t->ntaps));
        std::size_t asym = 0;
        for (int k = 0; k < t->ntaps / 2; ++k) {
            if (h[static_cast<std::size_t>(k)] != h[static_cast<std::size_t>(t->ntaps - 1 - k)]) ++asym;
        }
        CHECK_MESSAGE(asym == 0u, "D = " << d << " 镜像后不逐位对称");
        double sum = 0.0;
        for (std::size_t k = 0; k < h.size(); ++k) sum += h[k];
        CHECK(std::fabs(sum - 1.0) < 1e-12);   // 通带增益归一
        ++checked;
    }
    MESSAGE("系数表逐位核对：" << checked << " 档");
}

TEST_CASE("黄金基准：DDC 与 algos/reference/ddc.py 逐样点对拍（M-2，D-070）") {
    const nlohmann::json g = load_json(engine_path("tests/golden/ddc.json"),
                                       "黄金基准缺失：uv run --quiet --with numpy python "
                                       "algos/reference/gen_engine_golden.py --mode ddc "
                                       "-o engine/tests/golden/ddc.json");
    // 系数表一变，基准就该重生成；这一条比逐样点容差更早、更明确地把脱节暴露出来
    CHECK_MESSAGE(g.at("fir").at("table_sha256").get<std::string>() ==
                      std::string(dsp::ddc_fir_lp_v1_sha256()),
                  "黄金基准与编译进来的表来自不同版本的 fir_lp_v1.json，两边都要重生成");

    const auto& p = g.at("params");
    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::vector<Complex> x = build_input(p);

    // 输入由种子按配方复现，两侧对一份哈希——种子复刻漂了在这里当场红，而不是靠样点容差去猜
    {
        const auto& head = g.at("input").at("head");
        std::size_t bad = 0;
        for (std::size_t i = 0; i < head.size(); ++i) {
            if (static_cast<double>(x[i].real()) != head[i][0].get<double>() ||
                static_cast<double>(x[i].imag()) != head[i][1].get<double>()) ++bad;
        }
        REQUIRE_MESSAGE(bad == 0u, "输入前 " << head.size() << " 个样点里有 " << bad
                                             << " 个与基准不同：xoshiro 或单音的复刻漂了");
    }

    const double srel = g.at("tolerance").at("sample_rel").get<double>();
    const double erel = g.at("tolerance").at("energy_rel").get<double>();
    for (const auto& kv : g.at("expected").at("python").items()) {
        const std::string cid = kv.key();
        const auto& e = kv.value();
        const int d = e.at("decim").get<int>();
        const double shift = e.at("f_shift_Hz").get<double>();

        DDC ddc;
        std::string err;
        REQUIRE_MESSAGE(make(ddc, d, shift, err), err);
        std::vector<Complex> y;
        REQUIRE_MESSAGE(drive(ddc, x, fs, 4096, y, err), err);

        CHECK(static_cast<std::uint64_t>(y.size()) == e.at("n_out").get<std::uint64_t>());
        CHECK(ddc.ntaps() == e.at("ntaps").get<int>());
        CHECK(ddc.group_delay() == e.at("group_delay_in").get<int>());
        CHECK(ddc.sample_rate_out_Hz() == doctest::Approx(e.at("sample_rate_out_Hz").get<double>()));

        const auto& head = e.at("head");
        std::size_t bad = 0;
        double worst = 0.0;
        for (std::size_t i = 0; i < head.size() && i < y.size(); ++i) {
            const double wr = head[i][0].get<double>(), wi = head[i][1].get<double>();
            const double scale = std::max(1e-12, std::sqrt(wr * wr + wi * wi));
            const double dr = std::fabs(static_cast<double>(y[i].real()) - wr) / scale;
            const double di = std::fabs(static_cast<double>(y[i].imag()) - wi) / scale;
            worst = std::max(worst, std::max(dr, di));
            if (dr > srel || di > srel) ++bad;
        }
        CHECK_MESSAGE(bad == 0u, cid << "：前 " << head.size() << " 个输出里有 " << bad
                                     << " 个超出 " << srel << "，最坏 " << worst);
        const auto& tail = e.at("tail");
        for (std::size_t i = 0; i < tail.size() && i < y.size(); ++i) {
            const std::size_t k = y.size() - tail.size() + i;
            const double wr = tail[i][0].get<double>(), wi = tail[i][1].get<double>();
            const double scale = std::max(1e-12, std::sqrt(wr * wr + wi * wi));
            CHECK(std::fabs(static_cast<double>(y[k].real()) - wr) / scale < srel);
            CHECK(std::fabs(static_cast<double>(y[k].imag()) - wi) / scale < srel);
        }
        double en = 0.0;
        for (std::size_t i = 0; i < y.size(); ++i) {
            en += static_cast<double>(y[i].real()) * y[i].real() +
                  static_cast<double>(y[i].imag()) * y[i].imag();
        }
        const double en_want = e.at("energy_out").get<double>();
        CHECK_MESSAGE(std::fabs(en - en_want) / en_want < 1e-5,
                      cid << " 总能量 " << en << " 对 " << en_want);
        (void)erel;
        MESSAGE(cid << "：" << y.size() << " 个输出样点，最坏相对差 " << worst);
    }
}

TEST_CASE("标准算例第 7 项：DDC 频移、低通与抽取的解析锚点（04 §15.2）") {
    const double fs = 1.0e7;
    const std::size_t n = 200000;
    std::string err;

    SUBCASE("通带单音被搬到零频，幅度不变") {
        // 目标在 −2.5 MHz，f_shift 取 −2.5 MHz，搬到零频；抽取 2 倍后仍在通带内
        DDC d;
        REQUIRE(make(d, 2, -2.5e6, err));
        std::vector<Complex> y;
        REQUIRE(drive(d, tone(n, fs, -2.5e6, 1.0), fs, 4096, y, err));
        const double amp = mean_abs(y, 2000);
        CHECK_MESSAGE(std::fabs(20.0 * std::log10(amp)) < 0.05,
                      "通带增益 " << 20.0 * std::log10(amp) << " dB");
        // 搬到零频：输出应当近乎直流，相邻样点的相位差可忽略
        double dphi = 0.0;
        for (std::size_t i = 3000; i < 3100; ++i) {
            const std::complex<double> a(y[i].real(), y[i].imag());
            const std::complex<double> b(y[i - 1].real(), y[i - 1].imag());
            dphi = std::max(dphi, std::fabs(std::arg(a * std::conj(b))));
        }
        CHECK_MESSAGE(dphi < 1e-3, "搬移后每样点相位增量 " << dphi << " rad，应当近乎零");
    }

    SUBCASE("阻带单音被压住 ≥ 60 dB") {
        DDC d;
        REQUIRE(make(d, 2, 0.0, err));
        // D = 2：通带边 0.4·5 MHz = 2 MHz，阻带自 2.5 MHz 起。取 4 MHz 深阻带。
        std::vector<Complex> y;
        REQUIRE(drive(d, tone(n, fs, 4.0e6, 1.0), fs, 4096, y, err));
        const double amp = mean_abs(y, 4000);
        const double att = -20.0 * std::log10(std::max(amp, 1e-30));
        CHECK_MESSAGE(att >= 60.0, "阻带抑制只有 " << att << " dB");
        MESSAGE("阻带抑制 " << att << " dB");
    }

    SUBCASE("采样率与样点数按抽取比走，群时延对齐偏差 0 样点") {
        const int ds[4] = {1, 2, 4, 5};
        for (int k = 0; k < 4; ++k) {
            const int D = ds[k];
            DDC d;
            REQUIRE(make(d, D, 0.0, err));
            const int gd = d.group_delay();
            // 冲激放在 D 的整数倍上，输出峰值应当精确落在 m = n0 / D
            const std::size_t n0 = static_cast<std::size_t>(D) * 500;
            std::vector<Complex> x(n0 + 4 * static_cast<std::size_t>(gd) + 4 * static_cast<std::size_t>(D),
                                   Complex(0.0f, 0.0f));
            x[n0] = Complex(1.0f, 0.0f);
            std::vector<Complex> y;
            REQUIRE(drive(d, x, fs, 997, y, err));
            CHECK(d.sample_rate_out_Hz() == doctest::Approx(fs / D));
            const std::uint64_t want =
                x.size() > static_cast<std::size_t>(gd)
                    ? (static_cast<std::uint64_t>(x.size()) - 1 - static_cast<std::uint64_t>(gd)) /
                              static_cast<std::uint64_t>(D) + 1
                    : 0;
            CHECK(static_cast<std::uint64_t>(y.size()) == want);
            std::size_t peak = 0;
            double best = -1.0;
            for (std::size_t i = 0; i < y.size(); ++i) {
                const double a = std::sqrt(static_cast<double>(y[i].real()) * y[i].real() +
                                           static_cast<double>(y[i].imag()) * y[i].imag());
                if (a > best) { best = a; peak = i; }
            }
            CHECK_MESSAGE(peak == n0 / static_cast<std::size_t>(D),
                          "D = " << D << " 冲激峰值在 m = " << peak << "，应当是 "
                                 << n0 / static_cast<std::size_t>(D));
        }
    }

    SUBCASE("decim = 1 是纯频移：群时延 0、样点数不变") {
        DDC d;
        REQUIRE(make(d, 1, -2.5e6, err));
        CHECK(d.group_delay() == 0);
        CHECK(d.ntaps() == 1);
        std::vector<Complex> x = tone(10000, fs, 2.5e6, 1.0);
        std::vector<Complex> y;
        REQUIRE(drive(d, x, fs, 1024, y, err));
        CHECK(y.size() == x.size());
        CHECK(d.sample_rate_out_Hz() == doctest::Approx(fs));
        // +2.5 MHz 的单音经 −2.5 MHz 频移后落到零频：逐样点接近常数
        const std::complex<double> a(y[100].real(), y[100].imag());
        const std::complex<double> b(y[900].real(), y[900].imag());
        CHECK(std::abs(a - b) < 1e-4);
        // D = 1 不做奈奎斯特那道闸：不抽取就没有混叠可言，谱只是整体循环旋转。
        // 换成任何一个会让 |shift| + fs/2 超过 fs/2 的频移都应当照常跑通。
        DDC d2;
        REQUIRE(make(d2, 1, 4.9e6, err));
        std::vector<Complex> y2;
        CHECK(drive(d2, tone(2048, fs, 0.0, 1.0), fs, 512, y2, err));
        CHECK(y2.size() == 2048u);
    }
}

TEST_CASE("DDC 的引擎口径：块长无关、reset 复现、元数据与四态") {
    const double fs = 1.0e7;
    std::string err;
    Xoshiro256pp rng(20260916);
    std::vector<Complex> x(40000);
    for (std::size_t i = 0; i < x.size(); ++i) {
        float re = 0.0f, im = 0.0f;
        rng.complex_normal(re, im);
        x[i] = Complex(re, im);
    }

    SUBCASE("块长 1 / 7 / 997 / 整块的结果逐位相同") {
        DDC ref;
        REQUIRE(make(ref, 4, -2.5e6, err));
        std::vector<Complex> want;
        REQUIRE(drive(ref, x, fs, 4096, want, err));
        REQUIRE(!want.empty());
        const std::size_t blocks[4] = {1, 7, 997, 100000};
        for (int k = 0; k < 4; ++k) {
            DDC d;
            REQUIRE(make(d, 4, -2.5e6, err));
            std::vector<Complex> got;
            REQUIRE(drive(d, x, fs, blocks[k], got, err));
            REQUIRE(got.size() == want.size());
            std::size_t bad = 0;
            for (std::size_t i = 0; i < got.size(); ++i) {
                if (got[i] != want[i]) ++bad;   // 逐位，不是近似
            }
            CHECK_MESSAGE(bad == 0u, "块长 " << blocks[k] << " 有 " << bad << " 个样点与块长 4096 不同");
        }
    }

    SUBCASE("reset() 后重跑逐位相同") {
        DDC d;
        REQUIRE(make(d, 2, 1.0e6, err));
        std::vector<Complex> a, b;
        REQUIRE(drive(d, x, fs, 4096, a, err));
        d.reset();
        REQUIRE(drive(d, x, fs, 4096, b, err));
        REQUIRE(a.size() == b.size());
        std::size_t bad = 0;
        for (std::size_t i = 0; i < a.size(); ++i) if (a[i] != b[i]) ++bad;
        CHECK_MESSAGE(bad == 0u, "reset 后有 " << bad << " 个样点不同（铁律 9）");
    }

    SUBCASE("输出块元数据：采样率、中心频率、首样点序号、变速率说明") {
        DDC d;
        REQUIRE(make(d, 4, -2.5e6, err));
        PortMap in, o;
        PortData pd;
        pd.type = PortType::IQStream;
        pd.has_data = true;
        pd.iq.samples.assign(x.begin(), x.begin() + 4096);
        pd.iq.meta.sample_rate_Hz = fs;
        pd.iq.meta.center_frequency_Hz = 2.441e9;
        pd.iq.meta.start_sample = 0;
        pd.iq.meta.clip_count = 7;
        in["in"] = pd;
        REQUIRE(d.process(in, o, err) == Step::Produced);
        const BlockMeta& m = o["out"].iq.meta;
        CHECK(m.sample_rate_Hz == doctest::Approx(fs / 4.0));
        CHECK(m.center_frequency_Hz == doctest::Approx(2.441e9 - 2.5e6));
        CHECK(m.start_sample == 0u);            // 自 0 起（08 §8 口径一）
        CHECK(m.clip_count == 7u);              // 上游削顶计数跨速率带过来
        CHECK(m.state == State::Valid);         // 变速率是记录不是降级（口径四）
        bool has_note = false;
        for (std::size_t i = 0; i < m.state_reasons.size(); ++i) {
            if (m.state_reasons[i].find("ddc_rate:") == 0) has_note = true;
        }
        CHECK_MESSAGE(has_note, "输出块应当带一条变更采样率的说明（08 §8 口径四）");
        CHECK(m.trace.parameter_version == "ddc-lp_v1-d4");
    }

    SUBCASE("四态自输入块继承") {
        DDC d;
        REQUIRE(make(d, 2, 0.0, err));
        PortMap in, o;
        PortData pd;
        pd.type = PortType::IQStream;
        pd.has_data = true;
        pd.iq.samples.assign(x.begin(), x.begin() + 4096);
        pd.iq.meta.sample_rate_Hz = fs;
        pd.iq.meta.degrade("上游先降级了");
        in["in"] = pd;
        REQUIRE(d.process(in, o, err) == Step::Produced);
        CHECK(o["out"].iq.meta.state == State::Degraded);
        CHECK(d.status().state == State::Degraded);
    }
}

TEST_CASE("DDC 的错误路径：每一条都说得出缘由，不静默顶替") {
    const double fs = 1.0e7;
    std::string err;

    SUBCASE("decim 不在冻结表里，报错列出支持的取值") {
        DDC d;
        std::map<std::string, double> p;
        p["decim"] = 3;
        std::map<std::string, std::string> t;
        CHECK_FALSE(d.configure(p, t, err));
        CHECK(err.find("冻结抽头表") != std::string::npos);
        CHECK(err.find("支持的取值") != std::string::npos);
    }

    SUBCASE("decim 不是整数") {
        DDC d;
        std::map<std::string, double> p;
        p["decim"] = 2.5;
        std::map<std::string, std::string> t;
        CHECK_FALSE(d.configure(p, t, err));
        CHECK(err.find("整数") != std::string::npos);
    }

    SUBCASE("未知的 fir_version") {
        DDC d;
        std::map<std::string, double> p;
        std::map<std::string, std::string> t;
        t["fir_version"] = "lp_v9";
        CHECK_FALSE(d.configure(p, t, err));
        CHECK(err.find("fir_version") != std::string::npos);
    }

    SUBCASE("采样率不能被抽取比整除") {
        DDC d;
        REQUIRE(make(d, 4, 0.0, err));
        std::vector<Complex> y;
        CHECK_FALSE(drive(d, tone(4096, 1.0e6 + 1.0, 0.0, 1.0), 1.0e6 + 1.0, 4096, y, err));
        CHECK(err.find("整除") != std::string::npos);
    }

    SUBCASE("搬移后的窄带窗口越过输入奈奎斯特（铁律 4）") {
        DDC d;
        REQUIRE(make(d, 2, 4.5e6, err));    // |4.5| + 2.5 = 7 MHz > 5 MHz
        std::vector<Complex> y;
        CHECK_FALSE(drive(d, tone(4096, fs, 0.0, 1.0), fs, 4096, y, err));
        CHECK(err.find("奈奎斯特") != std::string::npos);
    }

    SUBCASE("输入块不连续") {
        DDC d;
        REQUIRE(make(d, 2, 0.0, err));
        PortMap in, o;
        PortData pd;
        pd.type = PortType::IQStream;
        pd.has_data = true;
        pd.iq.samples.assign(1024, Complex(0.1f, 0.1f));
        pd.iq.meta.sample_rate_Hz = fs;
        pd.iq.meta.start_sample = 0;
        in["in"] = pd;
        REQUIRE(d.process(in, o, err) != Step::Error);
        PortMap in2, o2;
        pd.iq.meta.start_sample = 5000;      // 应当是 1024
        in2["in"] = pd;
        CHECK(d.process(in2, o2, err) == Step::Error);
        CHECK(err.find("不连续") != std::string::npos);
    }

    SUBCASE("中途换采样率") {
        DDC d;
        REQUIRE(make(d, 2, 0.0, err));
        PortMap in, o;
        PortData pd;
        pd.type = PortType::IQStream;
        pd.has_data = true;
        pd.iq.samples.assign(1024, Complex(0.1f, 0.1f));
        pd.iq.meta.sample_rate_Hz = fs;
        in["in"] = pd;
        REQUIRE(d.process(in, o, err) != Step::Error);
        PortMap in2, o2;
        pd.iq.meta.sample_rate_Hz = fs / 2.0;
        pd.iq.meta.start_sample = 1024;
        in2["in"] = pd;
        CHECK(d.process(in2, o2, err) == Step::Error);
        CHECK(err.find("采样率") != std::string::npos);
    }

    SUBCASE("块长远小于群时延时空转有界，不卡死也不报错") {
        // 抽取相位每块减少一个块长，所以至多 ceil(gd / 块长) 轮之后必出第一个输出样点。
        // 这条钉住「Idle 是有界的」——它是 process() 里返回 Idle 而不是空块的前提。
        DDC d;
        REQUIRE(make(d, 20, 0.0, err));
        const int gd = d.group_delay();
        const std::size_t block = 64;
        std::vector<Complex> x(4000, Complex(0.1f, 0.1f));
        std::size_t idle_rounds = 0;
        std::uint64_t start = 0;
        bool produced = false;
        for (std::size_t off = 0; off < x.size() && !produced; off += block) {
            const std::size_t n = std::min(block, x.size() - off);
            PortMap in, o;
            PortData pd;
            pd.type = PortType::IQStream;
            pd.has_data = true;
            pd.iq.samples.assign(x.begin() + static_cast<std::ptrdiff_t>(off),
                                 x.begin() + static_cast<std::ptrdiff_t>(off + n));
            pd.iq.meta.sample_rate_Hz = fs;
            pd.iq.meta.start_sample = start;
            in["in"] = pd;
            const Step st = d.process(in, o, err);
            REQUIRE_MESSAGE(st != Step::Error, err);
            if (st == Step::Idle) ++idle_rounds; else produced = true;
            start += n;
        }
        CHECK(produced);
        const std::size_t bound = (static_cast<std::size_t>(gd) + block - 1) / block;
        CHECK_MESSAGE(idle_rounds <= bound,
                      "空转了 " << idle_rounds << " 轮，上界应当是 " << bound);
        MESSAGE("群时延 " << gd << " 个输入样点、块长 " << block << "：空转 " << idle_rounds
                          << " 轮后出第一个输出样点（上界 " << bound << "）");
    }
}
