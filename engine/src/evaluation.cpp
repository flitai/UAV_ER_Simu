#include "cuav/evaluation.h"
#include "cuav/evaluation_json.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>

namespace cuav {

namespace {

struct Interval { double a, b; };

// in_band 真值行的时间并集（帧真值只关心「有没有信号」，不关心是谁）
std::vector<Interval> union_in_band(const std::vector<TruthRow>& truth) {
    std::vector<Interval> v;
    for (const auto& r : truth) if (r.in_band) v.push_back(Interval{r.t_s, r.t_end_s});
    std::sort(v.begin(), v.end(), [](const Interval& x, const Interval& y) {
        return x.a < y.a || (x.a == y.a && x.b < y.b);
    });
    std::vector<Interval> out;
    for (const auto& iv : v) {
        if (!out.empty() && iv.a <= out.back().b) out.back().b = std::max(out.back().b, iv.b);
        else out.push_back(iv);
    }
    return out;
}

struct DetSeg {
    std::int64_t id;
    double start, end;
    bool matched = false;
    int best_truth = -1;      // 重叠最大的真值行下标（truth_sorted 里）
    double best_overlap = 0.0;
};

bool truth_less(const TruthRow& x, const TruthRow& y) {
    if (x.t_s != y.t_s) return x.t_s < y.t_s;
    if (x.emitter_id != y.emitter_id) return x.emitter_id < y.emitter_id;
    if (x.t_end_s != y.t_end_s) return x.t_end_s < y.t_end_s;
    return x.label < y.label;
}

double ratio_or_nan(std::uint64_t num, std::uint64_t den) {
    return den == 0 ? eval_nan() : static_cast<double>(num) / static_cast<double>(den);
}

}  // namespace

const std::vector<std::string>& base_labels() {
    static const std::vector<std::string> v{"video_link", "telemetry_burst", "rc_hopping", "cw_beacon"};
    return v;
}

EvaluationMetrics evaluate(const std::vector<Detection>& det_in, const std::vector<RecognitionRow>& rec_in,
                           const std::vector<TruthRow>& truth_in, const EvalParams& p) {
    EvaluationMetrics m;
    const double dt = p.frame_dt_s;

    // ---- 排序副本：检测行按帧序，真值行按 (t_s, emitter_id, t_end_s, label)，识别行按 (segment_id, t_s)
    std::vector<Detection> det(det_in);
    std::stable_sort(det.begin(), det.end(), [](const Detection& x, const Detection& y) {
        return x.frame_index < y.frame_index || (x.frame_index == y.frame_index && x.t_s < y.t_s);
    });
    std::vector<TruthRow> truth(truth_in);
    std::stable_sort(truth.begin(), truth.end(), truth_less);
    std::vector<RecognitionRow> rec(rec_in);
    std::stable_sort(rec.begin(), rec.end(), [](const RecognitionRow& x, const RecognitionRow& y) {
        return x.segment_id < y.segment_id || (x.segment_id == y.segment_id && x.t_s < y.t_s);
    });

    m.quality.truth_rows = truth.size();
    for (const auto& r : truth) if (!r.in_band) m.segments.truth_out_of_band++;

    // ---- 帧级：中点落在并集内即有信号
    const std::vector<Interval> on_iv = union_in_band(truth);
    std::vector<char> on(det.size(), 0);
    {
        std::size_t j = 0;
        for (std::size_t i = 0; i < det.size(); ++i) {
            const double mid = det[i].t_s + dt * 0.5;
            while (j < on_iv.size() && on_iv[j].b <= mid) ++j;
            on[i] = (j < on_iv.size() && on_iv[j].a <= mid) ? 1 : 0;
        }
    }
    bool threshold_varies = false;
    for (std::size_t i = 0; i < det.size(); ++i) {
        const Detection& d = det[i];
        m.frames.total++;
        if (on[i]) m.frames.truth_on++;
        if (d.hit && on[i]) m.frames.tp++;
        else if (d.hit && !on[i]) m.frames.fp++;
        else if (!d.hit && on[i]) m.frames.fn++;
        else m.frames.tn++;
        if (d.overload) m.quality.overload_frames++;
        if (!std::isnan(p.threshold) && d.threshold != p.threshold) threshold_varies = true;
    }
    m.frames.pd = ratio_or_nan(m.frames.tp, m.frames.tp + m.frames.fn);
    m.frames.pfa = ratio_or_nan(m.frames.fp, m.frames.fp + m.frames.tn);
    m.frames.precision = ratio_or_nan(m.frames.tp, m.frames.tp + m.frames.fp);
    m.frames.recall = m.frames.pd;
    if (!std::isnan(m.frames.precision) && !std::isnan(m.frames.recall)) {
        const double s = m.frames.precision + m.frames.recall;
        m.frames.f1 = s > 0.0 ? 2.0 * m.frames.precision * m.frames.recall / s : 0.0;
    }

    // ---- 检测段：命中帧按 segment_id 归组，[首帧 t_s, 末帧 t_s + dt)
    std::map<std::int64_t, DetSeg> segmap;
    std::uint64_t hits_without_segment = 0;
    for (const auto& d : det) {
        if (!d.hit) continue;
        if (d.segment_id < 0) { hits_without_segment++; continue; }
        auto it = segmap.find(d.segment_id);
        if (it == segmap.end()) {
            DetSeg s;
            s.id = d.segment_id;
            s.start = d.t_s;
            s.end = d.t_s + dt;
            segmap.insert(std::make_pair(d.segment_id, s));
        } else {
            it->second.start = std::min(it->second.start, d.t_s);
            it->second.end = std::max(it->second.end, d.t_s + dt);
        }
    }
    std::vector<DetSeg> segs;
    std::map<std::int64_t, std::size_t> seg_index;   // segment_id → segs 下标（匹配结果记在 segs 上）
    for (auto& kv : segmap) {
        seg_index[kv.first] = segs.size();
        segs.push_back(kv.second);
    }
    m.segments.detected = segs.size();

    // ---- 突发匹配
    std::vector<int> truth_idx;   // in_band 真值行在 truth 里的下标
    for (std::size_t i = 0; i < truth.size(); ++i) if (truth[i].in_band) truth_idx.push_back(static_cast<int>(i));
    m.segments.truth = truth_idx.size();
    std::vector<char> truth_matched(truth.size(), 0);
    std::vector<double> first_det_start(truth.size(), eval_nan());
    for (auto& s : segs) {
        const double len_d = s.end - s.start;
        for (int ti : truth_idx) {
            const TruthRow& r = truth[static_cast<std::size_t>(ti)];
            const double ov = std::min(s.end, r.t_end_s) - std::max(s.start, r.t_s);
            if (ov <= 0.0) continue;
            const double len_min = std::min(len_d, r.t_end_s - r.t_s);
            const double ratio = len_min > 0.0 ? ov / len_min : 0.0;
            if (ratio < p.match_overlap) continue;
            s.matched = true;
            truth_matched[static_cast<std::size_t>(ti)] = 1;
            double& fd = first_det_start[static_cast<std::size_t>(ti)];
            if (std::isnan(fd) || s.start < fd) fd = s.start;
            if (ov > s.best_overlap) { s.best_overlap = ov; s.best_truth = ti; }   // 真值已按 (t_s, emitter_id) 排好，并列取先者
        }
        if (!s.matched) m.segments.false_segments++;
    }
    {
        double acc = 0.0, mx = eval_nan();
        std::uint64_t n = 0;
        for (int ti : truth_idx) {
            const std::size_t k = static_cast<std::size_t>(ti);
            if (!truth_matched[k]) continue;
            m.segments.matched++;
            double delay = first_det_start[k] - truth[k].t_s;
            if (delay < 0.0) delay = 0.0;
            acc = acc + delay;
            n++;
            if (std::isnan(mx) || delay > mx) mx = delay;
        }
        m.segments.pd_segment = ratio_or_nan(m.segments.matched, m.segments.truth);
        m.segments.detect_delay_mean_s = n == 0 ? eval_nan() : acc / static_cast<double>(n);
        m.segments.detect_delay_max_s = mx;
    }

    // ---- ROC：统计量升序取门限，严格大于判决
    {
        std::vector<double> stats;
        stats.reserve(det.size());
        for (const auto& d : det) stats.push_back(d.statistic);
        std::sort(stats.begin(), stats.end());
        const std::uint64_t n = stats.size();
        const std::uint64_t off_total = m.frames.total - m.frames.truth_on;
        auto point_at = [&](double tau) {
            RocPoint pt;
            pt.threshold = tau;
            std::uint64_t c_on = 0, c_off = 0;
            for (std::size_t i = 0; i < det.size(); ++i) {
                if (!(det[i].statistic > tau)) continue;
                if (on[i]) c_on++; else c_off++;
            }
            pt.pd = ratio_or_nan(c_on, m.frames.truth_on);
            pt.pfa = ratio_or_nan(c_off, off_total);
            return pt;
        };
        if (n > 0) {
            const std::uint64_t P = std::max<std::size_t>(p.roc_points, 1);
            std::vector<double> taus;
            for (std::uint64_t i = 0; i < P; ++i) {
                const std::uint64_t idx = P == 1 ? 0 : (i * (n - 1)) / (P - 1);
                const double tau = stats[static_cast<std::size_t>(idx)];
                if (!taus.empty() && taus.back() == tau) continue;
                taus.push_back(tau);
            }
            for (double tau : taus) m.roc.points.push_back(point_at(tau));
        }
        if (!std::isnan(p.threshold) && n > 0) m.roc.working_point = point_at(p.threshold);
        else m.roc.working_point.threshold = p.threshold;
    }

    // ---- 识别：只对匹配上真值的检测段计
    if (!p.has_rec) {
        m.recognition.state = State::NotApplicable;
    } else {
        std::set<std::string> extra;
        std::vector<std::pair<std::string, std::string>> pairs;   // (真值标签, 识别标签)
        for (const auto& r : rec) {
            auto it = seg_index.find(r.segment_id);
            if (it == seg_index.end() || !segs[it->second].matched || segs[it->second].best_truth < 0) {
                m.recognition.unmatched++;
                continue;
            }
            const std::string t_label = truth[static_cast<std::size_t>(segs[it->second].best_truth)].label;
            const std::string p_label = r.result == "unknown" ? std::string("unknown") : r.label;
            pairs.push_back(std::make_pair(t_label, p_label));
            m.recognition.evaluated++;
            if (r.result == "unknown") m.recognition.unknown_count++;
            if (r.result == "ambiguous") m.recognition.ambiguous_count++;
            extra.insert(t_label);
            extra.insert(p_label);
        }
        for (int ti : truth_idx) extra.insert(truth[static_cast<std::size_t>(ti)].label);
        std::vector<std::string> labels = base_labels();
        for (const auto& l : labels) extra.erase(l);
        extra.erase("unknown");
        for (const auto& l : extra) labels.push_back(l);   // std::set 即字典序
        labels.push_back("unknown");
        m.recognition.labels = labels;
        std::map<std::string, std::size_t> pos;
        for (std::size_t i = 0; i < labels.size(); ++i) pos[labels[i]] = i;
        m.recognition.confusion.assign(labels.size(), std::vector<std::uint64_t>(labels.size(), 0));
        for (const auto& pr : pairs) m.recognition.confusion[pos[pr.first]][pos[pr.second]]++;
        std::uint64_t diag = 0;
        for (std::size_t i = 0; i + 1 < labels.size(); ++i) diag += m.recognition.confusion[i][i];
        m.recognition.accuracy = ratio_or_nan(diag, m.recognition.evaluated);
        m.recognition.unknown_rate = ratio_or_nan(m.recognition.unknown_count, m.recognition.evaluated);
        m.recognition.ambiguous_rate = ratio_or_nan(m.recognition.ambiguous_count, m.recognition.evaluated);
        for (std::size_t i = 0; i + 1 < labels.size(); ++i) {
            ClassMetrics c;
            c.label = labels[i];
            std::uint64_t support = 0, predicted = 0;
            for (std::size_t j = 0; j < labels.size(); ++j) {
                support += m.recognition.confusion[i][j];
                predicted += m.recognition.confusion[j][i];
            }
            const std::uint64_t tp = m.recognition.confusion[i][i];
            c.support = support;
            c.precision = ratio_or_nan(tp, predicted);
            c.recall = ratio_or_nan(tp, support);
            if (!std::isnan(c.precision) && !std::isnan(c.recall)) {
                const double s = c.precision + c.recall;
                c.f1 = s > 0.0 ? 2.0 * c.precision * c.recall / s : 0.0;
            }
            m.recognition.per_class.push_back(c);
        }
    }

    // ---- 状态
    if (p.truth_source == "none") {
        m.state = State::NotApplicable;
        m.reasons.push_back("未配置真值来源（truth_source = none），指标不适用，只有计数");
    }
    if (m.frames.total == 0) {
        m.state = worst(m.state, State::Invalid);
        m.reasons.push_back("没有收到任何检测行");
    }
    if (threshold_varies) {
        m.state = worst(m.state, State::Degraded);
        m.reasons.push_back("检测门限在运行中变化，ROC 工作点按首帧门限计");
    }
    if (hits_without_segment > 0) {
        m.state = worst(m.state, State::Degraded);
        m.reasons.push_back("有 " + std::to_string(hits_without_segment) + " 个命中帧没有突发编号，未参与突发级指标");
    }
    return m;
}

// ---------------------------------------------------------------- JSON

namespace {
using nlohmann::json;
json num(double x) { return std::isnan(x) ? json(nullptr) : json(x); }
json roc_point(const RocPoint& r) {
    return json{{"threshold", num(r.threshold)}, {"pd", num(r.pd)}, {"pfa", num(r.pfa)}};
}
}  // namespace

json metrics_section_json(const EvaluationMetrics& m, const EvalParams& p, const DetectorInfo& d,
                          const std::string& node_id, const std::string& site_id, const ModelTrace& t) {
    json points = json::array();
    for (const auto& r : m.roc.points) points.push_back(roc_point(r));
    json per_class = json::array();
    for (const auto& c : m.recognition.per_class) {
        per_class.push_back(json{{"label", c.label}, {"support", c.support}, {"precision", num(c.precision)},
                                 {"recall", num(c.recall)}, {"f1", num(c.f1)}});
    }
    json reasons = json::array();
    for (const auto& r : m.reasons) reasons.push_back(r);
    json j{
        {"node_id", node_id},
        {"site_id", site_id.empty() ? json(nullptr) : json(site_id)},
        {"truth_source", p.truth_source},
        {"params", json{{"truth_source", p.truth_source}, {"match_overlap", p.match_overlap},
                        {"roc_points", p.roc_points}, {"nfft", d.nfft}}},
        {"detector", json{{"sample_rate_Hz", d.sample_rate_Hz}, {"f_lo_Hz", d.f_lo_Hz}, {"f_hi_Hz", d.f_hi_Hz},
                          {"frame_dt_s", p.frame_dt_s}, {"threshold", num(p.threshold)}}},
        {"frames", json{{"total", m.frames.total}, {"truth_on", m.frames.truth_on}, {"tp", m.frames.tp},
                        {"fp", m.frames.fp}, {"fn", m.frames.fn}, {"tn", m.frames.tn}, {"pd", num(m.frames.pd)},
                        {"pfa", num(m.frames.pfa)}, {"precision", num(m.frames.precision)},
                        {"recall", num(m.frames.recall)}, {"f1", num(m.frames.f1)}}},
        {"segments", json{{"truth", m.segments.truth}, {"truth_out_of_band", m.segments.truth_out_of_band},
                          {"detected", m.segments.detected}, {"matched", m.segments.matched},
                          {"false_segments", m.segments.false_segments}, {"pd_segment", num(m.segments.pd_segment)},
                          {"detect_delay_s", json{{"mean", num(m.segments.detect_delay_mean_s)},
                                                  {"max", num(m.segments.detect_delay_max_s)}}}}},
        {"roc", json{{"working_point", roc_point(m.roc.working_point)}, {"points", points}}},
        {"recognition", json{{"state", to_string(m.recognition.state)}, {"labels", m.recognition.labels},
                             {"confusion", m.recognition.confusion}, {"evaluated", m.recognition.evaluated},
                             {"unmatched", m.recognition.unmatched}, {"accuracy", num(m.recognition.accuracy)},
                             {"per_class", per_class}, {"unknown_rate", num(m.recognition.unknown_rate)},
                             {"ambiguous_rate", num(m.recognition.ambiguous_rate)}}},
        {"quality", json{{"overload_frames", m.quality.overload_frames}, {"noise_stale_frames", nullptr},
                         {"truth_rows", m.quality.truth_rows}}},
        {"state", to_string(m.state)},
        {"reasons", reasons},
        {"trace", json{{"model_id", t.model_id}, {"model_version", t.model_version}, {"model_level", t.model_level},
                       {"model_layer", t.model_layer}, {"credibility", t.credibility},
                       {"parameter_version", t.parameter_version}, {"trace_id", t.trace_id},
                       {"truth_consumed", true}}},
    };
    return j;
}

}  // namespace cuav
