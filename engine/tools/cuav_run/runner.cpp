#include "runner.h"

#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <sstream>

#include "nlohmann/json.hpp"

#include "cuav/catalog.h"
#include "cuav/diagram_json.h"
#include "cuav/observer.h"
#include "cuav/platform.h"
#include "cuav/random.h"
#include "cuav/registry.h"
#include "cuav/scenario_json.h"
#include "cuav/types.h"

namespace cuav {
namespace runner {

namespace {

using nlohmann::json;
using Clock = std::chrono::steady_clock;

std::string basename_of(const std::string& p) {
    std::string s = p;
    while (s.size() > 1 && (s[s.size() - 1] == '/' || s[s.size() - 1] == '\\')) s.erase(s.size() - 1);
    const std::size_t slash = s.find_last_of("/\\");
    return slash == std::string::npos ? s : s.substr(slash + 1);
}

std::string stem_of(const std::string& p) {
    std::string b = basename_of(p);
    const std::size_t dot = b.find_last_of('.');
    return dot == std::string::npos || dot == 0 ? b : b.substr(0, dot);
}

bool parse_u64(const std::string& s, std::uint64_t& out) {
    if (s.empty()) return false;
    std::uint64_t v = 0;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
        const std::uint64_t d = static_cast<std::uint64_t>(c - '0');
        if (v > (UINT64_MAX - d) / 10) return false;
        v = v * 10 + d;
    }
    out = v;
    return true;
}

// ---- 测向与定位报告的落盘形状（D-053，11 报告 §4）----
// 溯源六件套加两项按铁律 8 随每一行走；truth_consumed 是 M2 效应模型的强制声明（11 §1.3）。
json trace_json(const ModelTrace& t) {
    return json{{"model_id", t.model_id}, {"model_version", t.model_version},
                {"model_level", t.model_level}, {"model_layer", t.model_layer},
                {"credibility", t.credibility}, {"parameter_version", t.parameter_version},
                {"trace_id", t.trace_id}};
}

json bearing_json(const BearingReport& b) {
    return json{
        {"t_s", b.t_s}, {"site_id", b.site_id}, {"emitter_id", b.emitter_id}, {"link_id", b.link_id},
        {"site_lon", b.site_lon}, {"site_lat", b.site_lat}, {"site_alt_m", b.site_alt_m},
        {"bearing_deg", b.bearing_deg}, {"bearing_std_deg", b.bearing_std_deg},
        {"elevation_deg", b.elevation_deg}, {"snr_dB", b.snr_dB}, {"level_dBm", b.level_dBm},
        {"df_quality", b.df_quality}, {"df_result_state", to_string(b.df_result_state)},
        {"use_policy", b.use_policy}, {"method", b.method}, {"bias_deg", b.bias_deg},
        {"sigma", json{{"method", b.sigma.method_deg}, {"snr", b.sigma.snr_deg},
                       {"cal", b.sigma.cal_deg}, {"att", b.sigma.att_deg},
                       {"multipath", b.sigma.multipath_deg}, {"mixture", b.sigma.mixture_deg}}},
        {"line_of_sight", b.line_of_sight}, {"mixture", b.mixture},
        {"signal_role", b.signal_role}, {"truth_consumed", b.truth_consumed},
        {"state", to_string(b.state)}, {"reasons", b.reasons}, {"trace", trace_json(b.trace)}};
}

json position_json(const PositionReport& p) {
    json residuals = json::array();
    for (const auto& r : p.residuals) {
        residuals.push_back(json{{"site_id", r.site_id}, {"value", r.value}, {"unit", r.unit}});
    }
    return json{
        {"t_s", p.t_s}, {"emitter_id", p.emitter_id}, {"method", p.method},
        {"lon", p.lon}, {"lat", p.lat}, {"crs", p.crs}, {"coord_version", p.coord_version},
        {"enu_origin", json{{"lon", p.origin_lon}, {"lat", p.origin_lat}, {"alt_m", p.origin_alt_m}}},
        {"cov_m2", json::array({p.cov_m2[0], p.cov_m2[1], p.cov_m2[2]})},
        {"ellipse", json{{"semi_major_m", p.ellipse.semi_major_m},
                         {"semi_minor_m", p.ellipse.semi_minor_m},
                         {"rotation_deg", p.ellipse.rotation_deg},
                         {"scale", std::string(p.ellipse.scale)},
                         {"confidence", p.ellipse.confidence}}},
        {"cep_m", p.cep_m}, {"gdop", p.gdop},
        {"min_crossing_angle_deg", p.min_crossing_angle_deg},
        {"geometry_quality", p.geometry_quality},
        {"time_quality", p.time_quality.empty() ? json(nullptr) : json(p.time_quality)},
        {"participating_sites", p.participating_sites},
        {"reference_site", p.reference_site.empty() ? json(nullptr) : json(p.reference_site)},
        {"residuals", residuals}, {"outlier_sites", p.outlier_sites},
        {"truth_consumed", p.truth_consumed},
        {"state", to_string(p.state)}, {"reasons", p.reasons}, {"trace", trace_json(p.trace)}};
}

// 事件载荷 = 行去掉 t_s（信封里已有，docs/api-versions.md §4）。
json strip_t(const json& row) {
    json j = row;
    j.erase("t_s");
    return j;
}

// ---- 检测行与检测摘要的落盘形状（C-3，D-063，10 报告 §4.2）----
// 行**不带 trace**：逐帧重复七个键只会把文件撑大一半，trace 由 detections.index.json 每节点写一次（铁律 8）。
// site_id 为空（未绑站）省键；has_dBm 为假（未标定或参数关掉）省 band_power_dBm / noise_dBm——缺的就是缺的，不编。
json detection_json(const DetectionReport& r) {
    const Detection& d = r.d;
    json j{{"t_s", d.t_s}, {"node_id", r.node_id},
           {"start_sample", d.start_sample}, {"frame_index", d.frame_index},
           {"f_lo_Hz", d.f_lo_Hz}, {"f_hi_Hz", d.f_hi_Hz},
           {"statistic", d.statistic}, {"threshold", d.threshold}, {"hit", d.hit},
           {"snr_dB", d.snr_dB}, {"overload", d.overload}, {"noise_frames_used", d.noise_frames_used}};
    if (!r.site_id.empty()) j["site_id"] = r.site_id;
    j["segment_id"] = d.segment_id >= 0 ? json(d.segment_id) : json(nullptr);
    if (d.has_dBm) {
        j["band_power_dBm"] = d.band_power_dBm;
        j["noise_dBm"] = d.noise_dBm;
    }
    return j;
}

json detection_summary_json(const DetectionSummary& s) {
    json notes = json::array();
    for (const auto& n : s.notes) notes.push_back(n);
    json j{{"node_id", s.node_id}, {"nfft", s.nfft}, {"sample_rate_Hz", s.sample_rate_Hz},
           {"center_Hz", s.center_Hz}, {"f_lo_Hz", s.band_lo_Hz}, {"f_hi_Hz", s.band_hi_Hz},
           {"pfa", s.pfa}, {"threshold", s.threshold}, {"noise_mode", s.noise_mode},
           {"noise_window_frames", s.noise_window_frames}, {"merge_gap_frames", s.merge_gap_frames},
           {"dt_s", s.dt_s}, {"frames", s.frames}, {"hits", s.hits}, {"segments", s.segments},
           {"noise_stale_frames", s.noise_stale_frames}, {"overload_frames", s.overload_frames},
           {"calibrated", s.calibrated}, {"state", to_string(s.state)}, {"notes", notes},
           {"trace", trace_json(s.trace)}};
    if (!s.site_id.empty()) j["site_id"] = s.site_id;
    return j;
}

// 事件出口：stdout 一行一条，--out 给了就原样再落 events.jsonl；两处都逐行 flush，服务端读到即完整。
class EventSink {
public:
    explicit EventSink(std::ostream& out) : out_(out) {}

    void set_task_id(const std::string& id) { task_id_ = id; }
    const std::string& task_id() const { return task_id_; }

    bool open_file(const std::string& path, std::string& err) {
        file_.open(path.c_str(), std::ios::binary | std::ios::trunc);
        if (!file_.good()) { err = "打不开 events.jsonl 写入：" + path; return false; }
        return true;
    }

    std::uint64_t emit(const std::string& type, double t_s, const json& payload) {
        json j;
        j["seq"] = ++seq_;
        j["task_id"] = task_id_;
        j["type"] = type;
        j["t_s"] = t_s;
        j["payload"] = payload;
        const std::string line = j.dump();
        out_ << line << '\n';
        out_.flush();
        if (file_.is_open()) {
            file_ << line << '\n';
            file_.flush();
        }
        return seq_;
    }

    std::uint64_t seq() const { return seq_; }

private:
    std::ostream& out_;
    std::ofstream file_;
    std::string task_id_;
    std::uint64_t seq_ = 0;
};

json status_json(const std::string& name, const ComponentStatus& s) {
    json notes = json::array();
    for (const auto& n : s.notes) notes.push_back(n);
    return json{{"name", name}, {"state", to_string(s.state)},
                {"blocks_in", s.blocks_in}, {"blocks_out", s.blocks_out},
                {"samples_in", s.samples_in}, {"samples_out", s.samples_out}, {"notes", notes}};
}

// 观察者 → 事件。progress 按墙钟节流（默认 100 ms），其余每条都发。
class RunnerObserver : public IRunObserver {
public:
    RunnerObserver(EventSink& sink, std::uint64_t interval_ms)
        : sink_(sink), interval_(std::chrono::milliseconds(interval_ms)), throttle_(interval_ms > 0) {}

    void on_progress(const ProgressInfo& p) override {
        ++rounds_seen_;
        if (throttle_) {
            const Clock::time_point now = Clock::now();
            if (has_last_ && now - last_ < interval_) return;
            last_ = now;
            has_last_ = true;
        }
        json nodes = json::array();
        for (std::size_t i = 0; i < p.node_status.size(); ++i) {
            nodes.push_back(status_json(i < p.node_names.size() ? p.node_names[i] : "", p.node_status[i]));
        }
        sink_.emit("progress", last_t_s_, json{{"round", p.round}, {"nodes", nodes}});
        ++progress_events_;
    }

    void on_product_row(const std::string& op_id, const std::string& kind, std::uint64_t row_index,
                        const float*, std::size_t len, double t_s) override {
        if (t_s > last_t_s_) last_t_s_ = t_s;
        sink_.emit("product_row", t_s, json{{"op_id", op_id}, {"kind", kind}, {"row_index", row_index}, {"row_len", len}});
        ++rows_;
    }

    void on_log(const std::string& level, const std::string& message) override {
        sink_.emit("log", last_t_s_, json{{"level", level}, {"message", message}});
    }

    // 产品目录。给了才落 track.jsonl / links.jsonl；--validate 与无场景的任务不产生空文件。
    void set_out_dir(const std::string& dir) { out_dir_ = dir; }

    void on_entity(const EntityState& e) override {
        if (e.t_s > last_t_s_) last_t_s_ = e.t_s;
        const json j{{"t_s", e.t_s}, {"id", e.id}, {"lon", e.lon}, {"lat", e.lat}, {"alt_m", e.alt_m},
                     {"heading_deg", e.heading_deg}, {"speed_mps", e.speed_mps},
                     {"tx_on", e.tx_on}, {"center_Hz", e.center_Hz}};
        sink_.emit("entity", e.t_s, json{{"id", e.id}, {"lon", e.lon}, {"lat", e.lat}, {"alt_m", e.alt_m},
                                         {"heading_deg", e.heading_deg}, {"speed_mps", e.speed_mps},
                                         {"tx_on", e.tx_on}, {"center_Hz", e.center_Hz}});
        write_jsonl(track_, "track.jsonl", j);
        ++entities_;
    }

    void on_link(const LinkFrame& l) override {
        if (l.t_s > last_t_s_) last_t_s_ = l.t_s;
        // 传播分档的三项（D-058）。事件与 JSONL 用同一份载荷，只差一个 t_s：
        // 两处各写一遍键表，改一处漏一处的账迟早要还。
        json row{{"t_s", l.t_s}, {"link_id", l.link_id}, {"line_of_sight", l.line_of_sight},
                 {"distance_m", l.distance_m}, {"azimuth_deg", l.azimuth_deg},
                 {"elevation_deg", l.elevation_deg}, {"path_loss_dB", l.path_loss_dB},
                 {"free_space_dB", l.free_space_dB}, {"extra_loss_dB", l.extra_loss_dB},
                 {"included_loss_terms", l.included_loss_terms},
                 {"delay_s", l.delay_s}, {"doppler_Hz", l.doppler_Hz},
                 {"valid_from_s", l.valid_from_s}, {"valid_to_s", l.valid_to_s},
                 {"update_rate_Hz", l.update_rate_Hz}, {"state", to_string(l.state)}};
        sink_.emit("link", l.t_s, strip_t(row));
        write_jsonl(links_, "links.jsonl", row);
        ++links_written_;
    }

    // 测向与定位报告（D-053）。与 on_link 同法：一条事件 + 一行 JSONL。
    // 行里带 t_s，事件的载荷去掉 t_s（它已在信封里，docs/api-versions.md §4）。
    void on_bearing(const BearingReport& b) override {
        if (b.t_s > last_t_s_) last_t_s_ = b.t_s;
        json row = bearing_json(b);
        sink_.emit("bearing", b.t_s, strip_t(row));
        write_jsonl(bearings_, "bearings.jsonl", row);
        ++bearings_written_;
    }

    void on_position(const PositionReport& p) override {
        if (p.t_s > last_t_s_) last_t_s_ = p.t_s;
        json row = position_json(p);
        sink_.emit("position", p.t_s, strip_t(row));
        write_jsonl(positions_, "positions.jsonl", row);
        ++positions_written_;
    }

    // 检测行（C-3，D-063）：逐帧一行落 detections.jsonl；事件**只在段首帧发一条**——
    // 逐命中帧发在持续信号下是每秒几百条，比产品行还密，重连补取会整段重放；
    // 突发的边界由文件给，评价器（C-5）扫门限也只读文件。
    void on_detection(const DetectionReport& r) override {
        if (r.d.t_s > last_t_s_) last_t_s_ = r.d.t_s;
        json row = detection_json(r);
        write_jsonl(detections_, "detections.jsonl", row);
        ++detections_written_;
        if (r.d.hit) {
            std::map<std::string, std::int64_t>::iterator it = last_segment_.find(r.node_id);
            if (it == last_segment_.end() || it->second != r.d.segment_id) {
                last_segment_[r.node_id] = r.d.segment_id;
                sink_.emit("detection", r.d.t_s, strip_t(row));
                ++detection_events_;
            }
        }
    }

    void on_detection_summary(const DetectionSummary& s) override {
        det_summaries_[s.node_id] = detection_summary_json(s);
    }

    // 运行结束后写 detections.index.json：每个检测器一条摘要（含 trace），有检测器才写。
    // 与观测点产品的索引同一分工：行文件是数据，索引是元数据。
    void write_detections_index() {
        if (out_dir_.empty() || det_summaries_.empty()) return;
        json nodes = json::object();
        for (const auto& kv : det_summaries_) nodes[kv.first] = kv.second;
        json idx{{"schema", "cuav-detections-index/1"}, {"final", true},
                 {"rows", detections_written_}, {"nodes", nodes}};
        std::ofstream f(platform::join(out_dir_, "detections.index.json").c_str(),
                        std::ios::binary | std::ios::trunc);
        f << idx.dump(2) << '\n';
    }

    double last_t_s() const { return last_t_s_; }
    std::uint64_t rows() const { return rows_; }
    std::uint64_t entities() const { return entities_; }
    std::uint64_t links_written() const { return links_written_; }
    std::uint64_t bearings_written() const { return bearings_written_; }
    std::uint64_t positions_written() const { return positions_written_; }
    std::uint64_t detections_written() const { return detections_written_; }
    std::uint64_t detection_events() const { return detection_events_; }
    std::uint64_t progress_events() const { return progress_events_; }
    std::uint64_t rounds_seen() const { return rounds_seen_; }

private:
    // 惰性开文件：只有真有实体或链路上报时才建。每行必须自带 t_s 且以换行结尾——
    // 读端（B-7 的 server/src/products/jsonl.ts）把没有换行的末行当残片丢弃。
    void write_jsonl(std::ofstream& f, const char* name, const json& row) {
        if (out_dir_.empty()) return;
        if (!f.is_open()) {
            f.open(platform::join(out_dir_, name).c_str(), std::ios::binary | std::ios::trunc);
            if (!f.good()) return;
        }
        f << row.dump() << '\n';
        f.flush();
    }

    EventSink& sink_;
    std::chrono::milliseconds interval_;
    bool throttle_;
    std::string out_dir_;
    std::ofstream track_, links_, bearings_, positions_, detections_;
    std::uint64_t entities_ = 0;
    std::uint64_t links_written_ = 0;
    std::uint64_t bearings_written_ = 0, positions_written_ = 0;
    std::uint64_t detections_written_ = 0, detection_events_ = 0;
    std::map<std::string, std::int64_t> last_segment_;    // 每个检测器最近一次发过事件的段号
    std::map<std::string, json> det_summaries_;
    bool has_last_ = false;
    Clock::time_point last_;
    double last_t_s_ = 0.0;
    std::uint64_t rows_ = 0, progress_events_ = 0, rounds_seen_ = 0;
};

// 按 --resolved / --data-index 建解析器；两者都没给返回空指针（框图里有回放节点时装载器会报 data_id）。
bool build_resolver(const Options& opt, MapDataResolver& map, IndexDataResolver& index,
                    IDataResolver*& resolver, std::string& err) {
    resolver = nullptr;
    if (!opt.resolved_path.empty()) {
        if (!map.load_file(opt.resolved_path, err)) return false;
        resolver = &map;
        return true;
    }
    if (!opt.data_index_paths.empty()) {
        for (const auto& p : opt.data_index_paths) {
            if (!index.add_index(p, err)) return false;
        }
        resolver = &index;
    }
    return true;
}

// 按 --resolved 的 scenarios 段或 --scenario 建场景解析器；都没给返回空指针
// （框图里有 scene_binding 时装载器会报 scenario）。
bool build_scenario_resolver(const Options& opt, MapScenarioResolver& map, FileScenarioResolver& files,
                             IScenarioResolver*& resolver, std::string& err) {
    resolver = nullptr;
    if (!opt.scenario_paths.empty()) {
        for (const auto& p : opt.scenario_paths) {
            if (!files.add_file(p, err)) return false;
        }
        resolver = &files;
        return true;
    }
    if (!opt.resolved_path.empty()) {
        if (!map.load_file(opt.resolved_path, err)) return false;
        if (map.size() > 0) resolver = &map;
    }
    return true;
}

json run_json(const RunSpec& r) {
    json j{{"seed", r.seed}, {"duration_s", r.duration_s}};
    if (r.block_size) j["block_size"] = r.block_size;
    if (r.max_rounds) j["max_rounds"] = r.max_rounds;
    return j;
}

json taps_json(const LoadedDiagram& d) {
    json a = json::array();
    for (const auto& t : d.taps) {
        a.push_back(json{{"op_id", t.op_id}, {"node", t.node}, {"port", t.port}, {"products", t.products}});
    }
    return a;
}

// 运行失败的报文以节点名开头（graph.cpp），据此把 node_id 找回来给画布高亮。
std::string failing_node(const LoadedDiagram& d, const std::string& error) {
    for (const auto& name : d.node_names) {
        if (error.size() > name.size() && error.compare(0, name.size(), name) == 0 && error[name.size()] == ' ') return name;
    }
    return std::string();
}

int do_catalog(std::ostream& events, std::ostream& diag) {
    Registry r = builtin_registry();
    std::string err;
    for (const auto& type : r.types()) {
        ComponentInfo info;
        if (!r.describe(type, info, err) || !validate_catalog_entry(info, err)) {
            diag << "组件目录自检失败：" << err << "\n";
            return ExitRunFailed;
        }
    }
    events << catalog_json(r).dump(2) << "\n";
    events.flush();
    return ExitOk;
}

int do_validate(const Options& opt, std::ostream& events, std::ostream& diag) {
    EventSink sink(events);
    sink.set_task_id(opt.task_id.empty() ? stem_of(opt.diagram_path) : opt.task_id);
    MapDataResolver map;
    IndexDataResolver index;
    IDataResolver* resolver = nullptr;
    std::string err;
    if (!build_resolver(opt, map, index, resolver, err)) {
        DiagramError e;
        e.code = "data_id";
        e.message = err;
        sink.emit("error", 0.0, to_json(e));
        diag << err << "\n";
        return ExitDiagram;
    }
    MapScenarioResolver smap;
    FileScenarioResolver sfiles;
    IScenarioResolver* sresolver = nullptr;
    if (!build_scenario_resolver(opt, smap, sfiles, sresolver, err)) {
        DiagramError se;
        se.code = "scenario";
        se.message = err;
        sink.emit("error", 0.0, to_json(se));
        diag << err << "\n";
        return ExitDiagram;
    }

    Registry registry = builtin_registry();
    LoadedDiagram d;
    DiagramError e;
    LoadOptions lo;   // out_dir 为空：只校验，不落盘
    lo.scenarios = sresolver;
    lo.scene_root = opt.scene_root;
    if (!load_diagram_file(opt.diagram_path, registry, resolver, lo, d, e)) {
        sink.emit("error", 0.0, to_json(e));
        diag << "框图校验失败 [" << e.code << "] " << e.message << "\n";
        return ExitDiagram;
    }
    if (opt.task_id.empty()) sink.set_task_id(d.diagram_id);
    json names = json::array();
    for (const auto& kv : d.node_ids) names.push_back(kv.first);
    sink.emit("validate", 0.0, json{{"ok", true}, {"diagram_id", d.diagram_id}, {"name", d.name},
                                    {"nodes", names}, {"edges", d.edge_count},
                                    {"observation_points", taps_json(d)}, {"run", run_json(d.run)},
                                    {"engine_version", engine_version()}});
    diag << "框图校验通过：" << d.diagram_id << "，" << d.node_ids.size() << " 节点 " << d.edge_count
         << " 连线 " << d.taps.size() << " 观测点\n";
    return ExitOk;
}

int do_run(const Options& opt, std::ostream& events, std::ostream& diag) {
    std::string err;
    if (!platform::make_dirs(opt.out_dir, err)) {
        diag << err << "\n";
        return ExitIo;
    }
    EventSink sink(events);
    sink.set_task_id(opt.task_id.empty() ? basename_of(opt.out_dir) : opt.task_id);
    if (!sink.open_file(platform::join(opt.out_dir, "events.jsonl"), err)) {
        diag << err << "\n";
        return ExitIo;
    }

    MapDataResolver map;
    IndexDataResolver index;
    IDataResolver* resolver = nullptr;
    if (!build_resolver(opt, map, index, resolver, err)) {
        DiagramError e;
        e.code = "data_id";
        e.message = err;
        sink.emit("error", 0.0, to_json(e));
        sink.emit("task.state", 0.0, json{{"run_state", "failed"}, {"result", "invalid"}, {"reasons", json::array({err})}});
        diag << err << "\n";
        return ExitDiagram;
    }

    MapScenarioResolver smap;
    FileScenarioResolver sfiles;
    IScenarioResolver* sresolver = nullptr;
    if (!build_scenario_resolver(opt, smap, sfiles, sresolver, err)) {
        DiagramError se;
        se.code = "scenario";
        se.message = err;
        sink.emit("error", 0.0, to_json(se));
        sink.emit("task.state", 0.0, json{{"run_state", "failed"}, {"result", "invalid"}, {"reasons", json::array({err})}});
        diag << err << "\n";
        return ExitDiagram;
    }

    Registry registry = builtin_registry();
    LoadedDiagram d;
    DiagramError e;
    LoadOptions lo;
    lo.out_dir = opt.out_dir;
    lo.scenarios = sresolver;
    lo.scene_root = opt.scene_root;
    if (!load_diagram_file(opt.diagram_path, registry, resolver, lo, d, e)) {
        sink.emit("error", 0.0, to_json(e));
        sink.emit("task.state", 0.0, json{{"run_state", "failed"}, {"result", "invalid"}, {"reasons", json::array({e.message})}});
        diag << "框图装载失败 [" << e.code << "] " << e.message << "\n";
        return ExitDiagram;
    }

    std::string seed_source = "diagram";
    if (opt.seed_given) {
        seed_source = "cli";
        if (opt.seed != d.run.seed) {
            std::ostringstream o;
            o << "种子由命令行覆盖：框图 run.seed = " << d.run.seed << " → " << opt.seed;
            sink.emit("log", 0.0, json{{"level", "info"}, {"message", o.str()}});
        }
        d.run.seed = opt.seed;
    }

    json names = json::array();
    for (const auto& kv : d.node_ids) names.push_back(kv.first);
    const std::string started = platform::utc_now_iso8601();
    sink.emit("task.state", 0.0, json{{"run_state", "running"}, {"diagram_id", d.diagram_id}, {"name", d.name},
                                      {"seed", d.run.seed}, {"seed_source", seed_source},
                                      {"run", run_json(d.run)}, {"nodes", names},
                                      {"observation_points", taps_json(d)},
                                      {"engine_version", engine_version()}, {"started_utc", started}});
    {
        std::ostringstream o;
        o << "已装载框图 " << d.diagram_id << "：" << d.node_ids.size() << " 节点 " << d.edge_count
          << " 连线 " << d.taps.size() << " 观测点；种子 " << d.run.seed << "（" << seed_source << "）";
        sink.emit("log", 0.0, json{{"level", "info"}, {"message", o.str()}});
    }

    Xoshiro256pp rng(d.run.seed);
    RunnerObserver obs(sink, opt.progress_interval_ms);
    obs.set_out_dir(opt.out_dir);
    const Clock::time_point t0 = Clock::now();
    RunReport rep = d.run.max_rounds ? d.graph.run(rng, obs, d.run.max_rounds) : d.graph.run(rng, obs);
    const double wall_s = std::chrono::duration<double>(Clock::now() - t0).count();
    const std::string ended = platform::utc_now_iso8601();
    obs.write_detections_index();   // 摘要在各检测器 flush() 时到齐，此刻才能写

    json nodes = json::array();
    for (std::size_t i = 0; i < rep.node_status.size(); ++i) {
        nodes.push_back(status_json(i < rep.node_names.size() ? rep.node_names[i] : "", rep.node_status[i]));
    }
    json common{{"diagram_id", d.diagram_id}, {"seed", d.run.seed}, {"rounds", rep.rounds},
                {"wall_s", wall_s}, {"realtime_factor", wall_s > 0.0 ? d.run.duration_s / wall_s : 0.0},
                {"product_rows", obs.rows()}, {"detection_rows", obs.detections_written()}, {"nodes", nodes},
                {"started_utc", started}, {"ended_utc", ended}, {"engine_version", engine_version()}};

    if (!rep.ok) {
        DiagramError re;
        re.code = "run_failed";
        re.node_id = failing_node(d, rep.error);
        re.message = rep.error;
        sink.emit("error", obs.last_t_s(), to_json(re));
        json p = common;
        p["run_state"] = "failed";
        p["result"] = "invalid";
        p["reasons"] = json::array({rep.error});
        sink.emit("task.state", obs.last_t_s(), p);
        diag << "运行失败：" << rep.error << "\n";
        return ExitRunFailed;
    }

    json reasons = json::array();
    for (const auto& n : rep.notes) reasons.push_back(n);
    json p = common;
    p["run_state"] = "finished";
    p["result"] = to_string(rep.state);
    p["reasons"] = reasons;
    sink.emit("task.state", obs.last_t_s(), p);
    diag << "运行结束：" << d.diagram_id << "，结果 " << to_string(rep.state) << "，" << rep.rounds << " 轮，"
         << obs.rows() << " 行产品，墙钟 " << wall_s << " s\n";
    return ExitOk;
}

// --scenario-track：只跑运动学，输出 entity 事件流。
//
// 不建产品目录、不发 progress、不按墙钟节流，所以 stdout **逐字节可复现**——
// 它因此既是黄金基准 tests/golden/scenario-track-demo-01.json 的生成器，
// 也是应用服务 PUT /api/v1/scenarios/{id} 的语义校验器（只看退出码：0 通过，2 不合法）。
int do_scenario_track(const Options& opt, std::ostream& events, std::ostream& diag) {
    EventSink sink(events);

    LoadedScenario loaded;
    std::string err;
    if (!load_scenario_file(opt.scenario_path, loaded, err)) {
        sink.set_task_id("");
        sink.emit("error", 0.0, json{{"code", "scenario"}, {"node_id", ""}, {"port", ""}, {"message", err}});
        diag << err << "\n";
        return ExitDiagram;
    }
    const geo::Scenario& sc = loaded.scenario;
    sink.set_task_id(sc.scenario_id);

    // 观测区域清单哈希：--scene-root 给了空串即跳过，并在摘要里写明没查（不静默略过，铁律 15）。
    bool aoi_checked = false;
    std::string aoi_actual;
    if (!opt.scene_root.empty()) {
        if (!check_aoi_manifest(sc, opt.scene_root, aoi_actual, err)) {
            sink.emit("error", 0.0, json{{"code", "scenario"}, {"node_id", ""}, {"port", ""}, {"message", err}});
            diag << err << "\n";
            return ExitDiagram;
        }
        aoi_checked = true;
    }

    std::vector<geo::EmitterRuntime> rt(sc.emitters.size());
    for (std::size_t i = 0; i < sc.emitters.size(); ++i) {
        if (!rt[i].build(sc, sc.emitters[i].id, err)) {
            sink.emit("error", 0.0, json{{"code", "scenario"}, {"node_id", sc.emitters[i].id}, {"port", ""}, {"message", err}});
            diag << err << "\n";
            return ExitDiagram;
        }
    }

    // 采样点数：闭区间 [0, duration_s]，末刻也取一次，便于与浏览器预览在两端对齐。
    const double rate = opt.track_rate_Hz;
    const std::uint64_t n = static_cast<std::uint64_t>(std::floor(sc.duration_s * rate + 1e-9)) + 1;
    for (std::uint64_t k = 0; k < n; ++k) {
        const double t = static_cast<double>(k) / rate;
        for (std::size_t i = 0; i < rt.size(); ++i) {
            const geo::MotionState m = rt[i].motion_at(t);
            sink.emit("entity", t,
                      json{{"id", rt[i].id()},
                           {"lon", m.position.lon_deg},
                           {"lat", m.position.lat_deg},
                           {"alt_m", m.position.alt_m},
                           {"heading_deg", m.heading_deg},
                           {"speed_mps", m.speed_mps},
                           {"tx_on", rt[i].tx_on_at(t)},
                           {"center_Hz", rt[i].center_Hz_at(t)}});
        }
    }

    sink.emit("task.state", sc.duration_s,
              json{{"run_state", "finished"},
                   {"result", "valid"},
                   {"scenario_id", sc.scenario_id},
                   {"scenario_sha256", loaded.sha256},
                   {"aoi_id", sc.aoi_id},
                   {"aoi_manifest_checked", aoi_checked},
                   {"entities", static_cast<std::uint64_t>(rt.size())},
                   {"samples", n},
                   {"track_rate_Hz", rate},
                   {"duration_s", sc.duration_s},
                   {"engine_version", engine_version()}});
    return ExitOk;
}

}  // namespace

const char* usage() {
    return
        "用法：\n"
        "  cuav_run --catalog\n"
        "  cuav_run --validate <框图.json> [--task-id <id>] [--resolved <旁挂.json> | --data-index <索引.json>...]\n"
        "           [--scenario <场景.json>...] [--scene-root <目录>]\n"
        "  cuav_run --run <框图.json> --out <产品目录> [--task-id <id>] [--seed N]\n"
        "           [--resolved <旁挂.json> | --data-index <索引.json>...] [--scenario <场景.json>...]\n"
        "           [--scene-root <目录>] [--progress-interval-ms N]\n"
        "  cuav_run --scenario-track <场景.json> [--track-rate Hz] [--scene-root <目录>]\n"
        "退出码：0 成功；1 命令行错误；2 框图装载失败；3 运行失败；4 产品目录或事件文件不可写。\n"
        "stdout 每行一条 JSON 事件 {seq, task_id, type, t_s, payload}；诊断文字在 stderr。\n";
}

bool parse_args(int argc, const char* const* argv, Options& opt, std::string& err) {
    opt = Options();
    bool track_rate_given = false;
    bool scene_root_given = false;
    auto set_mode = [&](Mode m) {
        if (opt.mode != Mode::None) { err = "只能给一个子命令"; return false; }
        opt.mode = m;
        return true;
    };
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto value = [&](std::string& dst) {
            if (i + 1 >= argc) { err = a + " 缺参数"; return false; }
            dst = argv[++i];
            return true;
        };
        if (a == "--help" || a == "-h") { if (!set_mode(Mode::Help)) return false; }
        else if (a == "--catalog") { if (!set_mode(Mode::Catalog)) return false; }
        else if (a == "--validate") { if (!set_mode(Mode::Validate) || !value(opt.diagram_path)) return false; }
        else if (a == "--run") { if (!set_mode(Mode::Run) || !value(opt.diagram_path)) return false; }
        else if (a == "--scenario-track") { if (!set_mode(Mode::ScenarioTrack) || !value(opt.scenario_path)) return false; }
        else if (a == "--out") { if (!value(opt.out_dir)) return false; }
        else if (a == "--task-id") { if (!value(opt.task_id)) return false; }
        else if (a == "--resolved") { if (!value(opt.resolved_path)) return false; }
        else if (a == "--data-index") { std::string p; if (!value(p)) return false; opt.data_index_paths.push_back(p); }
        else if (a == "--scenario") { std::string p; if (!value(p)) return false; opt.scenario_paths.push_back(p); }
        else if (a == "--seed") {
            std::string v;
            if (!value(v)) return false;
            if (!parse_u64(v, opt.seed)) { err = "--seed 必须是不小于 0 的整数：" + v; return false; }
            opt.seed_given = true;
        }
        else if (a == "--track-rate") {
            std::string v;
            if (!value(v)) return false;
            char* end = 0;
            opt.track_rate_Hz = std::strtod(v.c_str(), &end);
            if (end == v.c_str() || *end != '\0' || !(opt.track_rate_Hz >= 1.0) || !(opt.track_rate_Hz <= 100.0)) {
                err = "--track-rate 必须是 1 到 100 之间的数：" + v;
                return false;
            }
            track_rate_given = true;
        }
        else if (a == "--scene-root") { if (!value(opt.scene_root)) return false; scene_root_given = true; }
        else if (a == "--progress-interval-ms") {
            std::string v;
            if (!value(v)) return false;
            if (!parse_u64(v, opt.progress_interval_ms)) { err = "--progress-interval-ms 必须是不小于 0 的整数：" + v; return false; }
        }
        else { err = "未知选项 " + a; return false; }
    }
    if (opt.mode == Mode::None) { err = "缺子命令"; return false; }
    if (opt.mode == Mode::Run && opt.out_dir.empty()) { err = "--run 需要 --out <产品目录>"; return false; }
    if (opt.mode != Mode::Run && !opt.out_dir.empty()) { err = "--out 只与 --run 搭配"; return false; }
    if (opt.mode != Mode::Run && opt.seed_given) { err = "--seed 只与 --run 搭配"; return false; }
    if (!opt.resolved_path.empty() && !opt.data_index_paths.empty()) { err = "--resolved 与 --data-index 只能给一种"; return false; }
    if ((opt.mode == Mode::Catalog || opt.mode == Mode::Help || opt.mode == Mode::ScenarioTrack) &&
        (!opt.resolved_path.empty() || !opt.data_index_paths.empty() || !opt.task_id.empty() ||
         !opt.scenario_paths.empty())) {
        err = "--resolved / --data-index / --task-id / --scenario 只与 --validate 或 --run 搭配";
        return false;
    }
    if (opt.mode != Mode::ScenarioTrack && track_rate_given) { err = "--track-rate 只与 --scenario-track 搭配"; return false; }
    if (opt.mode == Mode::Catalog || opt.mode == Mode::Help) {
        if (scene_root_given) { err = "--scene-root 只与 --validate / --run / --scenario-track 搭配"; return false; }
    }
    if (opt.diagram_path.empty() && (opt.mode == Mode::Run || opt.mode == Mode::Validate)) { err = "缺框图文件"; return false; }
    return true;
}

int run(const Options& opt, std::ostream& events, std::ostream& diag) {
    switch (opt.mode) {
        case Mode::Help: diag << usage(); return ExitOk;
        case Mode::Catalog: return do_catalog(events, diag);
        case Mode::Validate: return do_validate(opt, events, diag);
        case Mode::Run: return do_run(opt, events, diag);
        case Mode::ScenarioTrack: return do_scenario_track(opt, events, diag);
        default: diag << usage(); return ExitUsage;
    }
}

}  // namespace runner
}  // namespace cuav
