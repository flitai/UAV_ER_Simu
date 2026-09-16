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

#include "cuav/dsp.h"
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
