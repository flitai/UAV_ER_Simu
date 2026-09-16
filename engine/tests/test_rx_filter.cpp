// 接收滤波 RxFilter 的单测（M-3，D-071）。
//
// 分四组，与 test_ddc.cpp 同构：
//   ① 系数表：编译进来的表与 models/receiver/fir_rx_v1.json 逐位相同；
//   ② 黄金基准：与 algos/reference/rx_filter.py 及 MATLAB 一方逐样点对拍；
//   ③ 标准算例第 5 项（接收滤波和群时延，04 §15.2）的解析锚点；
//   ④ 引擎口径：块长无关、reset 复现、元数据与四态、错误路径。
//
// 本文件随实施分步长出来，当前是 ① 组。

#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "cuav/components/rx_filter.h"
#include "cuav/dsp.h"
#include "cuav/random.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif

std::string repo_path_rx(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

nlohmann::json load_json_rx(const std::string& path, const char* hint) {
    std::ifstream f(path.c_str());
    REQUIRE_MESSAGE(f.good(), hint);
    nlohmann::json j;
    f >> j;
    return j;
}
}  // namespace

TEST_CASE("接收滤波表：编译进来的表与 models/receiver/fir_rx_v1.json 逐位相同") {
    const nlohmann::json j = load_json_rx(repo_path_rx("models/receiver/fir_rx_v1.json"),
                                          "系数表缺失：uv run --quiet --with scipy --with numpy "
                                          "python scripts/design_rx_fir.py --write");
    const auto& entries = j.at("entries");
    CHECK(entries.size() == dsp::rx_fir_v1_count());
    std::size_t checked = 0;
    for (const auto& e : entries) {
        const double r = e.at("bw_rel").get<double>();
        const dsp::RxFirTable* t = dsp::rx_fir_v1(r);
        REQUIRE_MESSAGE(t != 0, "相对通带 " << r << " 不在编译进来的表里："
                                            "重跑 scripts/gen_fir_taps.py --kind rx");
        CHECK(t->bw_rel == r);              // 逐位：两侧是同一份十进制字面量
        CHECK(t->ntaps == e.at("ntaps").get<int>());
        CHECK(t->group_delay == e.at("group_delay_in").get<int>());
        // 群时延必须是整数样点（08 §8 口径二）：封装层要把它从 start_sample 里扣掉
        CHECK(t->ntaps % 2 == 1);
        CHECK(t->group_delay * 2 == t->ntaps - 1);

        const auto& half = e.at("half");
        REQUIRE(half.size() == static_cast<std::size_t>((t->ntaps + 1) / 2));
        std::size_t bad = 0;
        for (std::size_t k = 0; k < half.size(); ++k) {
            if (t->half[k] != half[k].get<double>()) ++bad;
        }
        CHECK_MESSAGE(bad == 0u, "bw_rel = " << r << " 有 " << bad << " 个系数与 JSON 不逐位相同");

        std::vector<double> h;
        dsp::rx_fir_expand(*t, h);
        REQUIRE(h.size() == static_cast<std::size_t>(t->ntaps));
        std::size_t asym = 0;
        for (int k = 0; k < t->ntaps / 2; ++k) {
            if (h[static_cast<std::size_t>(k)] != h[static_cast<std::size_t>(t->ntaps - 1 - k)]) ++asym;
        }
        CHECK_MESSAGE(asym == 0u, "bw_rel = " << r << " 镜像后不逐位对称");
        double sum = 0.0;
        for (std::size_t k = 0; k < h.size(); ++k) sum += h[k];
        CHECK(std::fabs(sum - 1.0) < 1e-12);
        ++checked;
    }
    MESSAGE("接收滤波表逐位核对：" << checked << " 档");
}

TEST_CASE("接收滤波表：容差只吃表示误差，不做「取最近一档」") {
    REQUIRE(dsp::rx_fir_v1_count() > 0);
    const dsp::RxFirTable& t0 = dsp::rx_fir_v1_at(0);
    // 十进制字面量与「两个 double 相除」得到的值可能差最后一位，这是要吃掉的
    const double via_div = 800000.0 / 1000000.0;      // 0.8
    CHECK(dsp::rx_fir_v1(via_div) != 0);
    CHECK(dsp::rx_fir_v1(via_div)->bw_rel == doctest::Approx(0.8));
    // 差一点点就查不到：不四舍五入到最近一档（铁律 15）
    CHECK(dsp::rx_fir_v1(0.79) == 0);
    CHECK(dsp::rx_fir_v1(0.81) == 0);
    CHECK(dsp::rx_fir_v1(0.0) == 0);
    CHECK(dsp::rx_fir_v1(0.9) == 0);    // 阻带边会顶到奈奎斯特，表里没有这一档
    CHECK(dsp::rx_fir_v1(1.0) == 0);
    for (std::size_t i = 0; i < dsp::rx_fir_v1_count(); ++i) {
        const dsp::RxFirTable& t = dsp::rx_fir_v1_at(i);
        CHECK(dsp::rx_fir_v1(t.bw_rel) == &t);
    }
    CHECK(std::string(dsp::rx_fir_v1_sha256()).size() == 64u);
    CHECK(t0.bw_rel > 0.0);
}

// --- Coder 算法核的可调用性与群时延锚点（M-3 第 4 步）-------------------------
extern "C" {
#include "cuav_rx_fir.h"
#include "cuav_rx_fir_initialize.h"
}

TEST_CASE("Coder 内核可从 C++ 调用：冲激响应峰值恰在声明的群时延处（标准算例第 5 项的锚）") {
    const dsp::RxFirTable* t = dsp::rx_fir_v1(0.8);
    REQUIRE(t != 0);
    std::vector<double> h;
    dsp::rx_fir_expand(*t, h);

    // 各档抽头数不同，内核的接口是定长的最大值：末尾补零。给 FIR 补零不改变 H(ω)，
    // 群时延仍是真实抽头数决定的 (ntaps-1)/2。
    const std::size_t NMAX = 57;
    REQUIRE(h.size() <= NMAX);
    std::vector<double> hp(NMAX, 0.0);
    for (std::size_t i = 0; i < h.size(); ++i) hp[i] = h[i];

    cuav_rx_fir_initialize();
    std::vector<creal_T> x(1024), y(1024), zi(NMAX - 1), zf(NMAX - 1);
    for (std::size_t i = 0; i < zi.size(); ++i) { zi[i].re = 0.0; zi[i].im = 0.0; }
    for (std::size_t i = 0; i < x.size(); ++i) { x[i].re = 0.0; x[i].im = 0.0; }
    const std::size_t n0 = 100;
    x[n0].re = 1.0;                       // 单位冲激

    cuav_rx_fir(&x[0], &hp[0], &zi[0], &y[0], &zf[0]);

    std::size_t peak = 0;
    double best = -1.0;
    for (std::size_t i = 0; i < y.size(); ++i) {
        const double m = std::fabs(y[i].re);
        if (m > best) { best = m; peak = i; }
    }
    // 因果输出的峰值在 n0 + gd；封装层扣掉 gd 之后输出样点 m 才对应输入样点 m（08 §8 口径二）
    CHECK_MESSAGE(peak == n0 + static_cast<std::size_t>(t->group_delay),
                  "冲激峰值在 " << peak << "，应在 " << (n0 + t->group_delay)
                                << "（= n0 + 群时延）");
    // 峰值就是中心抽头，逐位相符
    CHECK(std::fabs(best - h[static_cast<std::size_t>(t->group_delay)]) < 1e-15);
    MESSAGE("bw_rel = 0.8：抽头 " << t->ntaps << "，群时延 " << t->group_delay
                                  << " 个输入样点，冲激峰值偏差 0 样点");
}

// --- 黄金基准对拍与引擎口径（M-3 第 7 步）------------------------------------

namespace {

// 黄金基准的输入配方：噪声 + 通带单音 + 门控的阻带单音，按此次序相加、每步 float32。
// 与 algos/reference/gen_engine_golden.py 的 _m3_input 逐字同序。
std::vector<Complex> build_rx_input(const nlohmann::json& p) {
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
    for (std::size_t i = 0; i < n; ++i) {
        const double ph = wp * static_cast<double>(i);
        x[i] += Complex(static_cast<float>(amp * std::cos(ph)),
                        static_cast<float>(amp * std::sin(ph)));
    }
    const double ws = two_pi * fst / fs;
    for (std::size_t i = 0; i < n; ++i) {
        if (i < g0 || i >= g1) continue;
        const double ph = ws * static_cast<double>(i);
        x[i] += Complex(static_cast<float>(amp * std::cos(ph)),
                        static_cast<float>(amp * std::sin(ph)));
    }
    return x;
}

// 按固定块长喂一条流，收集全部输出。**flush 的产出也要收**：本组件收尾会吐出缓冲里的余量。
bool drive_rx(RxFilter& c, const std::vector<Complex>& x, double fs, std::size_t block,
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
    const Step fs2 = c.flush(fo, err);
    if (fs2 == Step::Error) return false;
    if (fo.count("out")) {
        const std::vector<Complex>& s = fo["out"].iq.samples;
        out.insert(out.end(), s.begin(), s.end());
    }
    return true;
}

bool make_rx(RxFilter& c, double bw_Hz, std::string& err) {
    std::map<std::string, double> p;
    std::map<std::string, std::string> t;
    p["bw_Hz"] = bw_Hz;
    if (!c.configure(p, t, err)) return false;
    Xoshiro256pp rng(1);
    return c.init(rng, err);
}

}  // namespace

TEST_CASE("黄金基准：RxFilter 与 algos/reference/rx_filter.py 逐样点对拍（M-3，D-071）") {
    const nlohmann::json g = load_json_rx(
        std::string(CUAV_SOURCE_DIR) + "/tests/golden/rx_filter.json",
        "黄金基准缺失：uv run --quiet --with numpy python algos/reference/gen_engine_golden.py "
        "--mode rx_filter -o engine/tests/golden/rx_filter.json");

    // 表没脱节：改了 JSON 忘了重生成 C++ 表，在对拍之前就红
    CHECK_MESSAGE(g.at("fir").at("table_sha256").get<std::string>() ==
                      std::string(dsp::rx_fir_v1_sha256()),
                  "黄金基准与编译进来的表来自不同版本的 fir_rx_v1.json，两边都要重生成");

    const nlohmann::json& p = g.at("params");
    const double fs = p.at("sample_rate_Hz").get<double>();
    const std::vector<Complex> x = build_rx_input(p);

    // 输入复刻对不对，先在这里当场红，免得错在输入却去查算法
    const auto& ih = g.at("input").at("head");
    std::size_t bad_in = 0;
    for (std::size_t i = 0; i < ih.size(); ++i) {
        if (std::fabs(x[i].real() - ih[i][0].get<double>()) > 0.0 ||
            std::fabs(x[i].imag() - ih[i][1].get<double>()) > 0.0) ++bad_in;
    }
    REQUIRE_MESSAGE(bad_in == 0u, "输入复刻与黄金基准不一致（" << bad_in << " / " << ih.size()
                                   << "）：随机源或单音公式漂了");

    const double tol = g.at("tolerance").at("sample_rel").get<double>();
    std::size_t cases = 0;
    for (auto it = g.at("expected").at("python").begin();
         it != g.at("expected").at("python").end(); ++it) {
        const nlohmann::json& e = it.value();
        const double bw_rel = e.at("bw_rel").get<double>();
        RxFilter c;
        std::string err;
        REQUIRE_MESSAGE(make_rx(c, bw_rel * fs, err), err);
        std::vector<Complex> y;
        REQUIRE_MESSAGE(drive_rx(c, x, fs, 4096, y, err), err);

        CHECK(c.ntaps() == e.at("ntaps").get<int>());
        CHECK(c.group_delay() == e.at("group_delay_in").get<int>());
        CHECK(y.size() == e.at("n_out").get<std::size_t>());

        const auto& head = e.at("head");
        double worst = 0.0;
        double scale = 0.0;
        for (std::size_t i = 0; i < head.size() && i < y.size(); ++i) {
            const double wr = head[i][0].get<double>(), wi = head[i][1].get<double>();
            scale = std::max(scale, std::sqrt(wr * wr + wi * wi));
        }
        for (std::size_t i = 0; i < head.size() && i < y.size(); ++i) {
            const double wr = head[i][0].get<double>(), wi = head[i][1].get<double>();
            const double dr = y[i].real() - wr, di = y[i].imag() - wi;
            worst = std::max(worst, std::sqrt(dr * dr + di * di));
        }
        CHECK_MESSAGE(worst <= tol * scale,
                      it.key() << " 前 " << head.size() << " 个输出的最大相对差 "
                               << (worst / scale) << " 超过 " << tol);
        ++cases;
        if (cases == 1) MESSAGE(it.key() << "：" << y.size() << " 个输出，最大相对差 "
                                         << (worst / scale));
    }
    CHECK(cases == 3u);
}

TEST_CASE("RxFilter 的引擎口径：块长无关、reset 复现、元数据与四态") {
    const double fs = 1.0e7;
    const std::size_t n = 20000;
    std::vector<Complex> x(n);
    Xoshiro256pp rng(20260918);
    for (std::size_t i = 0; i < n; ++i) {
        float re = 0.0f, im = 0.0f;
        rng.complex_normal(re, im);
        x[i] = Complex(re, im);
    }

    SUBCASE("块长无关：1 / 7 / 997 / 整块的结果逐位相同") {
        std::string err;
        RxFilter a;
        REQUIRE(make_rx(a, 0.8 * fs, err));
        std::vector<Complex> ref;
        REQUIRE_MESSAGE(drive_rx(a, x, fs, 4096, ref, err), err);
        REQUIRE(ref.size() == n - static_cast<std::size_t>(a.group_delay()));
        const std::size_t blocks[] = {1, 7, 997, n};
        for (std::size_t bi = 0; bi < 4; ++bi) {
            RxFilter b;
            REQUIRE(make_rx(b, 0.8 * fs, err));
            std::vector<Complex> got;
            REQUIRE_MESSAGE(drive_rx(b, x, fs, blocks[bi], got, err), err);
            REQUIRE(got.size() == ref.size());
            std::size_t diff = 0;
            for (std::size_t i = 0; i < got.size(); ++i) if (got[i] != ref[i]) ++diff;
            CHECK_MESSAGE(diff == 0u, "块长 " << blocks[bi] << " 有 " << diff << " 个样点不同");
        }
    }

    SUBCASE("reset 之后重跑逐位相同（铁律 9）") {
        std::string err;
        RxFilter c;
        REQUIRE(make_rx(c, 0.5 * fs, err));
        std::vector<Complex> a, b;
        REQUIRE(drive_rx(c, x, fs, 2048, a, err));
        c.reset();
        REQUIRE(drive_rx(c, x, fs, 2048, b, err));
        REQUIRE(a.size() == b.size());
        std::size_t diff = 0;
        for (std::size_t i = 0; i < a.size(); ++i) if (a[i] != b[i]) ++diff;
        CHECK(diff == 0u);
    }

    SUBCASE("元数据：采样率与中心频率不变，start_sample 自 0 起，削顶计数与四态照传") {
        std::string err;
        RxFilter c;
        REQUIRE(make_rx(c, 0.8 * fs, err));
        PortMap in, o;
        PortData pd;
        pd.type = PortType::IQStream;
        pd.has_data = true;
        pd.iq.samples.assign(x.begin(), x.begin() + 4096);
        pd.iq.meta.sample_rate_Hz = fs;
        pd.iq.meta.center_frequency_Hz = 2.441e9;
        pd.iq.meta.start_sample = 0;
        pd.iq.meta.continuous_with_previous = true;
        pd.iq.meta.clip_count = 7;
        pd.iq.meta.state = State::Degraded;
        pd.iq.meta.state_reasons.push_back("上游的降级理由");
        in["in"] = pd;
        REQUIRE(c.process(in, o, err) == Step::Produced);
        REQUIRE(o.count("out") == 1u);
        const Block& b = o["out"].iq;
        CHECK(b.meta.sample_rate_Hz == fs);                    // 不抽取
        CHECK(b.meta.center_frequency_Hz == 2.441e9);          // 不搬移
        CHECK(b.meta.start_sample == 0u);
        CHECK(b.meta.clip_count == 7u);
        CHECK(b.meta.state == State::Degraded);                // 四态照传，不自作主张
        CHECK(c.status().state == State::Degraded);
        CHECK(b.meta.trace.parameter_version.substr(0, 7) == "rxfilt-");
        bool has_note = false;
        for (std::size_t i = 0; i < b.meta.state_reasons.size(); ++i) {
            if (b.meta.state_reasons[i].substr(0, 7) == "rxfilt:") has_note = true;
        }
        CHECK_MESSAGE(has_note, "首块应当留一条记录性的说明（08 §8 口径四）");
    }
}

TEST_CASE("RxFilter 的错误路径：每一条都说得出缘由，不静默顶替") {
    std::string err;
    const double fs = 1.0e7;

    SUBCASE("缺必填的 bw_Hz") {
        RxFilter c;
        std::map<std::string, double> p;
        std::map<std::string, std::string> t;
        CHECK_FALSE(c.configure(p, t, err));
        CHECK(err.find("bw_Hz") != std::string::npos);
    }
    SUBCASE("bw_Hz 不是正数") {
        RxFilter c;
        std::map<std::string, double> p;
        std::map<std::string, std::string> t;
        p["bw_Hz"] = -1.0;
        CHECK_FALSE(c.configure(p, t, err));
    }
    SUBCASE("未知的 fir_version") {
        RxFilter c;
        std::map<std::string, double> p;
        std::map<std::string, std::string> t;
        p["bw_Hz"] = 8e6;
        t["fir_version"] = "rx_v9";
        CHECK_FALSE(c.configure(p, t, err));
        CHECK(err.find("rx_v9") != std::string::npos);
    }
    SUBCASE("bw_Hz / fs 不在表里：报错并列出该采样率下可取的值") {
        RxFilter c;
        REQUIRE(make_rx(c, 6.4e6, err));            // 6.4 / 10 = 0.64，表里没有
        std::vector<Complex> y;
        std::vector<Complex> x(100, Complex(0.0f, 0.0f));
        CHECK_FALSE(drive_rx(c, x, fs, 100, y, err));
        CHECK(err.find("不在冻结抽头表内") != std::string::npos);
        CHECK_MESSAGE(err.find("可取的 bw_Hz") != std::string::npos,
                      "报错要列出该采样率下可取的值（铁律 15）：" << err);
        CHECK(err.find("8000000") != std::string::npos);   // 0.8 档在当前 fs 下就是 8 MHz
        MESSAGE(err);
    }
    SUBCASE("输入块不连续") {
        RxFilter c;
        REQUIRE(make_rx(c, 8e6, err));
        std::vector<Complex> x(2048, Complex(1.0f, 0.0f));
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
        pd.iq.meta.start_sample = 9999;     // 跳号
        in2["in"] = pd;
        CHECK(c.process(in2, o2, err) == Step::Error);
        CHECK(err.find("不连续") != std::string::npos);
    }
    SUBCASE("中途换采样率") {
        RxFilter c;
        REQUIRE(make_rx(c, 8e6, err));
        std::vector<Complex> x(2048, Complex(1.0f, 0.0f));
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
        pd.iq.meta.start_sample = 2048;
        pd.iq.meta.sample_rate_Hz = 5e6;
        in2["in"] = pd;
        CHECK(c.process(in2, o2, err) == Step::Error);
        CHECK(err.find("采样率") != std::string::npos);
    }
}
