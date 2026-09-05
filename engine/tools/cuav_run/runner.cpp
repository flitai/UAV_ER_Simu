#include "runner.h"

#include <chrono>
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

    void on_entity(const EntityState& e) override {
        if (e.t_s > last_t_s_) last_t_s_ = e.t_s;
        sink_.emit("entity", e.t_s, json{{"id", e.id}, {"lon", e.lon}, {"lat", e.lat}, {"alt_m", e.alt_m},
                                         {"heading_deg", e.heading_deg}, {"speed_mps", e.speed_mps},
                                         {"tx_on", e.tx_on}, {"center_Hz", e.center_Hz}});
    }

    void on_link(const LinkFrame& l) override {
        if (l.t_s > last_t_s_) last_t_s_ = l.t_s;
        sink_.emit("link", l.t_s, json{{"link_id", l.link_id}, {"line_of_sight", l.line_of_sight},
                                       {"distance_m", l.distance_m}, {"azimuth_deg", l.azimuth_deg},
                                       {"elevation_deg", l.elevation_deg}, {"path_loss_dB", l.path_loss_dB},
                                       {"delay_s", l.delay_s}, {"doppler_Hz", l.doppler_Hz},
                                       {"valid_from_s", l.valid_from_s}, {"valid_to_s", l.valid_to_s},
                                       {"update_rate_Hz", l.update_rate_Hz}, {"state", to_string(l.state)}});
    }

    double last_t_s() const { return last_t_s_; }
    std::uint64_t rows() const { return rows_; }
    std::uint64_t progress_events() const { return progress_events_; }
    std::uint64_t rounds_seen() const { return rounds_seen_; }

private:
    EventSink& sink_;
    std::chrono::milliseconds interval_;
    bool throttle_;
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
    Registry registry = builtin_registry();
    LoadedDiagram d;
    DiagramError e;
    LoadOptions lo;   // out_dir 为空：只校验，不落盘
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

    Registry registry = builtin_registry();
    LoadedDiagram d;
    DiagramError e;
    LoadOptions lo;
    lo.out_dir = opt.out_dir;
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
    const Clock::time_point t0 = Clock::now();
    RunReport rep = d.run.max_rounds ? d.graph.run(rng, obs, d.run.max_rounds) : d.graph.run(rng, obs);
    const double wall_s = std::chrono::duration<double>(Clock::now() - t0).count();
    const std::string ended = platform::utc_now_iso8601();

    json nodes = json::array();
    for (std::size_t i = 0; i < rep.node_status.size(); ++i) {
        nodes.push_back(status_json(i < rep.node_names.size() ? rep.node_names[i] : "", rep.node_status[i]));
    }
    json common{{"diagram_id", d.diagram_id}, {"seed", d.run.seed}, {"rounds", rep.rounds},
                {"wall_s", wall_s}, {"realtime_factor", wall_s > 0.0 ? d.run.duration_s / wall_s : 0.0},
                {"product_rows", obs.rows()}, {"nodes", nodes},
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

}  // namespace

const char* usage() {
    return
        "用法：\n"
        "  cuav_run --catalog\n"
        "  cuav_run --validate <框图.json> [--task-id <id>] [--resolved <旁挂.json> | --data-index <索引.json>...]\n"
        "  cuav_run --run <框图.json> --out <产品目录> [--task-id <id>] [--seed N]\n"
        "           [--resolved <旁挂.json> | --data-index <索引.json>...] [--progress-interval-ms N]\n"
        "  cuav_run --scenario-track <场景.json>        （G-2 后实现）\n"
        "退出码：0 成功；1 命令行错误；2 框图装载失败；3 运行失败；4 产品目录或事件文件不可写。\n"
        "stdout 每行一条 JSON 事件 {seq, task_id, type, t_s, payload}；诊断文字在 stderr。\n";
}

bool parse_args(int argc, const char* const* argv, Options& opt, std::string& err) {
    opt = Options();
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
        else if (a == "--seed") {
            std::string v;
            if (!value(v)) return false;
            if (!parse_u64(v, opt.seed)) { err = "--seed 必须是不小于 0 的整数：" + v; return false; }
            opt.seed_given = true;
        }
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
        (!opt.resolved_path.empty() || !opt.data_index_paths.empty() || !opt.task_id.empty())) {
        err = "--resolved / --data-index / --task-id 只与 --validate 或 --run 搭配";
        return false;
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
        case Mode::ScenarioTrack:
            diag << "--scenario-track 在 G-2（场景运行时 ScenarioSource）落地后实现，当前版本不支持\n";
            return ExitUsage;
        default: diag << usage(); return ExitUsage;
    }
}

}  // namespace runner
}  // namespace cuav
