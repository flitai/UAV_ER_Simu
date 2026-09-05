// cuav_run 运行器（B-4）：命令行解析、目录、只校验、运行事件流、events.jsonl 镜像、种子覆盖、数据解析入口、退出码。
#include "doctest/doctest.h"

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/catalog.h"
#include "cuav/platform.h"
#include "cuav/registry.h"
#include "runner.h"

using namespace cuav;
using namespace cuav::runner;
using nlohmann::json;

namespace {

std::string temp_root() {
    const char* t = std::getenv("TMPDIR");
    std::string d = t ? t : "/tmp/";
    if (!d.empty() && d[d.size() - 1] != '/') d += '/';
    return d + "cuav_runner_test";
}

std::string fixture() { return std::string(CUAV_SOURCE_DIR) + "/tests/diagrams/slice1_tone_noise_psd.json"; }

struct Result {
    int code = -1;
    std::string out, diag;
    std::vector<json> events;
};

bool parse(const std::vector<std::string>& args, Options& opt, std::string& err) {
    std::vector<const char*> argv;
    argv.push_back("cuav_run");
    for (const auto& a : args) argv.push_back(a.c_str());
    return parse_args(static_cast<int>(argv.size()), argv.data(), opt, err);
}

Result run_cli(const std::vector<std::string>& args, bool parse_events = true) {
    Options opt;
    std::string err;
    REQUIRE_MESSAGE(parse(args, opt, err), err);
    std::ostringstream out, diag;
    Result r;
    r.code = run(opt, out, diag);
    r.out = out.str();
    r.diag = diag.str();
    if (!parse_events) return r;                 // --catalog 输出的是多行目录 JSON，不是事件流
    std::istringstream is(r.out);
    std::string line;
    while (std::getline(is, line)) {
        if (line.empty()) continue;
        r.events.push_back(json::parse(line));
    }
    return r;
}

std::string read_file(const std::string& p) {
    std::ifstream f(p.c_str(), std::ios::binary);
    std::ostringstream o;
    o << f.rdbuf();
    return o.str();
}

std::size_t count_type(const Result& r, const std::string& type) {
    std::size_t n = 0;
    for (const auto& e : r.events) if (e["type"] == type) ++n;
    return n;
}

void write_text(const std::string& path, const std::string& text) {
    std::ofstream f(path.c_str(), std::ios::binary | std::ios::trunc);
    f << text;
}

// 回放夹具：.iq + 旁挂清单 + 数据索引 + 解析旁挂 + 回放框图
struct ReplayFixture {
    std::string dir, manifest, index, resolved, diagram;
};

ReplayFixture make_replay_fixture(const std::string& dir) {
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    std::vector<std::int16_t> v(3000 * 2);
    for (std::size_t i = 0; i < v.size(); ++i) v[i] = static_cast<std::int16_t>((i * 53) % 4000 - 2000);
    {
        std::ofstream f((dir + "/fx_run_1.iq").c_str(), std::ios::binary);
        f.write(reinterpret_cast<const char*>(v.data()), static_cast<std::streamsize>(v.size() * 2));
    }
    ReplayFixture fx;
    fx.dir = dir;
    fx.manifest = dir + "/fx_run_1.manifest.json";
    write_text(fx.manifest,
        "{\"manifest_version\": \"1.0\", \"observation_point\": \"S4\",\n"
        " \"sampling\": {\"sample_format\": \"ci16_le\", \"byte_order\": \"little\", \"iq_layout\": \"interleaved_IQ\","
        " \"internal_format\": \"cf32\", \"sample_rate_Hz\": 1e6, \"sample_count\": 3000},\n"
        " \"frequency\": {\"center_frequency_Hz\": 2.44e9, \"effective_bandwidth_Hz\": 1e6},\n"
        " \"power\": {\"full_scale\": 32768, \"scale\": null},\n"
        " \"quality\": {\"status\": \"degraded\", \"reasons\": [\"测试夹具\"]}, \"segments\": []}\n");
    fx.index = dir + "/index.manifest.json";
    write_text(fx.index, "{\"schema\": \"cuav-batch-index/1\", \"products\": [{\"data_id\": \"fx_run_1\"}]}\n");
    fx.resolved = dir + "/diagram.resolved.json";
    write_text(fx.resolved, "{\"schema_version\": \"cuav-resolved/1\", \"data\": {\"fx_run_1\": \"" + fx.manifest + "\"}}\n");
    fx.diagram = dir + "/replay.json";
    write_text(fx.diagram,
        "{\"schema_version\": \"cuav-diagram/1\", \"diagram_id\": \"replay-psd\", \"name\": \"回放到功率谱\",\n"
        " \"nodes\": [{\"id\": \"replay\", \"type\": \"FileReplaySource\", \"params\": {\"data_id\": \"fx_run_1\", \"block_samples\": 1000}},\n"
        "           {\"id\": \"psd\", \"type\": \"SpectrumAnalyzer\", \"params\": {\"nfft\": 256}}],\n"
        " \"edges\": [{\"id\": \"e1\", \"from\": {\"node\": \"replay\", \"port\": \"out\"}, \"to\": {\"node\": \"psd\", \"port\": \"in\"}}],\n"
        " \"observation_points\": [{\"id\": \"s4\", \"node\": \"replay\", \"port\": \"out\", \"products\": [\"spectrum\", \"envelope\"]}],\n"
        " \"run\": {\"seed\": 1, \"duration_s\": 1.0, \"time_basis\": \"LogicalSim\"}}\n");
    return fx;
}

}  // namespace

TEST_CASE("cuav_run 命令行：子命令唯一、--run 要 --out、解析入口互斥、非法数字、未知选项") {
    Options opt;
    std::string err;
    CHECK(!parse({}, opt, err));
    CHECK(!parse({"--run", "x.json"}, opt, err));
    CHECK(err.find("--out") != std::string::npos);
    CHECK(!parse({"--catalog", "--validate", "x.json"}, opt, err));
    CHECK(!parse({"--validate", "x.json", "--resolved", "a", "--data-index", "b"}, opt, err));
    CHECK(!parse({"--run", "x.json", "--out", "d", "--seed", "-1"}, opt, err));
    CHECK(!parse({"--run", "x.json", "--out", "d", "--seed", "1.5"}, opt, err));
    CHECK(!parse({"--validate", "x.json", "--seed", "3"}, opt, err));
    CHECK(!parse({"--catalog", "--out", "d"}, opt, err));
    CHECK(!parse({"--frobnicate"}, opt, err));
    CHECK(!parse({"--validate"}, opt, err));
    REQUIRE(parse({"--run", "x.json", "--out", "d", "--seed", "7", "--task-id", "t1",
                   "--data-index", "i1", "--data-index", "i2", "--progress-interval-ms", "0"}, opt, err));
    CHECK(opt.mode == Mode::Run);
    CHECK(opt.seed_given);
    CHECK(opt.seed == 7u);
    CHECK(opt.task_id == "t1");
    CHECK(opt.data_index_paths.size() == 2);
    CHECK(opt.progress_interval_ms == 0u);
    REQUIRE(parse({"--scenario-track", "s.json"}, opt, err));
    std::ostringstream o, d;
    CHECK(run(opt, o, d) == ExitUsage);
    CHECK(d.str().find("G-2") != std::string::npos);
    REQUIRE(parse({"--help"}, opt, err));
    CHECK(run(opt, o, d) == ExitOk);
    CHECK(d.str().find("用法") != std::string::npos);
}

TEST_CASE("cuav_run --catalog：输出与 catalog_json() 逐字节相同，且是合法目录") {
    Result r = run_cli({"--catalog"}, false);
    CHECK(r.code == ExitOk);
    CHECK(r.out == catalog_json(builtin_registry()).dump(2) + "\n");
    json j = json::parse(r.out);
    CHECK(j["schema_version"] == "cuav-catalog/1");
    CHECK(j["components"].size() == 8);
}

TEST_CASE("cuav_run --validate：合法框图一条 validate 事件；非法框图一条 error 事件并退出 2") {
    Result r = run_cli({"--validate", fixture()});
    CHECK(r.code == ExitOk);
    REQUIRE(r.events.size() == 1);
    CHECK(r.events[0]["seq"] == 1);
    CHECK(r.events[0]["type"] == "validate");
    CHECK(r.events[0]["task_id"] == "slice1-tone-noise-psd");    // 缺省取 diagram_id
    CHECK(r.events[0]["payload"]["ok"] == true);
    CHECK(r.events[0]["payload"]["nodes"].size() == 4);
    CHECK(r.events[0]["payload"]["edges"] == 3);
    CHECK(r.events[0]["payload"]["observation_points"].size() == 1);
    CHECK(r.events[0]["payload"]["run"]["seed"] == 20260904);
    CHECK(r.diag.find("校验通过") != std::string::npos);

    const std::string dir = temp_root() + "/validate";
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    json bad = json::parse(read_file(fixture()));
    bad["nodes"][0]["type"] = "FileReplaySource";
    bad["nodes"][0]["params"] = {{"data_id", "x"}, {"manifest_path", "/srv/x"}};   // 内部参数出现即拒（D-037）
    write_text(dir + "/bad.json", bad.dump());
    r = run_cli({"--validate", dir + "/bad.json", "--task-id", "v1"});
    CHECK(r.code == ExitDiagram);
    REQUIRE(r.events.size() == 1);
    CHECK(r.events[0]["type"] == "error");
    CHECK(r.events[0]["task_id"] == "v1");
    CHECK(r.events[0]["payload"]["code"] == "internal_param");
    CHECK(r.events[0]["payload"]["node_id"] == "tone");

    r = run_cli({"--validate", dir + "/missing.json"});
    CHECK(r.code == ExitDiagram);
    REQUIRE(r.events.size() == 1);
    CHECK(r.events[0]["payload"]["code"] == "json_parse");
    CHECK(r.events[0]["task_id"] == "missing");                    // 装载失败时取文件名主干
}

TEST_CASE("cuav_run --run：切片 ① 框图跑到底，事件流信封、序号、产品行、events.jsonl 镜像") {
    const std::string out = temp_root() + "/run_slice1";
    Result r = run_cli({"--run", fixture(), "--out", out});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);
    REQUIRE(r.events.size() >= 4);
    // 序号从 1 连续递增，信封五键
    for (std::size_t i = 0; i < r.events.size(); ++i) {
        const json& e = r.events[i];
        CHECK(e["seq"] == i + 1);
        CHECK(e["task_id"] == "run_slice1");                         // 缺省取 --out 末级目录名
        CHECK(e.contains("type"));
        CHECK(e.contains("t_s"));
        CHECK(e.contains("payload"));
        CHECK(e.size() == 5);
    }
    const json& first = r.events.front();
    CHECK(first["type"] == "task.state");
    CHECK(first["payload"]["run_state"] == "running");
    CHECK(first["payload"]["seed"] == 20260904);
    CHECK(first["payload"]["seed_source"] == "diagram");
    CHECK(first["payload"]["observation_points"][0]["op_id"] == "s4");
    CHECK(first["payload"]["started_utc"].get<std::string>().size() == 20);
    const json& last = r.events.back();
    CHECK(last["type"] == "task.state");
    CHECK(last["payload"]["run_state"] == "finished");
    CHECK(last["payload"]["result"] == "valid");
    CHECK(last["payload"]["product_rows"] == 1953 + 489);
    CHECK(last["payload"]["nodes"].size() == 5);
    CHECK(last["payload"]["realtime_factor"].get<double>() > 0.0);
    CHECK(last["payload"]["reasons"].is_array());
    CHECK(count_type(r, "product_row") == 1953u + 489u);
    CHECK(count_type(r, "progress") >= 1);
    CHECK(count_type(r, "log") >= 1);
    CHECK(count_type(r, "error") == 0);
    // product_row 事件的 t_s 单调不减（谱行按样点序推进）
    double last_t = -1.0;
    bool monotone = true;
    for (const auto& e : r.events) {
        if (e["type"] == "product_row" && e["payload"]["kind"] == "spectrum") {
            if (e["t_s"].get<double>() < last_t) monotone = false;
            last_t = e["t_s"].get<double>();
        }
    }
    CHECK(monotone);
    // events.jsonl 与 stdout 逐字节相同；产品文件在
    CHECK(read_file(out + "/events.jsonl") == r.out);
    CHECK(read_file(out + "/s4/spectrum.f32").size() == 1953u * 1024u * 4u);
    json idx = json::parse(read_file(out + "/s4/spectrum.index.json"));
    CHECK(idx["rows"] == 1953);
}

TEST_CASE("cuav_run --run：--seed 覆盖框图种子并写明来源；--progress-interval-ms 0 每轮都发") {
    const std::string out = temp_root() + "/run_seed";
    Result r = run_cli({"--run", fixture(), "--out", out, "--seed", "7", "--task-id", "t7", "--progress-interval-ms", "0"});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);
    CHECK(r.events.front()["task_id"] == "t7");
    bool overridden = false;
    for (const auto& e : r.events) {
        if (e["type"] == "log" && e["payload"]["message"].get<std::string>().find("覆盖") != std::string::npos) overridden = true;
    }
    CHECK(overridden);
    const json* state = nullptr;
    for (const auto& e : r.events) if (e["type"] == "task.state") { state = &e; break; }
    REQUIRE(state);
    CHECK((*state)["payload"]["seed"] == 7);
    CHECK((*state)["payload"]["seed_source"] == "cli");
    const std::uint64_t rounds = r.events.back()["payload"]["rounds"].get<std::uint64_t>();
    CHECK(count_type(r, "progress") >= rounds);      // 不节流：每轮一条（收尾轮也算）
    for (const auto& e : r.events) {
        if (e["type"] == "progress") { CHECK(e["payload"]["nodes"].size() == 5); break; }
    }
    // 同种子两次运行产品逐字节相同
    const std::string out2 = temp_root() + "/run_seed2";
    Result r2 = run_cli({"--run", fixture(), "--out", out2, "--seed", "7"});
    REQUIRE(r2.code == ExitOk);
    CHECK(read_file(out + "/s4/spectrum.f32") == read_file(out2 + "/s4/spectrum.f32"));
}

TEST_CASE("cuav_run --run：回放框图经 --data-index 或 --resolved 解析；两者都不给则 error data_id 并退出 2") {
    ReplayFixture fx = make_replay_fixture(temp_root() + "/replay");
    Result r = run_cli({"--run", fx.diagram, "--out", fx.dir + "/out_index", "--data-index", fx.index});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);
    CHECK(r.events.back()["payload"]["run_state"] == "finished");
    json idx = json::parse(read_file(fx.dir + "/out_index/s4/spectrum.index.json"));
    CHECK(idx["trace"]["trace_id"] == "FileReplaySource:fx_run_1");
    CHECK(idx["rows"] == 3000 / 1024);          // 观测点用自己的 nfft（缺省 1024），不是 psd 节点的 256

    r = run_cli({"--run", fx.diagram, "--out", fx.dir + "/out_resolved", "--resolved", fx.resolved});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);
    CHECK(read_file(fx.dir + "/out_resolved/s4/spectrum.f32") == read_file(fx.dir + "/out_index/s4/spectrum.f32"));

    r = run_cli({"--run", fx.diagram, "--out", fx.dir + "/out_none"});
    CHECK(r.code == ExitDiagram);
    REQUIRE(r.events.size() == 2);
    CHECK(r.events[0]["type"] == "error");
    CHECK(r.events[0]["payload"]["code"] == "data_id");
    CHECK(r.events[0]["payload"]["node_id"] == "replay");
    CHECK(r.events[1]["type"] == "task.state");
    CHECK(r.events[1]["payload"]["run_state"] == "failed");
    CHECK(read_file(fx.dir + "/out_none/events.jsonl") == r.out);   // 失败也镜像

    r = run_cli({"--run", fx.diagram, "--out", fx.dir + "/out_badidx", "--data-index", fx.dir + "/nope.json"});
    CHECK(r.code == ExitDiagram);
    CHECK(r.events[0]["payload"]["code"] == "data_id");

    r = run_cli({"--validate", fx.diagram, "--resolved", fx.resolved});
    CHECK(r.code == ExitOk);
    CHECK(r.events[0]["type"] == "validate");
}
