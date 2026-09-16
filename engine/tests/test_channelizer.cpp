// 多相 FFT 信道化 Channelizer 的单测（M-3，D-071）。
//
// 分四组，与 test_ddc.cpp 同构：
//   ① 系数表：编译进来的表与 models/channelizer/fir_pfb_v1.json 逐位相同；
//   ② 黄金基准：与 algos/reference/channelizer.py 及 MATLAB 一方逐样点对拍；
//   ③ 标准算例第 8 项（宽带 IQ 到信道化 IQ，04 §15.2）的解析锚点；
//   ④ 引擎口径：块长无关、reset 复现、元数据与四态、错误路径。
//
// 本文件随实施分步长出来，当前是 ① 组。

#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "cuav/dsp.h"
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
#include "cuav_pfb_m8.h"
#include "cuav_pfb_m2_initialize.h"
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
