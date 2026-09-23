#include "cuav/numstr.h"
#include "cuav/components/evaluator.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>

#include "nlohmann/json.hpp"

#include "cuav/observer.h"
#include "cuav/scenario_json.h"

namespace cuav {

namespace {

double get_num(const std::map<std::string, double>& p, const char* key, double def) {
    std::map<std::string, double>::const_iterator it = p.find(key);
    return it == p.end() ? def : it->second;
}

bool get_text(const std::map<std::string, std::string>& t, const char* key, std::string& out) {
    std::map<std::string, std::string>::const_iterator it = t.find(key);
    if (it == t.end()) return false;
    out = it->second;
    return true;
}

const char* waveform_name(geo::WaveformType t) {
    switch (t) {
        case geo::WaveformType::Tone: return "tone";
        case geo::WaveformType::Noise: return "noise";
        case geo::WaveformType::Burst: return "burst";
    }
    return "tone";
}

}  // namespace

std::vector<PortSpec> Evaluator::inputs() const {
    std::vector<PortSpec> v;
    v.push_back(PortSpec{"det", PortType::DetectionList});
    PortSpec rec{"rec", PortType::RecognitionList};
    rec.optional = true;
    v.push_back(rec);
    for (int i = 1; i <= 8; ++i) {
        PortSpec s{"scene" + numstr(i), PortType::SceneParamFrame};
        s.optional = true;
        v.push_back(s);
    }
    return v;
}

ComponentInfo Evaluator::describe() const {
    ComponentInfo i;
    i.type = type_name();
    i.category = category::Algorithm;
    i.display_name = "真值与评价";
    i.description =
        "把检测行与识别行对照真值，出帧级 Pd / Pfa / F1、突发级检出与发现时延、ROC（门限扫描不重跑）与识别混淆矩阵"
        "（10 报告 §4.5；04 §7.9、§11.4）。真值三种来源：场景参数帧的 tx_on 与波形门控（scenario）、"
        "回放清单的类别（manifest）、无（none）。真值只进这里、不向被测算法泄漏（04 §5.2）。"
        "绑站：吃本站全部链路帧，多源的真值区间取并集。结果经运行器落 truth.jsonl 与 metrics.json。";
    i.model_layer = "M2";
    i.model_level = "E2";
    i.model_id = "eval-baseline";
    i.version = "0.1.0";
    i.inputs = inputs();
    i.outputs = outputs();
    i.stateful = true;
    i.scene_bindable = true;
    i.params = {
        ParamSpec::choice("truth_source", {"scenario", "manifest", "none"},
                          "真值来源：scenario = 场景参数帧的 tx_on 与波形门控（须接 scene 口）；"
                          "manifest = 回放清单的类别（须给 data_id）；none = 无真值，只出计数")
            .def_text("scenario"),
        ParamSpec::text("data_id", "回放清单的标识：manifest 模式下是真值来源；scenario 模式下若给出，"
                                   "视为混合增强的背景片段，用来核对它是否含目标（含则 degraded）"),
        ParamSpec::number("nfft", "", "检测器的帧长，须与上游检测器相等（装载器核对）；帧时长 = nfft / fs")
            .def(1024).at_least(1.0).constrained("= EnergyDetector.nfft"),
        ParamSpec::number("match_overlap", "", "突发匹配的时间重叠比：overlap / min(检测段长, 真值段长) 不小于它记匹配")
            .def(0.5).at_least(0.0, true).at_most(1.0),
        ParamSpec::number("roc_points", "", "ROC 门限点数：按排序统计量等分取，去重后可能少于此数")
            .def(32).at_least(2.0),
        ParamSpec::text("manifest_path", "回放清单路径，由装载器按 data_id 解析注入（D-037）").internal_only(),
        ParamSpec::text("scenario_path", "场景文件路径，由装载器按 scene_binding 注入；取各源的带宽与波形").internal_only(),
        ParamSpec::text("scenario_id", "场景标识，由装载器注入").internal_only(),
        ParamSpec::text("site_id", "本评价器所属站点，由装载器按 scene_binding 注入；只收本站的参数帧").internal_only(),
    };
    return i;
}

bool Evaluator::check_wiring(const std::vector<std::string>& wired, std::string& err) const {
    bool scene = false;
    rec_wired_ = false;
    for (std::size_t i = 0; i < wired.size(); ++i) {
        if (wired[i].compare(0, 5, "scene") == 0) scene = true;
        if (wired[i] == "rec") rec_wired_ = true;
    }
    if (truth_source_ == "scenario" && !scene) {
        err = "评价器的真值来源是 scenario，至少要接一路场景参数帧（scene1..scene8）；"
              "没有场景时把 truth_source 改成 manifest 或 none";
        return false;
    }
    return true;
}

std::string Evaluator::label_for_waveform(const std::string& waveform, double bw_Hz, bool has_hop) {
    if (waveform == "tone") return "cw_beacon";
    if (waveform == "burst") return has_hop ? "rc_hopping" : "telemetry_burst";
    if (waveform == "noise") return bw_Hz >= 1e6 ? "video_link" : "noise";
    return waveform;
}

std::string Evaluator::label_for_class_code(const std::string& code, bool& is_background) {
    is_background = (code == "B" || code == "T0000");
    if (is_background) return std::string();
    if (code.size() >= 2 && code[0] == 'T' && code[1] == '1') return "rc_hopping";   // DroneRFa 的飞控器类
    return "video_link";
}

bool Evaluator::configure(const std::map<std::string, double>& params,
                          const std::map<std::string, std::string>& text_params, std::string& err) {
    truth_source_ = "scenario";
    std::string ts;
    if (get_text(text_params, "truth_source", ts) && !ts.empty()) truth_source_ = ts;
    if (truth_source_ != "scenario" && truth_source_ != "manifest" && truth_source_ != "none") {
        err = "Evaluator 的 truth_source 必须是 scenario / manifest / none";
        return false;
    }
    match_overlap_ = get_num(params, "match_overlap", 0.5);
    if (!(match_overlap_ > 0.0 && match_overlap_ <= 1.0)) { err = "Evaluator 的 match_overlap 必须在 (0, 1]"; return false; }
    const double rp = get_num(params, "roc_points", 32.0);
    if (!(rp >= 2.0) || rp != std::floor(rp)) { err = "Evaluator 的 roc_points 必须是不小于 2 的整数"; return false; }
    roc_points_ = static_cast<std::size_t>(rp);
    const double nf = get_num(params, "nfft", 1024.0);
    if (!(nf >= 1.0) || nf != std::floor(nf)) { err = "Evaluator 的 nfft 必须是正整数"; return false; }
    nfft_ = static_cast<std::size_t>(nf);

    data_id_.clear(); manifest_path_.clear(); scenario_path_.clear(); scenario_id_.clear(); site_id_.clear();
    get_text(text_params, "data_id", data_id_);
    get_text(text_params, "manifest_path", manifest_path_);
    get_text(text_params, "scenario_path", scenario_path_);
    get_text(text_params, "scenario_id", scenario_id_);
    get_text(text_params, "site_id", site_id_);

    emitters_.clear();
    manifest_is_background_ = false;
    manifest_label_.clear();
    background_has_target_ = false;

    if (truth_source_ == "scenario") {
        if (scenario_path_.empty()) {
            err = "Evaluator 的真值来源是 scenario，缺内部参数 scenario_path。它由装载器按节点的 scene_binding 解析注入"
                  "（框图里只写 scene_binding，D-037）；单机运行请给 cuav_run --scenario <场景文件>";
            return false;
        }
        LoadedScenario ls;
        if (!load_scenario_file(scenario_path_, ls, err)) return false;
        if (!scenario_id_.empty() && ls.scenario.scenario_id != scenario_id_) {
            err = "Evaluator 绑定的场景标识是 " + scenario_id_ + "，但文件里的是 " + ls.scenario.scenario_id;
            return false;
        }
        if (site_id_.empty()) {
            if (ls.scenario.sites.size() != 1) {
                err = "多站场景（" + numstr(ls.scenario.sites.size()) +
                      " 个站点）的评价器必须在 scene_binding 里绑定 site_id";
                return false;
            }
            site_id_ = ls.scenario.sites[0].id;
        } else if (ls.scenario.find_site(site_id_) == 0) {
            err = "场景 " + ls.scenario.scenario_id + " 里没有站点 " + site_id_;
            return false;
        }
        scene_ = ls.scenario;          // 真值要按样点精确切段（G-6），场景留着不丢
        has_scene_ = true;
        for (std::size_t i = 0; i < ls.scenario.emitters.size(); ++i) {
            const geo::Emitter& e = ls.scenario.emitters[i];
            EmitterInfo info;
            info.bw_Hz = e.emission.bw_Hz;
            info.waveform = waveform_name(e.emission.waveform.type);
            info.period_s = e.emission.waveform.period_s;
            info.duty = e.emission.waveform.duty;
            for (std::size_t k = 0; k < ls.scenario.activities.size(); ++k) {
                const geo::Activity& a = ls.scenario.activities[k];
                if (a.emitter_id == e.id && a.event == geo::ActivityEvent::Hop) info.has_hop = true;
            }
            info.label = label_for_waveform(info.waveform, info.bw_Hz, info.has_hop);
            emitters_[e.id] = info;
        }
    }
    if (truth_source_ == "manifest" && data_id_.empty()) {
        err = "Evaluator 的真值来源是 manifest，必须给 data_id（回放片段的标识）";
        return false;
    }
    if (!data_id_.empty()) {
        if (manifest_path_.empty()) {
            err = "Evaluator 给了 data_id 但缺内部参数 manifest_path：由装载器按 data_id 解析注入（D-037）；"
                  "单机运行请给 cuav_run --data-index 或 --resolved";
            return false;
        }
        std::ifstream f(manifest_path_.c_str());
        if (!f) { err = "Evaluator 打不开清单 " + manifest_path_; return false; }
        nlohmann::json j;
        try { f >> j; } catch (const std::exception& e) { err = "Evaluator 的清单不是合法 JSON：" + std::string(e.what()); return false; }
        std::string code;
        if (j.contains("truth") && j["truth"].is_object() && j["truth"].contains("class_code") && j["truth"]["class_code"].is_string()) {
            code = j["truth"]["class_code"].get<std::string>();
        }
        if (code.empty()) {
            err = "Evaluator 的清单 " + manifest_path_ + " 没有 truth.class_code，无法定真值";
            return false;
        }
        bool bg = false;
        const std::string label = label_for_class_code(code, bg);
        if (truth_source_ == "manifest") {
            manifest_is_background_ = bg;
            manifest_label_ = label;
        } else {
            background_has_target_ = !bg;   // scenario 模式：data_id 是背景片段，非背景类即含目标
        }
    }
    return true;
}

void Evaluator::clear_state() {
    det_.clear();
    has_expected_ = false;
    expected_frame_ = 0;
    have_det_meta_ = false;
    truth_frame_grained_ = false;
    fs_ = f_lo_Hz_ = f_hi_Hz_ = threshold_ = 0.0;
    rec_.clear();
    runs_.clear();
    open_.clear();
    last_frame_start_.clear();
    frames_seen_ = 0;
    unknown_emitters_.clear();
    metrics_ = EvaluationMetrics();
    truth_rows_.clear();
    eval_params_ = EvalParams();
    status_ = ComponentStatus();
}

// 不抽共享随机流：本组件没有随机性，抽一个数就会把后面所有节点的子种子挪位（D-058 ④ 的教训）
bool Evaluator::init(IRandom&, std::string&) {
    clear_state();
    return true;
}

void Evaluator::reset() { clear_state(); }

void Evaluator::close_run(const std::string& em) {
    std::map<std::string, Run>::iterator it = open_.find(em);
    if (it == open_.end()) return;
    if (it->second.end > it->second.start) runs_[em].push_back(it->second);
    open_.erase(it);
}

void Evaluator::take_frame(const SceneParamFrame& f) {
    if (!site_id_.empty() && !f.site_id.empty() && f.site_id != site_id_) return;   // 别站的帧
    const std::string& em = f.emitter_id;
    // 帧会跨轮重发（ScenarioSource 每轮推整段窗口）：按 valid_from_s 去重，只收比上次更晚的
    std::map<std::string, double>::iterator ls = last_frame_start_.find(em);
    if (ls != last_frame_start_.end() && f.valid_from_s <= ls->second) return;
    last_frame_start_[em] = f.valid_from_s;
    frames_seen_++;
    if (emitters_.find(em) == emitters_.end() &&
        std::find(unknown_emitters_.begin(), unknown_emitters_.end(), em) == unknown_emitters_.end()) {
        unknown_emitters_.push_back(em);
    }
    if (!f.tx_on) { close_run(em); return; }
    std::map<std::string, Run>::iterator op = open_.find(em);
    if (op != open_.end() && op->second.center_Hz == f.tx_center_Hz && op->second.end == f.valid_from_s) {
        op->second.end = f.valid_to_s;   // 连续且中心频率不变：延长
        return;
    }
    close_run(em);
    Run r;
    r.start = f.valid_from_s;
    r.end = f.valid_to_s;
    r.center_Hz = f.tx_center_Hz;
    open_[em] = r;
}

Step Evaluator::process(PortMap& in, PortMap& out, std::string& err) {
    (void)out;
    bool any = false;
    PortMap::iterator d = in.find("det");
    if (d != in.end() && d->second.has_data) {
        any = true;
        const DetectionList& dl = d->second.detections;
        for (std::size_t i = 0; i < dl.items.size(); ++i) {
            const Detection& x = dl.items[i];
            if (has_expected_ && x.frame_index != expected_frame_) {
                err = "Evaluator 的检测行不连续：期望帧 " + numstr(expected_frame_) + "，收到帧 " +
                      numstr(x.frame_index) + "——上游有一轮没产出、深度 1 的缓冲被覆盖了；不静默丢行（铁律 15）";
                return Step::Error;
            }
            expected_frame_ = x.frame_index + 1;
            has_expected_ = true;
            if (!have_det_meta_) {
                have_det_meta_ = true;
                fs_ = dl.meta.sample_rate_Hz;
                f_lo_Hz_ = x.f_lo_Hz;
                f_hi_Hz_ = x.f_hi_Hz;
                threshold_ = x.threshold;
            }
            det_.push_back(x);
        }
        status_.state = worst(status_.state, dl.meta.state);
    }
    PortMap::iterator r = in.find("rec");
    if (r != in.end() && r->second.has_data) {
        any = true;
        const RecognitionList& rl = r->second.recognitions;
        for (std::size_t i = 0; i < rl.items.size(); ++i) rec_.push_back(rl.items[i]);
    }
    for (int k = 1; k <= 8; ++k) {
        PortMap::iterator s = in.find("scene" + numstr(k));
        if (s == in.end() || !s->second.has_data) continue;
        any = true;
        for (std::size_t i = 0; i < s->second.scenes.size(); ++i) take_frame(s->second.scenes[i]);
    }
    if (any) status_.blocks_in++;
    return Step::Idle;
}

bool Evaluator::in_band(double center_Hz, double bw_Hz) const {
    if (!have_det_meta_) return true;
    const double lo = center_Hz - 0.5 * bw_Hz, hi = center_Hz + 0.5 * bw_Hz;
    return lo < f_hi_Hz_ && hi > f_lo_Hz_;
}

void Evaluator::build_truth_rows() {
    truth_rows_.clear();
    if (truth_source_ == "manifest") {
        if (manifest_is_background_ || det_.empty()) return;   // 背景：全片为假，没有真值行
        double t0 = det_.front().t_s, t1 = det_.front().t_s;
        for (std::size_t i = 0; i < det_.size(); ++i) { t0 = std::min(t0, det_[i].t_s); t1 = std::max(t1, det_[i].t_s); }
        TruthRow r;
        r.t_s = t0;
        r.t_end_s = t1 + (fs_ > 0.0 ? static_cast<double>(nfft_) / fs_ : 0.0);
        r.label = manifest_label_;
        r.waveform = "manifest";
        r.in_band = true;
        truth_rows_.push_back(r);
        return;
    }
    if (truth_source_ != "scenario") return;
    for (std::map<std::string, std::vector<Run>>::const_iterator it = runs_.begin(); it != runs_.end(); ++it) {
        const std::string& em = it->first;
        std::map<std::string, EmitterInfo>::const_iterator ei = emitters_.find(em);
        EmitterInfo info;
        if (ei != emitters_.end()) info = ei->second;
        else { info.waveform = "unknown"; info.label = "unknown_emitter"; }
        const bool burst = info.waveform == "burst" && fs_ > 0.0 && info.period_s > 0.0;
        std::uint64_t period_n = 0, on_n = 0;
        if (burst) {
            // 与 SceneEmitterSource 同式（scenario.cpp）：门控在样点域按绝对样点号取模
            period_n = static_cast<std::uint64_t>(info.period_s * fs_ + 0.5);
            on_n = static_cast<std::uint64_t>(info.duty * static_cast<double>(period_n) + 0.5);
        }

        // G-6（D-069）：帧只管「这条链路在哪些时段看得见」，开关与跳频的**边界与频点**
        // 交给样点域的 ActivitySchedule —— 与波形源同一个类、同一套取整，于是真值与 IQ 逐位同源。
        // 取不到采样率（没有检测行）或该源不在场景里时退回帧粒度，并如实标降级（铁律 15）。
        geo::ActivitySchedule sched;
        bool precise = false;
        if (has_scene_ && ei != emitters_.end()) {
            if (fs_ > 0.0) {
                std::string e;
                precise = sched.build(scene_, em, fs_, e);
                if (!precise) status_.notes.push_back("辐射源 " + em + " 的活动时间线折不成样点：" + e);
            }
            if (!precise) truth_frame_grained_ = true;
        }

        // 帧域按 tx_center_Hz 切开的相邻段先并回去：跳频快于帧率时那些边界是混叠抽样，不是真的
        std::vector<Run> windows;
        for (std::size_t k = 0; k < it->second.size(); ++k) {
            const Run& run = it->second[k];
            if (precise && !windows.empty() && windows.back().end == run.start) windows.back().end = run.end;
            else windows.push_back(run);
        }

        for (std::size_t k = 0; k < windows.size(); ++k) {
            const Run& run = windows[k];
            // 把窗口切成若干「同频同开关」的子区间；不精确时整窗一段、频点取帧里的值
            std::vector<Run> parts;
            if (precise) {
                const std::uint64_t n0 = geo::sample_at(run.start, fs_);
                const std::uint64_t n1 = geo::sample_at(run.end, fs_);
                for (std::uint64_t n = n0; n < n1;) {
                    const geo::ActivitySchedule::Segment seg = sched.segment_at(n);
                    const std::uint64_t stop = std::min<std::uint64_t>(seg.end, n1);
                    if (stop <= n) break;
                    if (seg.tx_on) {
                        Run p;
                        p.start = static_cast<double>(n) / fs_;
                        p.end = static_cast<double>(stop) / fs_;
                        p.center_Hz = seg.center_Hz;
                        parts.push_back(p);
                    }
                    n = stop;
                }
            } else {
                parts.push_back(run);
            }

            for (std::size_t q = 0; q < parts.size(); ++q) {
                const Run& part = parts[q];
                const bool ib = in_band(part.center_Hz, info.bw_Hz);
                if (!burst || period_n == 0 || on_n == 0) {
                    TruthRow r;
                    r.t_s = part.start; r.t_end_s = part.end; r.emitter_id = em; r.label = info.label;
                    r.waveform = info.waveform; r.center_Hz = part.center_Hz; r.bw_Hz = info.bw_Hz; r.in_band = ib;
                    truth_rows_.push_back(r);
                    continue;
                }
                const std::uint64_t k0 = static_cast<std::uint64_t>(std::floor(part.start * fs_ / static_cast<double>(period_n)));
                for (std::uint64_t p = k0;; ++p) {
                    const double w0 = static_cast<double>(p * period_n) / fs_;
                    if (w0 >= part.end) break;
                    const double w1 = static_cast<double>(p * period_n + on_n) / fs_;
                    const double a = std::max(w0, part.start), b = std::min(w1, part.end);
                    if (b <= a) continue;
                    TruthRow r;
                    r.t_s = a; r.t_end_s = b; r.emitter_id = em; r.label = info.label;
                    r.waveform = info.waveform; r.center_Hz = part.center_Hz; r.bw_Hz = info.bw_Hz; r.in_band = ib;
                    truth_rows_.push_back(r);
                }
            }
        }
    }
    std::stable_sort(truth_rows_.begin(), truth_rows_.end(), [](const TruthRow& x, const TruthRow& y) {
        if (x.t_s != y.t_s) return x.t_s < y.t_s;
        if (x.emitter_id != y.emitter_id) return x.emitter_id < y.emitter_id;
        return x.t_end_s < y.t_end_s;
    });
}

ModelTrace Evaluator::trace() const {
    ModelTrace t;
    t.model_id = "eval-baseline";
    t.model_version = "0.1.0";
    t.model_level = "E2";
    t.model_layer = "M2";
    t.credibility = "V2";
    t.parameter_version = "eval-baseline-0.1";
    t.trace_id = site_id_.empty() ? std::string("Evaluator:0") : "Evaluator:" + site_id_;
    return t;
}

Step Evaluator::flush(PortMap& out, std::string& err) {
    (void)out; (void)err;
    for (std::map<std::string, Run>::iterator it = open_.begin(); it != open_.end();) {
        const std::string em = it->first;
        ++it;
        close_run(em);
    }
    build_truth_rows();

    eval_params_ = EvalParams();
    eval_params_.truth_source = truth_source_;
    eval_params_.match_overlap = match_overlap_;
    eval_params_.roc_points = roc_points_;
    eval_params_.frame_dt_s = fs_ > 0.0 ? static_cast<double>(nfft_) / fs_ : 0.0;
    eval_params_.threshold = have_det_meta_ ? threshold_ : eval_nan();
    eval_params_.has_rec = rec_wired_;
    metrics_ = evaluate(det_, rec_, truth_rows_, eval_params_);

    // 多速率下的真值边界落差（M-2，D-070）：源端按站点的宽带 fs 建活动时间线，
    // 这里按检测行带来的 fs 重建；DDC 启用后那是抽取之后的窄带 fs，两边四舍五入的落点会差一点。
    // 每个边界至多差 (D+1)/(2·fs_w)，跳频的边界还会随跳数累积。写成 notes 不写成 reasons：
    // 它是多速率下「源与真值逐位同源」退化成「亚样点同源」的真实边界，不是降级（铁律 15 照实说）。
    if (truth_source_ == "scenario" && fs_ > 0.0 && !site_id_.empty()) {
        const geo::Site* st = scene_.find_site(site_id_);
        if (st != 0 && st->receiver.fs_Hz > 0.0 && std::fabs(st->receiver.fs_Hz - fs_) > 1e-6) {
            char buf[256];
            std::snprintf(buf, sizeof(buf),
                          "真值按 %.10g Hz 重建，源端按站点的 %.10g Hz 生成（中间有抽取）："
                          "每个真值边界至多差 %.1f ns，跳频边界随跳数累积",
                          fs_, st->receiver.fs_Hz,
                          1e9 * (st->receiver.fs_Hz / fs_ + 1.0) / (2.0 * st->receiver.fs_Hz));
            status_.notes.push_back(buf);
        }
    }

    if (truth_source_ == "scenario" && frames_seen_ == 0) {
        metrics_.state = worst(metrics_.state, State::Degraded);
        metrics_.reasons.push_back("没有收到任何场景参数帧，真值为空：所有命中都被计为虚警");
    }
    if (truth_frame_grained_) {
        metrics_.state = worst(metrics_.state, State::Degraded);
        metrics_.reasons.push_back("真值退回帧粒度（参数帧的 1/update_rate）：取不到检测行给的采样率，"
                                   "发射开关的边界与跳频点只能按帧取，突发门控与跳频切段都不精确");
    }
    if (!unknown_emitters_.empty()) {
        metrics_.state = worst(metrics_.state, State::Degraded);
        std::string who;
        for (std::size_t i = 0; i < unknown_emitters_.size(); ++i) who += (i ? "、" : "") + unknown_emitters_[i];
        metrics_.reasons.push_back("参数帧里的辐射源 " + who + " 不在场景文件里，带宽与类别未知，真值区间按频段内、标签 unknown_emitter 处理");
    }
    if (background_has_target_) {
        metrics_.state = worst(metrics_.state, State::Degraded);
        metrics_.reasons.push_back("背景片段 " + data_id_ + " 的清单类别不是背景：背景片段含目标，真值不完整");
    }
    status_.state = worst(status_.state, metrics_.state);
    for (std::size_t i = 0; i < metrics_.reasons.size(); ++i) status_.notes.push_back(metrics_.reasons[i]);

    if (obs_ != nullptr) {
        for (std::size_t i = 0; i < truth_rows_.size(); ++i) {
            TruthReport tr;
            tr.node_id = node_name_;
            tr.site_id = site_id_;
            tr.row = truth_rows_[i];
            obs_->on_truth(tr);
        }
        EvaluationReport er;
        er.node_id = node_name_;
        er.site_id = site_id_;
        er.metrics = metrics_;
        er.params = eval_params_;
        er.detector.nfft = nfft_;
        er.detector.sample_rate_Hz = fs_;
        er.detector.f_lo_Hz = f_lo_Hz_;
        er.detector.f_hi_Hz = f_hi_Hz_;
        er.trace = trace();
        obs_->on_evaluation(er);
    }
    status_.blocks_out++;
    return Step::Finished;
}

}  // namespace cuav
