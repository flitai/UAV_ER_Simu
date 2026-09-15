// cuav_run 运行器（B-4）：命令行解析、目录、只校验、运行事件流、events.jsonl 镜像、种子覆盖、数据解析入口、退出码。
#include "doctest/doctest.h"

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <set>
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
std::string detect_fixture() { return std::string(CUAV_SOURCE_DIR) + "/tests/diagrams/slice4_detect.json"; }
std::string feature_fixture() { return std::string(CUAV_SOURCE_DIR) + "/tests/diagrams/slice4_feature.json"; }
std::string recognize_fixture() { return std::string(CUAV_SOURCE_DIR) + "/tests/diagrams/slice4_recognize.json"; }
std::string library_root() { return std::string(CUAV_SOURCE_DIR) + "/../models/recognition"; }
std::string evaluate_fixture() { return std::string(CUAV_SOURCE_DIR) + "/tests/diagrams/slice4_evaluate.json"; }
std::string evaluate_scene_fixture() { return std::string(CUAV_SOURCE_DIR) + "/tests/diagrams/slice4_evaluate_scene.json"; }
std::string demo01_scenario() { return std::string(CUAV_SOURCE_DIR) + "/../data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json"; }
std::string scene_root() { return std::string(CUAV_SOURCE_DIR) + "/../data/scene"; }

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
    // --scenario-track 已于 G-1 实现（原先返回 ExitUsage 说"待 G-2"）。
    // 场景文件不存在时走装载失败：一条 error 事件 + 退出码 2，这正是服务端 PUT 场景的判据。
    REQUIRE(parse({"--scenario-track", "s.json"}, opt, err));
    CHECK(opt.track_rate_Hz == 10.0);
    std::ostringstream o, d;
    CHECK(run(opt, o, d) == ExitDiagram);
    CHECK(o.str().find("\"code\":\"scenario\"") != std::string::npos);
    CHECK_FALSE(d.str().empty());
    // --track-rate 与 --scene-root 只跟 --scenario-track 搭配。
    CHECK_FALSE(parse({"--catalog", "--track-rate", "5"}, opt, err));
    CHECK(parse({"--validate", "d.json", "--scene-root", "x"}, opt, err));   // 装载器选项，校验与运行都要
    CHECK_FALSE(parse({"--catalog", "--scene-root", "x"}, opt, err));
    CHECK_FALSE(parse({"--scenario-track", "s.json", "--track-rate", "0.5"}, opt, err));
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
    CHECK(j["components"].size() == 22);
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

TEST_CASE("cuav_run --run：带检测器的框图逐帧落 detections.jsonl、写 detections.index.json，detection 事件按段首帧（C-3，D-063）") {
    const std::string out = temp_root() + "/run_detect";
    Result r = run_cli({"--run", detect_fixture(), "--out", out});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);

    // 行文件：每行自带 t_s、以换行结尾（读端把无换行的末行当残片丢），行数 = 帧数
    const std::string text = read_file(out + "/detections.jsonl");
    REQUIRE(!text.empty());
    CHECK(text[text.size() - 1] == '\n');
    std::vector<json> rows;
    {
        std::istringstream is(text);
        std::string line;
        while (std::getline(is, line)) if (!line.empty()) rows.push_back(json::parse(line));
    }
    const std::uint64_t frames = 2000000 / 256;
    REQUIRE(rows.size() == frames);
    double last_t = -1.0;
    std::uint64_t hits = 0, hits_after = 0, after = 0;
    std::set<std::int64_t> segs;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        const json& row = rows[i];
        CHECK(row["t_s"].is_number());
        CHECK(row["t_s"].get<double>() >= last_t);
        last_t = row["t_s"].get<double>();
        CHECK(row["node_id"] == "det");
        CHECK_FALSE(row.contains("site_id"));                      // 没绑站就没有这个键
        CHECK(row["frame_index"] == i);
        CHECK(row["f_lo_Hz"].get<double>() == doctest::Approx(2.44e9 - 1e5));
        CHECK(row["f_hi_Hz"].get<double>() == doctest::Approx(2.44e9 + 1e5));
        CHECK(row.contains("statistic"));
        CHECK(row.contains("threshold"));
        CHECK(row.contains("snr_dB"));
        CHECK(row.contains("overload"));
        CHECK(row.contains("noise_frames_used"));
        CHECK(row.contains("band_power_dBm"));                     // 合成源已标定
        const bool hit = row["hit"].get<bool>();
        if (hit) {
            ++hits;
            CHECK(row["segment_id"].is_number());
            segs.insert(row["segment_id"].get<std::int64_t>());
        } else {
            CHECK(row["segment_id"].is_null());
        }
        if (i >= 2000) { ++after; if (hit) ++hits_after; }
    }
    // 单音从第 2000 帧起持续：之后几乎全命中
    CHECK(static_cast<double>(hits_after) / static_cast<double>(after) >= 0.99);

    // 索引：每个检测器一条摘要，带 trace 与计数
    json idx = json::parse(read_file(out + "/detections.index.json"));
    CHECK(idx["schema"] == "cuav-detections-index/1");
    CHECK(idx["final"] == true);
    CHECK(idx["rows"] == frames);
    REQUIRE(idx["nodes"].contains("det"));
    const json& det = idx["nodes"]["det"];
    CHECK(det["frames"] == frames);
    CHECK(det["hits"] == hits);
    CHECK(det["segments"] == segs.size());
    CHECK(det["noise_mode"] == "sliding");
    CHECK(det["noise_window_frames"] == 256);
    CHECK(det["noise_stale_frames"].get<std::uint64_t>() > 0);
    CHECK(det["trace"]["model_id"] == "EnergyDetector");
    CHECK(det["trace"]["model_layer"] == "M2");
    CHECK(det["calibrated"] == true);
    CHECK_FALSE(det.contains("site_id"));
    CHECK(det["notes"].is_array());

    // 事件：只在段首帧发，条数 = 段数；载荷是行去掉 t_s
    CHECK(count_type(r, "detection") == segs.size());
    double last_ev = -1.0;
    for (const auto& e : r.events) {
        if (e["type"] != "detection") continue;
        CHECK(e["t_s"].get<double>() >= last_ev);
        last_ev = e["t_s"].get<double>();
        CHECK(e["payload"]["hit"] == true);
        CHECK(e["payload"]["node_id"] == "det");
        CHECK_FALSE(e["payload"].contains("t_s"));
    }
    CHECK(r.events.back()["payload"]["detection_rows"] == frames);
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

TEST_CASE("cuav_run --run：带特征提取器的框图每个突发落一行 features.jsonl（行自带 trace），feature 事件按突发，task.state 带 feature_rows（C-4）") {
    const std::string out = temp_root() + "/run_feature";
    Result r = run_cli({"--run", feature_fixture(), "--out", out});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);

    const std::string text = read_file(out + "/features.jsonl");
    REQUIRE(!text.empty());
    CHECK(text[text.size() - 1] == '\n');
    std::vector<json> rows;
    {
        std::istringstream is(text);
        std::string line;
        while (std::getline(is, line)) if (!line.empty()) rows.push_back(json::parse(line));
    }
    REQUIRE(!rows.empty());
    double last_t = -1.0;
    const json* longest = nullptr;
    for (const auto& row : rows) {
        CHECK(row["t_s"].is_number());
        CHECK(row["t_s"].get<double>() >= last_t);
        last_t = row["t_s"].get<double>();
        CHECK(row["t_end_s"].get<double>() > row["t_s"].get<double>());
        CHECK(row["node_id"] == "feat");
        CHECK_FALSE(row.contains("site_id"));
        for (const char* k : {"duration_s", "segment_id", "frames", "center_Hz", "bandwidth_Hz", "signal_bins",
                              "has_dBm", "snr_dB", "spectral_flatness", "crest_factor_dB", "duty", "overload",
                              "quality", "interval_from_prev_s", "hop_from_prev_Hz", "trace"}) {
            CHECK_MESSAGE(row.contains(k), "特征行缺键 " << k);
        }
        CHECK(row["has_dBm"] == true);                       // 合成源已标定
        CHECK(row.contains("band_power_dBm"));
        CHECK(row.contains("peak_dBm"));
        CHECK(row["trace"]["model_id"] == "FeatureExtractor");
        CHECK(row["trace"]["model_layer"] == "M3");
        if (!longest || row["frames"].get<std::uint64_t>() > (*longest)["frames"].get<std::uint64_t>()) longest = &row;
    }
    // 单音从第 2000 帧起持续到结束：最长的一段占了余下的几乎全部帧，质心在 2.44 GHz + 50 kHz 的一个 bin 内
    REQUIRE(longest);
    CHECK((*longest)["frames"].get<std::uint64_t>() >= 5000);
    CHECK((*longest)["quality"] == "full");
    CHECK(std::fabs((*longest)["center_Hz"].get<double>() - (2.44e9 + 50e3)) < 1e6 / 256.0);
    CHECK((*longest)["duty"].get<double>() == 1.0);

    // 事件按突发：条数 = 行数，载荷 = 行去掉 t_s
    CHECK(count_type(r, "feature") == rows.size());
    for (const auto& e : r.events) {
        if (e["type"] != "feature") continue;
        CHECK_FALSE(e["payload"].contains("t_s"));
        CHECK(e["payload"]["node_id"] == "feat");
    }
    // 结束事件带 feature_rows
    const json* last_state = nullptr;
    for (const auto& e : r.events) if (e["type"] == "task.state") last_state = &e;
    REQUIRE(last_state);
    CHECK((*last_state)["payload"]["run_state"] == "finished");
    CHECK((*last_state)["payload"]["feature_rows"] == rows.size());
}

TEST_CASE("cuav_run --run：带模板识别器的框图每行特征落一行 recognitions.jsonl，recognition 事件按突发，--library-root 定位模板库（C-4）") {
    const std::string out = temp_root() + "/run_recognize";
    Result r = run_cli({"--run", recognize_fixture(), "--out", out, "--library-root", library_root()});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);

    std::vector<json> feats, recs;
    for (const auto& pair : std::vector<std::pair<const char*, std::vector<json>*>>{{"features.jsonl", &feats}, {"recognitions.jsonl", &recs}}) {
        const std::string text = read_file(out + "/" + pair.first);
        REQUIRE(!text.empty());
        CHECK(text[text.size() - 1] == '\n');
        std::istringstream is(text);
        std::string line;
        while (std::getline(is, line)) if (!line.empty()) pair.second->push_back(json::parse(line));
    }
    REQUIRE(!recs.empty());
    REQUIRE(recs.size() == feats.size());
    const json* longest = nullptr;
    std::size_t longest_frames = 0;
    for (std::size_t i = 0; i < recs.size(); ++i) {
        const json& row = recs[i];
        CHECK(row["node_id"] == "rec");
        CHECK_FALSE(row.contains("site_id"));
        CHECK(row["segment_id"] == feats[i]["segment_id"]);
        CHECK(row["t_s"] == feats[i]["t_s"]);
        for (const char* k : {"t_end_s", "label", "posterior", "top_n", "distance", "result", "unknown_kind",
                              "evidence_quality", "library_version", "trace"}) {
            CHECK_MESSAGE(row.contains(k), "识别行缺键 " << k);
        }
        CHECK(row["library_version"] == "v1");
        CHECK(row["trace"]["model_id"] == "TemplateClassifier");
        CHECK(row["trace"]["parameter_version"] == "library-v1");
        const std::string res = row["result"].get<std::string>();
        CHECK((res == "known" || res == "ambiguous" || res == "unknown"));
        if (feats[i]["frames"].get<std::size_t>() > longest_frames) { longest_frames = feats[i]["frames"].get<std::size_t>(); longest = &row; }
    }
    // 从第 2000 帧持续到结束的单音（约 1.5 s、几个 bin 宽、占空比 1）判为 cw_beacon
    REQUIRE(longest);
    CHECK((*longest)["result"] == "known");
    CHECK((*longest)["label"] == "cw_beacon");
    CHECK(count_type(r, "recognition") == recs.size());
    const json* last_state = nullptr;
    for (const auto& e : r.events) if (e["type"] == "task.state") last_state = &e;
    REQUIRE(last_state);
    CHECK((*last_state)["payload"]["recognition_rows"] == recs.size());

    // 指到一个没有库的目录：装载失败、退出码 2（缺省目录能不能找到取决于 cwd，不在这里断言）
    Result miss = run_cli({"--validate", recognize_fixture(), "--library-root", temp_root() + "/no_such_library_dir"});
    CHECK(miss.code == ExitDiagram);
}

TEST_CASE("cuav_run：--library-root 只与 --validate / --run 搭配") {
    Options o;
    std::string err;
    const char* argv[] = {"cuav_run", "--catalog", "--library-root", "x"};
    CHECK_FALSE(parse_args(4, argv, o, err));
    CHECK(err.find("--library-root") != std::string::npos);
}


TEST_CASE("cuav_run --run：带评价器的场景框图落 truth.jsonl 一行与 metrics.json 一节；识别行到得了评价器；task.state 带 truth_rows / evaluations（C-5）") {
    const std::string out = temp_root() + "/run_evaluate_scene";
    Result r = run_cli({"--run", evaluate_scene_fixture(), "--out", out, "--scenario", demo01_scenario(),
                        "--scene-root", scene_root(), "--library-root", library_root()});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);

    // truth.jsonl：demo-01 的 uav-1 自 3 s 起发单音直到 6 s 结束，一行、频段内、cw_beacon
    const std::string text = read_file(out + "/truth.jsonl");
    REQUIRE(!text.empty());
    CHECK(text[text.size() - 1] == '\n');
    std::vector<json> rows;
    {
        std::istringstream is(text);
        std::string line;
        while (std::getline(is, line)) if (!line.empty()) rows.push_back(json::parse(line));
    }
    REQUIRE(rows.size() == 1);
    CHECK(rows[0]["node_id"] == "eval");
    CHECK(rows[0]["site_id"] == "site-1");
    CHECK(rows[0]["emitter_id"] == "uav-1");
    CHECK(rows[0]["label"] == "cw_beacon");
    CHECK(rows[0]["waveform"] == "tone");
    CHECK(rows[0]["in_band"] == true);
    CHECK(rows[0]["t_s"].get<double>() == 3.0);
    CHECK(rows[0]["t_end_s"].get<double>() == 6.0);
    CHECK(rows[0]["bw_Hz"].get<double>() == 400000.0);

    // metrics.json：一节、绑 site-1；帧级 Pd 高、Pfa 低；唯一一段匹配上且识别对。
    // G-6（D-069）之后开关边沿落在精确样点上，开机那几帧不再漏检，故 fn 与发现时延都收到 0。
    json m = json::parse(read_file(out + "/metrics.json"));
    CHECK(m["schema_version"] == "cuav-metrics/1");
    CHECK(m["task_id"] == "run_evaluate_scene");
    CHECK(m["localization"].is_null());
    REQUIRE(m["sites"].size() == 1);
    const json& s = m["sites"][0];
    CHECK(s["node_id"] == "eval");
    CHECK(s["site_id"] == "site-1");
    CHECK(s["truth_source"] == "scenario");
    CHECK(s["state"] == "valid");
    CHECK(s["frames"]["total"].get<int>() == 2929);
    CHECK(s["frames"]["pd"].get<double>() >= 0.98);
    CHECK(s["frames"]["pfa"].get<double>() <= 0.01);
    CHECK(s["frames"]["fn"].get<int>() == 0);                  // G-6 之前是 7：源按块起点门控，3.0 → 3.0147 s
    CHECK(s["segments"]["truth"].get<int>() == 1);
    CHECK(s["segments"]["matched"].get<int>() == 1);
    CHECK(s["segments"]["detect_delay_s"]["max"].get<double>() == 0.0);   // G-6 之前是一块（≤ 0.14 s）
    CHECK(s["recognition"]["state"] == "valid");
    CHECK(s["recognition"]["evaluated"].get<int>() == 1);       // 识别器在 flush 里才出的那一行到了（步骤 0）
    CHECK(s["recognition"]["accuracy"].get<double>() == 1.0);
    CHECK(s["roc"]["points"].size() == 32);
    CHECK(s["roc"]["working_point"]["pd"] == s["frames"]["pd"]);
    CHECK(s["detector"]["frame_dt_s"].get<double>() == 1024.0 / 500000.0);
    CHECK(s["quality"]["noise_stale_frames"].is_null());
    CHECK(s["trace"]["model_id"] == "eval-baseline");
    CHECK(s["trace"]["truth_consumed"] == true);

    // 结束事件带 truth_rows 与 evaluations；不发 truth / evaluation 事件
    const json* last_state = nullptr;
    for (const auto& e : r.events) if (e["type"] == "task.state") last_state = &e;
    REQUIRE(last_state);
    CHECK((*last_state)["payload"]["truth_rows"] == 1);
    CHECK((*last_state)["payload"]["evaluations"] == 1);
    CHECK(count_type(r, "truth") == 0);
}

TEST_CASE("cuav_run --run：truth_source = none 的评价器——没有 truth.jsonl，metrics.json 一节 not_applicable 但计数照给（C-5）") {
    const std::string out = temp_root() + "/run_evaluate_none";
    Result r = run_cli({"--run", evaluate_fixture(), "--out", out, "--library-root", library_root()});
    REQUIRE_MESSAGE(r.code == ExitOk, r.diag);
    CHECK(read_file(out + "/truth.jsonl").empty());
    json m = json::parse(read_file(out + "/metrics.json"));
    REQUIRE(m["sites"].size() == 1);
    const json& s = m["sites"][0];
    CHECK(s["site_id"].is_null());
    CHECK(s["state"] == "not_applicable");
    CHECK(s["frames"]["truth_on"].get<int>() == 0);
    CHECK(s["frames"]["pd"].is_null());
    CHECK(s["frames"]["total"].get<int>() > 0);
    CHECK(s["frames"]["fp"].get<int>() > 0);                  // 单音段的命中都算虚警：没有真值就是这样
    CHECK(s["recognition"]["state"] == "valid");
    CHECK(s["recognition"]["evaluated"].get<int>() == 0);
    CHECK(s["recognition"]["unmatched"].get<int>() > 0);
}
