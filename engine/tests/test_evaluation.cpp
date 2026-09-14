// 评价纯函数层的单测与黄金基准对拍（C-5，D-067）。
// 黄金基准 tests/golden/metrics.json 由 algos/reference/evaluate.py --write-golden 生成：
// 同一组检测 / 识别 / 真值行喂给引擎的 evaluate()，落盘形状经 metrics_section_json() 与 expected 逐值比。
#include "doctest/doctest.h"

#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/evaluation.h"
#include "cuav/evaluation_json.h"

using namespace cuav;
using nlohmann::json;

namespace {

std::string metrics_golden_path() {
    return std::string(CUAV_SOURCE_DIR) + "/tests/golden/metrics.json";
}

// 按 expected 的结构递归比：数值相对误差 1e-9（近零绝对 1e-12），null 对 null，字串与布尔逐字
void compare_json(const json& exp, const json& act, const std::string& path, int& mismatches) {
    if (exp.is_object()) {
        REQUIRE_MESSAGE(act.is_object(), path << " 期望对象");
        for (auto it = exp.begin(); it != exp.end(); ++it) {
            if (!act.contains(it.key())) {
                mismatches++;
                FAIL_CHECK(path << "." << it.key() << " 实际缺键");
                continue;
            }
            compare_json(it.value(), act[it.key()], path + "." + it.key(), mismatches);
        }
        return;
    }
    if (exp.is_array()) {
        REQUIRE_MESSAGE((act.is_array() && act.size() == exp.size()), path << " 长度 " << exp.size());
        for (std::size_t i = 0; i < exp.size(); ++i) compare_json(exp[i], act[i], path + "[" + std::to_string(i) + "]", mismatches);
        return;
    }
    if (exp.is_null() || act.is_null()) {
        if (!(exp.is_null() && act.is_null())) { mismatches++; FAIL_CHECK(path << ": " << exp.dump() << " 对 " << act.dump()); }
        return;
    }
    if (exp.is_boolean() || exp.is_string()) {
        if (exp != act) { mismatches++; FAIL_CHECK(path << ": " << exp.dump() << " 对 " << act.dump()); }
        return;
    }
    if (exp.is_number_integer() && act.is_number_integer()) {
        if (exp.get<long long>() != act.get<long long>()) { mismatches++; FAIL_CHECK(path << ": " << exp.dump() << " 对 " << act.dump()); }
        return;
    }
    REQUIRE_MESSAGE(act.is_number(), path << " 期望数值");
    const double e = exp.get<double>(), a = act.get<double>();
    const double err = std::fabs(e - a);
    if (err > 1e-12 && err > 1e-9 * std::max(std::fabs(e), std::fabs(a))) {
        mismatches++;
        FAIL_CHECK(path << ": " << e << " 对 " << a << "（差 " << err << "）");
    }
}

Detection det_row(std::uint64_t frame, double t_s, double stat, double thr, bool hit, std::int64_t seg, bool overload = false) {
    Detection d;
    d.frame_index = frame;
    d.start_sample = frame * 256;
    d.t_s = t_s;
    d.statistic = stat;
    d.threshold = thr;
    d.hit = hit;
    d.segment_id = seg;
    d.overload = overload;
    return d;
}

TruthRow truth_row(double a, double b, const std::string& em, const std::string& label, bool in_band = true) {
    TruthRow r;
    r.t_s = a; r.t_end_s = b; r.emitter_id = em; r.label = label; r.waveform = "tone"; r.in_band = in_band;
    return r;
}

RecognitionRow rec_row(std::int64_t seg, const std::string& label, const std::string& result, double t0 = 0.0, double t1 = 0.0) {
    RecognitionRow r;
    r.segment_id = seg; r.label = label; r.result = result; r.t_s = t0; r.t_end_s = t1;
    return r;
}

}  // namespace

TEST_CASE("黄金基准：评价器的帧级 / 突发级 / ROC / 混淆矩阵逐值复现 Python 参考实现（C-5）") {
    std::ifstream f(metrics_golden_path().c_str());
    REQUIRE_MESSAGE(f.good(), "黄金基准缺失：uv run --quiet python algos/reference/evaluate.py --write-golden engine/tests/golden/metrics.json");
    json g;
    f >> g;
    REQUIRE(g["schema"].get<std::string>() == "cuav-engine-golden/1");

    std::vector<Detection> det;
    for (const auto& r : g["inputs"]["detections"]) {
        det.push_back(det_row(r["frame_index"].get<std::uint64_t>(), r["t_s"].get<double>(), r["statistic"].get<double>(),
                              r["threshold"].get<double>(), r["hit"].get<bool>(),
                              r["segment_id"].is_null() ? -1 : r["segment_id"].get<std::int64_t>(), r["overload"].get<bool>()));
    }
    std::vector<RecognitionRow> rec;
    for (const auto& r : g["inputs"]["recognitions"]) {
        rec.push_back(rec_row(r["segment_id"].get<std::int64_t>(), r["label"].get<std::string>(), r["result"].get<std::string>(),
                              r["t_s"].get<double>(), r["t_end_s"].get<double>()));
    }
    std::vector<TruthRow> truth;
    for (const auto& r : g["inputs"]["truth"]) {
        TruthRow t = truth_row(r["t_s"].get<double>(), r["t_end_s"].get<double>(), r["emitter_id"].get<std::string>(),
                               r["label"].get<std::string>(), r["in_band"].get<bool>());
        t.waveform = r["waveform"].get<std::string>();
        t.center_Hz = r["center_Hz"].get<double>();
        t.bw_Hz = r["bw_Hz"].get<double>();
        truth.push_back(t);
    }
    EvalParams p;
    p.truth_source = g["params"]["truth_source"].get<std::string>();
    p.match_overlap = g["params"]["match_overlap"].get<double>();
    p.roc_points = g["params"]["roc_points"].get<std::size_t>();
    p.frame_dt_s = g["params"]["frame_dt_s"].get<double>();
    p.threshold = g["params"]["threshold"].get<double>();
    p.has_rec = g["params"]["has_rec"].get<bool>();

    const EvaluationMetrics m = evaluate(det, rec, truth, p);
    DetectorInfo di;
    di.nfft = 256; di.sample_rate_Hz = 1e6; di.f_lo_Hz = 2.4405e9 - 225e3; di.f_hi_Hz = 2.4405e9 + 225e3;
    ModelTrace tr;
    tr.model_id = "eval-baseline";
    const json sec = metrics_section_json(m, p, di, "eval", "site-1", tr);

    int mismatches = 0;
    const json& exp = g["expected"];
    for (const char* key : {"frames", "segments", "roc", "recognition"}) compare_json(exp[key], sec[key], key, mismatches);
    compare_json(exp["quality"]["overload_frames"], sec["quality"]["overload_frames"], "quality.overload_frames", mismatches);
    compare_json(exp["quality"]["truth_rows"], sec["quality"]["truth_rows"], "quality.truth_rows", mismatches);
    compare_json(exp["state"], sec["state"], "state", mismatches);
    compare_json(exp["reasons"], sec["reasons"], "reasons", mismatches);
    CHECK(mismatches == 0);
    CHECK(sec["quality"]["noise_stale_frames"].is_null());   // 端口上拿不到，写 null 不编（D-067）
    CHECK(sec["trace"]["truth_consumed"].get<bool>());
    CHECK(sec["site_id"].get<std::string>() == "site-1");
    MESSAGE("帧 " << m.frames.total << " pd " << m.frames.pd << " pfa " << m.frames.pfa << "；段 匹配 " << m.segments.matched
            << "/" << m.segments.truth << "；识别准确率 " << m.recognition.accuracy << "；ROC 点 " << m.roc.points.size());
}

TEST_CASE("评价：没有检测行即 invalid，所有比值为 NaN，ROC 无点") {
    EvalParams p;
    p.frame_dt_s = 1e-3;
    const EvaluationMetrics m = evaluate({}, {}, {}, p);
    CHECK(m.state == State::Invalid);
    CHECK(m.frames.total == 0);
    CHECK(std::isnan(m.frames.pd));
    CHECK(std::isnan(m.frames.pfa));
    CHECK(m.roc.points.empty());
    CHECK(std::isnan(m.segments.pd_segment));
    const json j = metrics_section_json(m, p, DetectorInfo(), "eval", "", ModelTrace());
    CHECK(j["frames"]["pd"].is_null());
    CHECK(j["site_id"].is_null());            // 未绑站：null 不是空串
}

TEST_CASE("评价：帧中点规则是半开区间，帧数少于 ROC 点数时门限去重") {
    // 取二进制可精确表示的时刻，边界判据才不被 1 ulp 左右（两侧实现同式，判据本身不怕 ulp，测试的期望值怕）
    const double dt = 0.5;
    std::vector<Detection> det;
    // 帧 0 [0, 0.5) 中点 0.25；帧 1 中点 0.75；帧 2 中点 1.25；帧 3 中点 1.75
    det.push_back(det_row(0, 0.0, 0.5, 1.0, false, -1));
    det.push_back(det_row(1, 0.5, 1.5, 1.0, true, 0));
    det.push_back(det_row(2, 1.0, 1.5, 1.0, true, 0));
    det.push_back(det_row(3, 1.5, 0.5, 1.0, false, -1));
    std::vector<TruthRow> truth{truth_row(0.75, 1.75, "e1", "cw_beacon")};   // 帧 1 中点恰在起点（含），帧 3 中点恰在终点（不含）
    EvalParams p;
    p.frame_dt_s = dt;
    p.threshold = 1.0;
    p.roc_points = 32;
    const EvaluationMetrics m = evaluate(det, {}, truth, p);
    CHECK(m.frames.truth_on == 2);
    CHECK(m.frames.tp == 2);
    CHECK(m.frames.fp == 0);
    CHECK(m.frames.fn == 0);
    CHECK(m.frames.tn == 2);
    CHECK(m.frames.pd == 1.0);
    CHECK(m.frames.pfa == 0.0);
    CHECK(m.roc.points.size() == 2);          // 只有两个不同的统计量取值
    CHECK(m.roc.working_point.pd == 1.0);
    CHECK(m.segments.detected == 1);
    CHECK(m.segments.matched == 1);           // 检测段 [0.5, 1.5) 与真值 [0.75, 1.75) 重叠 0.75 / min(1.0, 1.0) = 0.75
    CHECK(m.segments.detect_delay_mean_s == 0.0);   // 检测先于真值起点 → 钳到 0
    CHECK(m.recognition.state == State::NotApplicable);
    CHECK(m.state == State::Valid);
}

TEST_CASE("评价：识别真值取重叠最大的真值段，并列取 t_s 早者；未匹配的识别行只计数；出现新标签时矩阵扩列") {
    const double dt = 0.01;
    std::vector<Detection> det;
    for (std::uint64_t i = 0; i < 10; ++i) det.push_back(det_row(i, 0.01 * i, i >= 2 && i < 6 ? 2.0 : 0.5, 1.0, i >= 2 && i < 6, i >= 2 && i < 6 ? 0 : -1));
    det.push_back(det_row(10, 0.10, 2.0, 1.0, true, 1));   // 第二段：无真值
    // 两个真值段与检测段 [0.02, 0.06) 重叠相同（都 0.02），并列取 t_s 早的 e-a
    std::vector<TruthRow> truth{truth_row(0.02, 0.04, "e-a", "telemetry_burst"), truth_row(0.04, 0.06, "e-b", "cw_beacon")};
    std::vector<RecognitionRow> rec{rec_row(0, "wifi", "known"), rec_row(1, "cw_beacon", "known")};
    EvalParams p;
    p.frame_dt_s = dt;
    p.threshold = 1.0;
    p.has_rec = true;
    const EvaluationMetrics m = evaluate(det, rec, truth, p);
    CHECK(m.recognition.evaluated == 1);
    CHECK(m.recognition.unmatched == 1);
    CHECK(m.segments.false_segments == 1);
    CHECK(m.segments.matched == 2);           // 两段真值都被同一检测段匹配（各 100% 覆盖）
    REQUIRE(m.recognition.labels.size() == 6);
    CHECK(m.recognition.labels[4] == "wifi");
    CHECK(m.recognition.labels[5] == "unknown");
    CHECK(m.recognition.confusion[1][4] == 1);   // 真值 telemetry_burst（并列取 e-a）→ 识别 wifi
    CHECK(m.recognition.accuracy == 0.0);
    CHECK(m.recognition.per_class[1].support == 1);
    CHECK(std::isnan(m.recognition.per_class[1].precision));   // 从未预测为 telemetry_burst：0/0
}

TEST_CASE("评价：truth_source = none 即 not_applicable 但计数照给；门限变化记降级") {
    std::vector<Detection> det{det_row(0, 0.0, 1.5, 1.0, true, 0), det_row(1, 0.01, 0.5, 1.1, false, -1)};
    EvalParams p;
    p.frame_dt_s = 0.01;
    p.threshold = 1.0;
    p.truth_source = "none";
    const EvaluationMetrics m = evaluate(det, {}, {}, p);
    CHECK(m.state == State::Degraded);        // none → not_applicable，门限变化 → degraded 更差
    CHECK(m.frames.fp == 1);
    CHECK(m.reasons.size() == 2);
}
