#include "cuav/components/recognition.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <numeric>
#include <set>

#include "nlohmann/json.hpp"

#include "cuav/observer.h"

namespace cuav {
namespace {

double get(const std::map<std::string, double>& p, const std::string& k, double dflt) {
    auto it = p.find(k);
    return it == p.end() ? dflt : it->second;
}

// 特征质量的序（EM-S-03 §10.13）：min_quality 之下的直接 unknown_low_quality
int quality_rank(const std::string& q) {
    if (q == "full") return 3;
    if (q == "overload") return 2;
    if (q == "short") return 1;
    if (q == "low_snr") return 0;
    return -1;
}

// 库里允许引用的特征名：都是 FeatureRow 里有的量。未知名字在装载时拒，不在匹配时静默当缺失。
const char* const kKnownFeatures[] = {
    "bandwidth_Hz", "duration_s", "duty", "spectral_flatness", "hop_from_prev_Hz", "interval_from_prev_s",
    "center_Hz", "snr_dB", "crest_factor_dB", "band_power_dBm", "peak_dBm",
};

bool known_feature(const std::string& n) {
    for (const char* k : kKnownFeatures) if (n == k) return true;
    return false;
}

bool check_keys(const nlohmann::json& o, const std::set<std::string>& allowed, const std::string& who, std::string& err) {
    for (auto it = o.begin(); it != o.end(); ++it) {
        if (!allowed.count(it.key())) { err = who + " 有未知键 " + it.key(); return false; }
    }
    return true;
}

}  // namespace

// --------------------------------------------------------------------- 模板库

bool TemplateClassifier::load_library(const std::string& path, Library& lib, std::string& err) {
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f.good()) { err = "模板库打不开：" + path; return false; }
    nlohmann::json j;
    try { f >> j; } catch (const std::exception& e) { err = "模板库不是合法 JSON：" + path + "：" + e.what(); return false; }
    if (!j.is_object()) { err = "模板库顶层必须是对象"; return false; }
    static const std::set<std::string> kTop = {"schema", "library_version", "label_layer", "source", "notes", "distance",
                                               "feature_order", "features", "templates", "scenario_waveform_map"};
    if (!check_keys(j, kTop, "模板库", err)) return false;
    if (!j.contains("schema") || !j["schema"].is_string() || j["schema"] != "cuav-recognition-library/1") {
        err = "模板库 schema 必须是 cuav-recognition-library/1"; return false;
    }
    for (const char* k : {"library_version", "source", "distance", "feature_order", "features", "templates"}) {
        if (!j.contains(k)) { err = std::string("模板库缺 ") + k; return false; }
    }
    if (!j["library_version"].is_string() || !j["source"].is_string()) { err = "模板库的 library_version / source 必须是字符串"; return false; }
    Library out;
    out.version = j["library_version"].get<std::string>();
    out.source = j["source"].get<std::string>();

    const nlohmann::json& dist = j["distance"];
    if (!dist.is_object()) { err = "模板库 distance 必须是对象"; return false; }
    static const std::set<std::string> kDist = {"log_scale", "log_floor"};
    if (!check_keys(dist, kDist, "模板库 distance", err)) return false;
    if (!dist.contains("log_scale") || !dist["log_scale"].is_number() || !(dist["log_scale"].get<double>() > 0.0)) {
        err = "模板库 distance.log_scale 必须是正数"; return false;
    }
    out.log_scale = dist["log_scale"].get<double>();
    std::map<std::string, double> floors;
    if (dist.contains("log_floor")) {
        if (!dist["log_floor"].is_object()) { err = "模板库 distance.log_floor 必须是对象"; return false; }
        for (auto it = dist["log_floor"].begin(); it != dist["log_floor"].end(); ++it) {
            if (!it.value().is_number() || !(it.value().get<double>() > 0.0)) { err = "模板库 log_floor." + it.key() + " 必须是正数"; return false; }
            floors[it.key()] = it.value().get<double>();
        }
    }

    const nlohmann::json& order = j["feature_order"];
    const nlohmann::json& feats = j["features"];
    if (!order.is_array() || order.empty()) { err = "模板库 feature_order 必须是非空数组"; return false; }
    if (!feats.is_object()) { err = "模板库 features 必须是对象"; return false; }
    std::set<std::string> seen;
    for (const auto& n : order) {
        if (!n.is_string()) { err = "模板库 feature_order 的元素必须是字符串"; return false; }
        const std::string name = n.get<std::string>();
        if (!seen.insert(name).second) { err = "模板库 feature_order 重复：" + name; return false; }
        if (!known_feature(name)) { err = "模板库引用了特征行里没有的特征：" + name; return false; }
        if (!feats.contains(name)) { err = "模板库 feature_order 里的 " + name + " 在 features 里没有定义"; return false; }
        const nlohmann::json& fd = feats[name];
        if (!fd.is_object()) { err = "模板库 features." + name + " 必须是对象"; return false; }
        static const std::set<std::string> kFeat = {"domain", "abs"};
        if (!check_keys(fd, kFeat, "模板库 features." + name, err)) return false;
        if (!fd.contains("domain") || !fd["domain"].is_string()) { err = "模板库 features." + name + " 缺 domain"; return false; }
        const std::string domain = fd["domain"].get<std::string>();
        if (domain != "log" && domain != "linear") { err = "模板库 features." + name + ".domain 必须是 log / linear"; return false; }
        FeatureDef def;
        def.name = name;
        def.log = domain == "log";
        if (fd.contains("abs")) {
            if (!fd["abs"].is_boolean()) { err = "模板库 features." + name + ".abs 必须是布尔"; return false; }
            def.abs = fd["abs"].get<bool>();
        }
        if (def.log) {
            auto fl = floors.find(name);
            if (fl == floors.end()) { err = "模板库对数域特征 " + name + " 缺 distance.log_floor"; return false; }
            def.floor = fl->second;
        }
        out.features.push_back(def);
    }
    for (auto it = feats.begin(); it != feats.end(); ++it) {
        if (!seen.count(it.key())) { err = "模板库 features 里的 " + it.key() + " 不在 feature_order 里"; return false; }
    }

    const nlohmann::json& tpls = j["templates"];
    if (!tpls.is_array() || tpls.empty()) { err = "模板库 templates 必须是非空数组"; return false; }
    std::set<std::string> labels;
    for (const auto& t : tpls) {
        if (!t.is_object()) { err = "模板库 templates 的元素必须是对象"; return false; }
        static const std::set<std::string> kTpl = {"label", "description", "intervals", "weights"};
        if (!check_keys(t, kTpl, "模板", err)) return false;
        if (!t.contains("label") || !t["label"].is_string() || t["label"].get<std::string>().empty()) { err = "模板缺 label"; return false; }
        Template tp;
        tp.label = t["label"].get<std::string>();
        if (tp.label == "unknown") { err = "模板标签不能叫 unknown：那是开放集的保留名"; return false; }
        if (!labels.insert(tp.label).second) { err = "模板标签重复：" + tp.label; return false; }
        if (t.contains("description")) {
            if (!t["description"].is_string()) { err = "模板 " + tp.label + " 的 description 必须是字符串"; return false; }
            tp.description = t["description"].get<std::string>();
        }
        if (!t.contains("intervals") || !t["intervals"].is_object() || t["intervals"].empty()) { err = "模板 " + tp.label + " 缺 intervals"; return false; }
        if (!t.contains("weights") || !t["weights"].is_object()) { err = "模板 " + tp.label + " 缺 weights"; return false; }
        const std::size_t n = out.features.size();
        tp.used.assign(n, false);
        tp.lo.assign(n, 0.0);
        tp.hi.assign(n, 0.0);
        tp.has_hi.assign(n, false);
        tp.weight.assign(n, 0.0);
        const nlohmann::json& iv = t["intervals"];
        const nlohmann::json& ws = t["weights"];
        for (auto it = iv.begin(); it != iv.end(); ++it) {
            std::size_t i = n;
            for (std::size_t q = 0; q < n; ++q) if (out.features[q].name == it.key()) { i = q; break; }
            if (i == n) { err = "模板 " + tp.label + " 的区间引用了 feature_order 之外的特征 " + it.key(); return false; }
            const nlohmann::json& v = it.value();
            if (!v.is_array() || v.size() != 2 || !v[0].is_number() || !(v[1].is_number() || v[1].is_null())) {
                err = "模板 " + tp.label + " 的 " + it.key() + " 区间必须是 [下界, 上界或 null]"; return false;
            }
            const double lo = v[0].get<double>();
            const bool has_hi = v[1].is_number();
            const double hi = has_hi ? v[1].get<double>() : 0.0;
            if (out.features[i].log) {
                if (lo < 0.0) { err = "模板 " + tp.label + " 的 " + it.key() + " 下界不能为负（对数域）"; return false; }
                if (has_hi && !(hi > lo)) { err = "模板 " + tp.label + " 的 " + it.key() + " 上界必须大于下界"; return false; }
            } else {
                if (!has_hi) { err = "模板 " + tp.label + " 的 " + it.key() + " 是线性特征，上界不能省（尺度取半区间宽）"; return false; }
                if (!(hi > lo)) { err = "模板 " + tp.label + " 的 " + it.key() + " 上界必须大于下界"; return false; }
            }
            if (!ws.contains(it.key()) || !ws[it.key()].is_number() || !(ws[it.key()].get<double>() > 0.0)) {
                err = "模板 " + tp.label + " 的 " + it.key() + " 缺正的权重"; return false;
            }
            tp.used[i] = true;
            tp.lo[i] = lo;
            tp.hi[i] = hi;
            tp.has_hi[i] = has_hi;
            tp.weight[i] = ws[it.key()].get<double>();
        }
        for (auto it = ws.begin(); it != ws.end(); ++it) {
            if (!iv.contains(it.key())) { err = "模板 " + tp.label + " 给了 " + it.key() + " 权重却没有区间"; return false; }
        }
        out.templates.push_back(tp);
    }
    lib = out;
    return true;
}

// ------------------------------------------------------------------- 组件

bool TemplateClassifier::configure(const std::map<std::string, double>& params,
                                   const std::map<std::string, std::string>& text_params,
                                   std::string& err) {
    accept_threshold_ = get(params, "accept_threshold", 0.5);
    if (!(accept_threshold_ >= 0.0 && accept_threshold_ <= 1.0)) { err = "TemplateClassifier 的 accept_threshold 必须在 [0,1]"; return false; }
    ambiguity_margin_ = get(params, "ambiguity_margin", 0.2);
    if (!(ambiguity_margin_ >= 0.0 && ambiguity_margin_ <= 1.0)) { err = "TemplateClassifier 的 ambiguity_margin 必须在 [0,1]"; return false; }
    unknown_distance_ = get(params, "unknown_distance", 4.0);
    if (unknown_distance_ < 0.0) { err = "TemplateClassifier 的 unknown_distance 不得为负"; return false; }
    min_quality_ = "short";
    auto mq = text_params.find("min_quality");
    if (mq != text_params.end() && !mq->second.empty()) min_quality_ = mq->second;
    if (quality_rank(min_quality_) < 0) { err = "TemplateClassifier 的 min_quality 必须是 full / overload / short / low_snr"; return false; }
    library_version_ = "v1";
    auto lv = text_params.find("library_version");
    if (lv != text_params.end() && !lv->second.empty()) library_version_ = lv->second;
    auto lp = text_params.find("library_path");
    if (lp == text_params.end() || lp->second.empty()) {
        err = "TemplateClassifier 缺内部参数 library_path：由装载器按 library_version 从模板库目录注入（D-037），框图里只写 library_version";
        return false;
    }
    library_path_ = lp->second;
    std::string e;
    if (!load_library(library_path_, lib_, e)) { err = "TemplateClassifier 的模板库 " + library_path_ + "：" + e; return false; }
    if (lib_.version != library_version_) {
        err = "TemplateClassifier 的模板库文件声明 library_version = " + lib_.version + "，与参数 " + library_version_ + " 不同";
        return false;
    }
    auto sid = text_params.find("site_id");
    site_id_ = sid == text_params.end() ? std::string() : sid->second;
    return true;
}

// 不抽共享随机流：本组件没有随机性（D-058 ④）
bool TemplateClassifier::init(IRandom&, std::string&) {
    rows_ = 0;
    status_ = ComponentStatus();
    return true;
}

ModelTrace TemplateClassifier::trace() const {
    ModelTrace t;
    t.model_id = "TemplateClassifier";
    t.model_version = "0.1.0";
    t.model_level = "E2";
    t.model_layer = "M2";
    t.credibility = "V2";
    t.parameter_version = "library-" + lib_.version;
    t.trace_id = site_id_.empty() ? std::string("TemplateClassifier:0") : "TemplateClassifier:" + site_id_;
    return t;
}

std::vector<std::string> TemplateClassifier::labels() const {
    std::vector<std::string> v;
    for (const auto& t : lib_.templates) v.push_back(t.label);
    return v;
}

bool TemplateClassifier::feature_value(const FeatureRow& f, const FeatureDef& def, double& x) const {
    const std::string& n = def.name;
    if (n == "bandwidth_Hz") { if (f.signal_bins == 0) return false; x = f.bandwidth_Hz; return true; }
    if (n == "duration_s") { x = f.duration_s; return true; }
    if (n == "duty") { x = f.duty; return true; }
    if (n == "spectral_flatness") { x = f.spectral_flatness; return true; }
    if (n == "hop_from_prev_Hz") { if (!f.has_prev) return false; x = def.abs ? std::fabs(f.hop_from_prev_Hz) : f.hop_from_prev_Hz; return true; }
    if (n == "interval_from_prev_s") { if (!f.has_prev) return false; x = f.interval_from_prev_s; return true; }
    if (n == "center_Hz") { x = f.center_Hz; return true; }
    if (n == "snr_dB") { x = f.snr_dB; return true; }
    if (n == "crest_factor_dB") { x = f.crest_factor_dB; return true; }
    if (n == "band_power_dBm") { if (!f.has_dBm) return false; x = f.band_power_dBm; return true; }
    if (n == "peak_dBm") { if (!f.has_dBm) return false; x = f.peak_dBm; return true; }
    return false;
}

// 区间外距离（EM-S-04 §10.5 区间形式）。对数域：下界 0 与缺上界视为不设界，x 先按 log_floor 钳住再取对数；
// 线性域：尺度 = 半区间宽。
double TemplateClassifier::interval_distance(const FeatureDef& def, double x, double lo, double hi, bool has_hi) const {
    if (def.log) {
        const double lx = std::log(std::max(x, def.floor));
        if (lo > 0.0) {
            const double ll = std::log(lo);
            if (lx < ll) return (ll - lx) / lib_.log_scale;
        }
        if (has_hi) {
            const double lu = std::log(hi);
            if (lx > lu) return (lx - lu) / lib_.log_scale;
        }
        return 0.0;
    }
    const double s = 0.5 * (hi - lo);
    if (x < lo) return (lo - x) / s;
    if (x > hi) return (x - hi) / s;
    return 0.0;
}

RecognitionRow TemplateClassifier::classify(const FeatureRow& f) const {
    RecognitionRow r;
    r.t_s = f.t_s;
    r.t_end_s = f.t_end_s;
    r.segment_id = f.segment_id;
    r.evidence_quality = f.quality;
    r.library_version = lib_.version;
    if (quality_rank(f.quality) < quality_rank(min_quality_)) {
        r.label = "unknown";
        r.result = "unknown";
        r.unknown_kind = "unknown_low_quality";
        r.posterior = 0.0;
        r.distance = -1.0;
        return r;
    }
    const std::size_t K = lib_.templates.size();
    const double inf = std::numeric_limits<double>::infinity();
    std::vector<double> D(K, inf), L(K, 0.0);
    std::vector<bool> usable(K, false);
    for (std::size_t k = 0; k < K; ++k) {
        const Template& t = lib_.templates[k];
        double num = 0.0, den = 0.0;
        for (std::size_t i = 0; i < lib_.features.size(); ++i) {
            if (!t.used[i]) continue;
            double x = 0.0;
            if (!feature_value(f, lib_.features[i], x)) continue;   // 缺失的特征不计入距离
            const double d = interval_distance(lib_.features[i], x, t.lo[i], t.hi[i], t.has_hi[i]);
            num += t.weight[i] * d;
            den += t.weight[i];
        }
        if (den > 0.0) {
            D[k] = num / den;
            L[k] = std::exp(-D[k] / 2.0);
            usable[k] = true;
        }
    }
    const double Lu = std::exp(-unknown_distance_ / 2.0);
    double denom = 0.0;
    for (std::size_t k = 0; k < K; ++k) denom += L[k];
    denom += Lu;
    std::vector<double> p(K, 0.0);
    for (std::size_t k = 0; k < K; ++k) p[k] = L[k] / denom;
    const double pu = Lu / denom;
    std::vector<std::size_t> idx(K);
    std::iota(idx.begin(), idx.end(), 0);
    std::stable_sort(idx.begin(), idx.end(), [&](std::size_t a, std::size_t b) { return p[a] > p[b]; });
    for (std::size_t n = 0; n < idx.size() && r.top_n.size() < 3; ++n) {
        if (!usable[idx[n]]) continue;
        RecognitionCandidate c;
        c.label = lib_.templates[idx[n]].label;
        c.posterior = p[idx[n]];
        c.distance = D[idx[n]];
        r.top_n.push_back(c);
    }
    double min_d = inf;
    for (std::size_t k = 0; k < K; ++k) if (usable[k] && D[k] < min_d) min_d = D[k];
    const double p1 = r.top_n.empty() ? 0.0 : r.top_n[0].posterior;
    const double p2 = r.top_n.size() > 1 ? r.top_n[1].posterior : 0.0;
    if (!r.top_n.empty() && p1 >= accept_threshold_) {
        r.label = r.top_n[0].label;
        r.posterior = p1;
        r.distance = r.top_n[0].distance;
        r.result = (p1 - p2 >= ambiguity_margin_) ? "known" : "ambiguous";
    } else {
        r.label = "unknown";
        r.posterior = pu;
        r.distance = std::isinf(min_d) ? -1.0 : min_d;
        r.result = "unknown";
        r.unknown_kind = (std::isinf(min_d) || min_d > unknown_distance_) ? "unknown_novel" : "unknown_ambiguous";
    }
    return r;
}

void TemplateClassifier::report(const RecognitionRow& r) {
    if (obs_ == nullptr) return;
    RecognitionReport rr;
    rr.node_id = node_name_;
    rr.site_id = site_id_;
    rr.row = r;
    rr.trace = trace();
    obs_->on_recognition(rr);
}

Step TemplateClassifier::process(PortMap& in, PortMap& out, std::string& err) {
    (void)err;
    auto it = in.find("in");
    if (it == in.end() || !it->second.has_data) return Step::Idle;
    const FeatureVector& fv = it->second.features;
    PortData o;
    o.type = PortType::RecognitionList;
    o.has_data = true;                    // 消费即产出（可为空），与特征提取器同一约定
    for (const FeatureRow& f : fv.items) {
        RecognitionRow r = classify(f);
        o.recognitions.items.push_back(r);
        report(r);
        rows_++;
    }
    o.recognitions.meta = fv.meta;
    o.recognitions.meta.trace = trace();
    out["out"] = o;
    status_.blocks_in++;
    status_.blocks_out++;
    status_.state = worst(status_.state, fv.meta.state);
    return Step::Produced;
}

void TemplateClassifier::reset() {
    rows_ = 0;
    status_ = ComponentStatus();
}

ComponentInfo TemplateClassifier::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "模板匹配识别";
    i.description = "EM-S-04 E2 工程模板加权匹配（10 报告 §4.4）：对每行突发特征逐模板取区间外距离、按权重平均成综合距离，"
                    "似然 exp(−D/2) 加未知假设 exp(−unknown_distance/2) 归一成后验；最大后验过接受门限且领先次大 ambiguity_margin "
                    "才判 known，领先不足为 ambiguous，不过门限为 unknown（开放集）；特征质量低于 min_quality 直接 unknown_low_quality。"
                    "标签只到 signal_role 层（video_link / telemetry_burst / rc_hopping / cw_beacon）；模板库取值标 assumed，"
                    "只对合成波形有效（models/recognition/README.md）；口径与 algos/reference/classify.py 一致";
    i.model_layer = "M2";
    i.model_level = "E2";
    i.model_id = "EM-S-04";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.stateful = false;
    // 绑站只为给识别行注入 site_id（与检测器同法，D-063 ④）；本组件不读场景文件
    i.scene_bindable = true;
    i.params = {
        ParamSpec::text("library_version", "模板库版本，形如 v1；库文件位置由装载器据此注入（D-037）").def_text("v1"),
        ParamSpec::number("accept_threshold", "", "最大后验不低于它才判 known / ambiguous，否则 unknown；"
                                                  "未知假设恒占一份似然，四模板下正确类在 D = 0 时的后验常在 0.55–0.8，故缺省 0.5（模型卡 §2）")
            .def(0.5).at_least(0.0).at_most(1.0),
        ParamSpec::number("ambiguity_margin", "", "最大后验领先次大不低于它才判 known，否则 ambiguous")
            .def(0.2).at_least(0.0).at_most(1.0),
        ParamSpec::number("unknown_distance", "", "未知假设的等效综合距离：似然 exp(−unknown_distance/2)")
            .def(4.0).at_least(0.0),
        ParamSpec::choice("min_quality", {"full", "overload", "short", "low_snr"},
                          "特征质量低于此档的突发直接判 unknown_low_quality，不算后验")
            .def_text("short"),
        ParamSpec::text("library_path", "模板库文件位置，由装载器按 library_version 注入；不得出现在框图里").internal_only(),
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入；本组件不读它").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器注入").internal_only(),
        ParamSpec::text("site_id", "本节点所属站点，由装载器按 scene_binding 注入；只作识别行的身份，不影响算法")
            .internal_only(),
    };
    return i;
}

}  // namespace cuav
