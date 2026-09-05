// 框图 JSON 装载器（B-2）：示例框图装载并运行、只校验模式、D-013 与 D-037 拒绝、未知键、
// 观测点并联、数据解析器、结构错误的定位。规范 docs/diagram-format.md。
#include "doctest/doctest.h"

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

#include "cuav/components/tap.h"
#include "cuav/diagram_json.h"
#include "cuav/platform.h"
#include "cuav/random.h"
#include "cuav/registry.h"

using namespace cuav;
using nlohmann::json;

namespace {

std::string temp_root() {
    const char* t = std::getenv("TMPDIR");
    std::string d = t ? t : "/tmp/";
    if (!d.empty() && d[d.size() - 1] != '/') d += '/';
    return d + "cuav_diagram_test";
}

json read_json(const std::string& p) {
    std::ifstream f(p.c_str());
    REQUIRE_MESSAGE(f.good(), "打不开 " << p);
    json j;
    f >> j;
    return j;
}

// 切片 ① 的示例框图，逐字取自 docs/diagram-format.md §8
json slice1() {
    return read_json(std::string(CUAV_SOURCE_DIR) + "/tests/diagrams/slice1_tone_noise_psd.json");
}

// 测试专用组件：带 SceneParamFrame 输入口，用来触发 D-013 拒连（首批组件里还没有施加类组件）
struct FakeApplier : IComponent {
    std::string type_name() const override { return "FakeApplier"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::SceneParamFrame}}; }
    std::vector<PortSpec> outputs() const override { return {}; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { return true; }
    Step process(PortMap&, PortMap&, std::string&) override { return Step::Finished; }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

// 测试专用组件：目录里 scene_bindable = true，用来走 scene_binding 的两条分支
struct FakeBindable : IComponent {
    std::string type_name() const override { return "FakeBindable"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    ComponentInfo describe() const override {
        ComponentInfo i = IComponent::describe();
        i.scene_bindable = true;
        return i;
    }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { return true; }
    Step process(PortMap&, PortMap&, std::string&) override { return Step::Finished; }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

Registry test_registry() {
    Registry r = builtin_registry();
    std::string e;
    REQUIRE_MESSAGE(r.add<FakeApplier>(e), e);
    REQUIRE_MESSAGE(r.add<FakeBindable>(e), e);
    return r;
}

bool try_load(const json& j, LoadedDiagram& d, DiagramError& e, IDataResolver* res = nullptr,
              const std::string& out_dir = "") {
    Registry r = test_registry();
    LoadOptions o;
    o.out_dir = out_dir;
    return load_diagram(j, r, res, o, d, e);
}

DiagramError expect_fail(const json& j, const char* code, IDataResolver* res = nullptr) {
    LoadedDiagram d;
    DiagramError e;
    const bool ok = try_load(j, d, e, res);
    CHECK_MESSAGE(!ok, "本应失败的框图装载成功了");
    CHECK_MESSAGE(e.code == code, "错误码 " << e.code << " ≠ " << code << "：" << e.message);
    return e;
}

json node(const std::string& id, const std::string& type, const json& params) {
    return json{{"id", id}, {"type", type}, {"params", params}};
}

json edge(const std::string& id, const std::string& fn, const std::string& fp, const std::string& tn, const std::string& tp) {
    return json{{"id", id}, {"from", {{"node", fn}, {"port", fp}}}, {"to", {{"node", tn}, {"port", tp}}}};
}

bool contains(const std::string& s, const std::string& sub) { return s.find(sub) != std::string::npos; }

// 最小合规的 .iq 加旁挂清单（docs/iq-format.md 第 3、4 节），与 test_components.cpp 的夹具同构
void write_replay_fixture(const std::string& dir, const std::string& stem, std::size_t samples, double fs, double fc) {
    std::vector<std::int16_t> v(samples * 2);
    for (std::size_t i = 0; i < v.size(); ++i) v[i] = static_cast<std::int16_t>((i * 37) % 2000 - 1000);
    std::ofstream f((dir + "/" + stem + ".iq").c_str(), std::ios::binary);
    f.write(reinterpret_cast<const char*>(v.data()), static_cast<std::streamsize>(v.size() * 2));
    f.close();
    std::ofstream m((dir + "/" + stem + ".manifest.json").c_str());
    m << "{\n"
      << "  \"manifest_version\": \"1.0\",\n"
      << "  \"observation_point\": \"S4\",\n"
      << "  \"sampling\": {\"sample_format\": \"ci16_le\", \"byte_order\": \"little\",\n"
      << "    \"iq_layout\": \"interleaved_IQ\", \"internal_format\": \"cf32\",\n"
      << "    \"sample_rate_Hz\": " << fs << ", \"sample_count\": " << samples << "},\n"
      << "  \"frequency\": {\"center_frequency_Hz\": " << fc << ", \"effective_bandwidth_Hz\": " << fs << "},\n"
      << "  \"power\": {\"full_scale\": 32768, \"scale\": null},\n"
      << "  \"quality\": {\"status\": \"degraded\", \"reasons\": [\"测试夹具\"]},\n"
      << "  \"segments\": []\n"
      << "}\n";
}

struct RowCounter : IRunObserver {
    std::uint64_t rows = 0;
    void on_product_row(const std::string&, const std::string&, std::uint64_t, const float*, std::size_t, double) override { ++rows; }
};

// 回放框图：replay → psd，观测点挂 replay.out
json replay_diagram() {
    json j = slice1();
    j["nodes"] = json::array({
        node("replay", "FileReplaySource", {{"data_id", "fx_replay_1"}, {"block_samples", 1000}}),
        node("psd", "SpectrumAnalyzer", {{"nfft", 256}}),
    });
    j["edges"] = json::array({edge("e1", "replay", "out", "psd", "in")});
    j["observation_points"][0]["node"] = "replay";
    return j;
}

}  // namespace

TEST_CASE("装载器：示例框图装成 Graph 并运行到底，total_samples 由时长补齐，观测点写出产品") {
    const std::string out = temp_root() + "/slice1";
    std::string err;
    REQUIRE(platform::make_dirs(out, err));
    LoadedDiagram d;
    DiagramError e;
    REQUIRE_MESSAGE(try_load(slice1(), d, e, nullptr, out), e.message);
    CHECK(d.diagram_id == "slice1-tone-noise-psd");
    CHECK(d.name == "单音加噪声到功率谱");
    CHECK(d.run.seed == 20260904u);
    CHECK(d.run.duration_s == 2.0);
    CHECK(d.run.block_size == 0u);
    CHECK(d.run.max_rounds == 0u);
    CHECK(!d.has_scenario_ref);
    CHECK(d.node_ids.size() == 4);
    REQUIRE(d.taps.size() == 1);
    CHECK(d.taps[0].op_id == "s4");
    CHECK(d.taps[0].node == "mix");
    CHECK(d.graph.size() == 5);                        // 四个用户节点 + 一个并联的观测点
    CHECK(d.node_names[d.taps[0].tap_node] == "op:s4");

    RowCounter obs;
    Xoshiro256pp rng(d.run.seed);
    RunReport rep = d.graph.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    // duration_s 2.0 × 1 MS/s = 2 000 000 样点：示例框图没写 total_samples，由装载器补
    CHECK(rep.node_status[d.node_ids["tone"]].samples_out == 2000000u);
    CHECK(rep.node_status[d.node_ids["noise"]].samples_out == 2000000u);
    CHECK(rep.node_status[d.node_ids["psd"]].blocks_out > 0);
    auto* tap = dynamic_cast<ObservationTap*>(d.graph.node(d.taps[0].tap_node));
    REQUIRE(tap);
    CHECK(tap->spectrum_rows() == 2000000u / 1024u);   // 1953 个满段，尾巴 448 样点丢弃并记备注
    CHECK(tap->envelope_rows() == 489u);               // 488 满桶 + 1 末桶（4096 样点一桶）
    CHECK(obs.rows == tap->spectrum_rows() + tap->envelope_rows());
    auto idx = read_json(out + "/s4/spectrum.index.json");
    CHECK(idx["rows"] == 1953);
    CHECK(idx["op_id"] == "s4");
    CHECK(idx["trace"]["model_id"] == "AddMixer");
}

TEST_CASE("装载器：只校验模式不给 out_dir，观测点照常构造，运行时才在 init 被拒，盘上不留东西") {
    LoadedDiagram d;
    DiagramError e;
    REQUIRE_MESSAGE(try_load(slice1(), d, e), e.message);
    REQUIRE(d.taps.size() == 1);
    Xoshiro256pp rng(1);
    RunReport rep = d.graph.run(rng);
    CHECK(!rep.ok);
    CHECK(contains(rep.error, "out_dir"));
    CHECK(contains(rep.error, "op:s4"));
}

TEST_CASE("装载器：run 段的可选项与 block_size 注入未写块长的节点") {
    json j = slice1();
    j["run"]["block_size"] = 4096;
    j["run"]["max_rounds"] = 100000;
    j.erase("observation_points");
    LoadedDiagram d;
    DiagramError e;
    REQUIRE_MESSAGE(try_load(j, d, e), e.message);
    CHECK(d.run.block_size == 4096u);
    CHECK(d.run.max_rounds == 100000u);
    Xoshiro256pp rng(3);
    RunReport rep = d.graph.run(rng, d.run.max_rounds);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    CHECK(rep.node_status[d.node_ids["tone"]].blocks_out == 489u);   // ceil(2e6 / 4096)
}

TEST_CASE("装载器：D-013 IQStream 直连 SceneParamFrame 被拒，报节点与端口；跨类型连线同样被拒") {
    json j = slice1();
    j["nodes"].push_back(node("applier", "FakeApplier", json::object()));
    j["edges"].push_back(edge("e4", "tone", "out", "applier", "in"));
    DiagramError e = expect_fail(j, "port_incompatible");
    CHECK(e.node_id == "tone");
    CHECK(e.port == "out");
    CHECK(contains(e.message, "IQStream"));
    CHECK(contains(e.message, "SceneParamFrame"));
    CHECK(contains(e.message, "applier.in"));

    j = slice1();
    j["nodes"].push_back(node("det", "EnergyDetector", {{"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5}}));
    j["edges"].push_back(edge("e4", "psd", "out", "det", "in"));
    e = expect_fail(j, "port_incompatible");
    CHECK(e.node_id == "psd");
    CHECK(e.port == "out");
    CHECK(contains(e.message, "SpectrumFrame"));
}

TEST_CASE("装载器：未知键在顶层、节点、连线、观测点、run 五处都被拒并点名；未知参数带节点 id") {
    json j = slice1();
    j["foo"] = 1;
    CHECK(contains(expect_fail(j, "schema").message, "foo"));

    j = slice1();
    j["nodes"][0]["colour"] = "red";
    DiagramError e = expect_fail(j, "schema");
    CHECK(e.node_id == "tone");
    CHECK(contains(e.message, "colour"));

    j = slice1();
    j["edges"][0]["weight"] = 1;
    CHECK(contains(expect_fail(j, "schema").message, "weight"));

    j = slice1();
    j["observation_points"][0]["kind"] = "x";
    e = expect_fail(j, "schema");
    CHECK(e.node_id == "s4");
    CHECK(contains(e.message, "kind"));

    j = slice1();
    j["run"]["speed"] = 1;
    CHECK(contains(expect_fail(j, "schema").message, "speed"));

    j = slice1();
    j["nodes"][0]["params"]["amplitud"] = 1;
    e = expect_fail(j, "param");
    CHECK(e.node_id == "tone");
    CHECK(contains(e.message, "amplitud"));
}

TEST_CASE("装载器：D-037 内部参数出现在框图里即拒，节点与观测点两处") {
    json j = slice1();
    j["nodes"].push_back(node("replay", "FileReplaySource",
                              {{"data_id", "dronerfb_0_CH0_S4"}, {"manifest_path", "/srv/x.manifest.json"}}));
    DiagramError e = expect_fail(j, "internal_param");
    CHECK(e.node_id == "replay");
    CHECK(contains(e.message, "manifest_path"));

    j = slice1();
    j["observation_points"][0]["params"] = {{"out_dir", "/srv/runs/x"}};
    e = expect_fail(j, "internal_param");
    CHECK(e.node_id == "s4");
    CHECK(contains(e.message, "out_dir"));
}

TEST_CASE("装载器：data_id 经解析器换成 manifest_path 注入；无解析器或解析不到都报 data_id") {
    const std::string dir = temp_root() + "/replay";
    std::string err;
    REQUIRE(platform::make_dirs(dir + "/out", err));
    write_replay_fixture(dir, "fx_replay_1", 5000, 1e6, 2.44e9);
    const std::string manifest = dir + "/fx_replay_1.manifest.json";

    MapDataResolver m;
    m.set("fx_replay_1", manifest);
    LoadedDiagram d;
    DiagramError e;
    REQUIRE_MESSAGE(try_load(replay_diagram(), d, e, &m, dir + "/out"), e.message);
    Xoshiro256pp rng(5);
    RunReport rep = d.graph.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    CHECK(rep.node_status[d.node_ids["replay"]].samples_out == 5000u);
    auto idx = read_json(dir + "/out/s4/spectrum.index.json");
    CHECK(idx["trace"]["trace_id"] == "FileReplaySource:fx_replay_1");   // data_id 进溯源
    CHECK(idx["rows"] == 5000 / 1024);

    MapDataResolver empty;
    e = expect_fail(replay_diagram(), "data_id", &empty);
    CHECK(e.node_id == "replay");
    CHECK(contains(e.message, "fx_replay_1"));

    e = expect_fail(replay_diagram(), "data_id", nullptr);
    CHECK(e.node_id == "replay");
    CHECK(contains(e.message, "解析器"));

    // 解析到了但清单打不开：仍归 data_id，便于定位到数据
    MapDataResolver bad;
    bad.set("fx_replay_1", dir + "/nowhere.manifest.json");
    e = expect_fail(replay_diagram(), "data_id", &bad);
    CHECK(e.node_id == "replay");
}

TEST_CASE("解析器：IndexDataResolver 按索引所在目录定位旁挂清单并核对存在；MapDataResolver 读解析旁挂") {
    const std::string dir = temp_root() + "/index";
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    write_replay_fixture(dir, "fx_a", 100, 1e6, 0.0);
    {
        std::ofstream f((dir + "/index.manifest.json").c_str());
        f << "{\"schema\": \"cuav-batch-index/1\", \"directory\": \"data/iq/measured/fx\", "
             "\"products\": [{\"data_id\": \"fx_a\"}, {\"data_id\": \"fx_missing\"}]}\n";
    }
    IndexDataResolver ix;
    REQUIRE_MESSAGE(ix.add_index(dir + "/index.manifest.json", err), err);
    CHECK(ix.size() == 2);
    std::string p;
    CHECK(ix.resolve("fx_a", p, err));
    CHECK(p == dir + "/fx_a.manifest.json");
    CHECK(!ix.resolve("fx_missing", p, err));       // 索引里有、盘上没有
    CHECK(contains(err, "fx_missing"));
    CHECK(!ix.resolve("nope", p, err));
    // 同一 data_id 在第二份索引里指向别处 → 拒
    {
        std::string err2;
        REQUIRE(platform::make_dirs(dir + "/other", err2));
        std::ofstream f((dir + "/other/index.manifest.json").c_str());
        f << "{\"schema\": \"cuav-batch-index/1\", \"products\": [{\"data_id\": \"fx_a\"}]}\n";
    }
    CHECK(!ix.add_index(dir + "/other/index.manifest.json", err));
    CHECK(contains(err, "fx_a"));
    // schema 不对
    {
        std::ofstream f((dir + "/bad.json").c_str());
        f << "{\"schema\": \"something-else/1\", \"products\": []}\n";
    }
    CHECK(!ix.add_index(dir + "/bad.json", err));

    json resolved = {{"schema_version", "cuav-resolved/1"},
                     {"diagram_sha256", std::string(64, 'a')},
                     {"data", {{"fx_a", dir + "/fx_a.manifest.json"}}}};
    MapDataResolver m;
    REQUIRE_MESSAGE(m.load(resolved, err), err);
    CHECK(m.size() == 1);
    CHECK(m.resolve("fx_a", p, err));
    CHECK(p == dir + "/fx_a.manifest.json");
    resolved["schema_version"] = "cuav-diagram/1";
    CHECK(!m.load(resolved, err));
    {
        std::ofstream f((dir + "/resolved.json").c_str());
        f << "{\"schema_version\": \"cuav-resolved/1\", \"data\": {\"fx_b\": \"" << dir << "/fx_b.manifest.json\"}}\n";
    }
    MapDataResolver m2;
    REQUIRE_MESSAGE(m2.load_file(dir + "/resolved.json", err), err);
    CHECK(m2.resolve("fx_b", p, err));
    CHECK(!m2.load_file(dir + "/does-not-exist.json", err));
}

TEST_CASE("装载器：观测点只能挂 IQStream 输出口；iq 产品本版本拒绝；观测点参数错误带观测点 id") {
    json j = slice1();
    j["observation_points"][0]["node"] = "psd";
    DiagramError e = expect_fail(j, "observation_port");
    CHECK(e.node_id == "psd");
    CHECK(e.port == "out");
    CHECK(contains(e.message, "SpectrumFrame"));

    j = slice1();
    j["observation_points"][0]["port"] = "a";
    e = expect_fail(j, "observation_port");
    CHECK(e.node_id == "mix");
    CHECK(e.port == "a");

    j = slice1();
    j["observation_points"][0]["node"] = "ghost";
    e = expect_fail(j, "node_missing");
    CHECK(e.node_id == "ghost");

    j = slice1();
    j["observation_points"][0]["products"] = json::array({"spectrum", "iq"});
    e = expect_fail(j, "product_unsupported");
    CHECK(e.node_id == "s4");

    j = slice1();
    j["observation_points"][0]["products"] = json::array();
    expect_fail(j, "schema");
    j["observation_points"][0]["products"] = json::array({"spectrum", "spectrum"});
    expect_fail(j, "schema");
    j["observation_points"][0]["products"] = json::array({"psd"});
    expect_fail(j, "schema");

    j = slice1();
    j["observation_points"][0]["params"] = {{"nfft", 1000}};
    e = expect_fail(j, "param");
    CHECK(e.node_id == "s4");
    CHECK(contains(e.message, "nfft"));

    j = slice1();
    j["observation_points"][0]["params"] = {{"op_id", "other"}};
    e = expect_fail(j, "schema");
    CHECK(e.node_id == "s4");

    // 只写 envelope：spectrum 关掉，产品目录里只有包络
    j = slice1();
    j["observation_points"][0]["products"] = json::array({"envelope"});
    j["observation_points"][0]["params"] = {{"bucket_samples", 100000}};
    const std::string out = temp_root() + "/env_only";
    std::string err;
    REQUIRE(platform::make_dirs(out, err));
    LoadedDiagram d;
    REQUIRE_MESSAGE(try_load(j, d, e, nullptr, out), e.message);
    Xoshiro256pp rng(9);
    RunReport rep = d.graph.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    auto* tap = dynamic_cast<ObservationTap*>(d.graph.node(d.taps[0].tap_node));
    REQUIRE(tap);
    CHECK(tap->spectrum_rows() == 0u);
    CHECK(tap->envelope_rows() == 20u);
    CHECK(!std::ifstream((out + "/s4/spectrum.f32").c_str()).good());
}

TEST_CASE("装载器：结构错误——悬空输入口、环、自环、重复 id、缺节点、缺端口、输入口重复、超时长、未知类型") {
    json j = slice1();
    j["edges"].erase(1);                                 // 去掉 noise → mix.b
    DiagramError e = expect_fail(j, "input_unconnected");
    CHECK(e.node_id == "mix");
    CHECK(e.port == "b");

    j = slice1();
    j["nodes"] = json::array({
        node("tone", "ToneSource", {{"sample_rate_Hz", 1e6}}),
        node("noise", "NoiseSource", {{"sample_rate_Hz", 1e6}}),
        node("mix1", "AddMixer", json::object()),
        node("mix2", "AddMixer", json::object()),
    });
    j["edges"] = json::array({
        edge("e1", "tone", "out", "mix1", "a"),
        edge("e2", "mix1", "out", "mix2", "a"),
        edge("e3", "noise", "out", "mix2", "b"),
        edge("e4", "mix2", "out", "mix1", "b"),
    });
    j.erase("observation_points");
    e = expect_fail(j, "cycle");
    CHECK(contains(e.message, "环"));

    j = slice1();
    j["edges"].push_back(edge("e4", "noise", "out", "mix", "a"));   // mix.a 已被 e1 占用
    e = expect_fail(j, "input_occupied");
    CHECK(e.node_id == "mix");
    CHECK(e.port == "a");

    j = slice1();
    j["edges"].push_back(edge("e4", "mix", "out", "mix", "a"));     // 自环先于占用被拒
    e = expect_fail(j, "cycle");
    CHECK(e.node_id == "mix");
    CHECK(e.port == "out");

    j = slice1();
    j["nodes"].push_back(node("tone", "ToneSource", {{"sample_rate_Hz", 1e6}}));
    e = expect_fail(j, "schema");
    CHECK(contains(e.message, "重复"));

    j = slice1();
    j["edges"].push_back(edge("e4", "ghost", "out", "psd", "in"));
    e = expect_fail(j, "node_missing");
    CHECK(e.node_id == "ghost");
    CHECK(e.port == "out");

    j = slice1();
    j["edges"][0] = edge("e1", "tone", "nope", "mix", "a");
    e = expect_fail(j, "port_missing");
    CHECK(e.node_id == "tone");
    CHECK(e.port == "nope");

    j = slice1();
    j["edges"][0] = edge("e1", "tone", "out", "mix", "c");
    e = expect_fail(j, "port_missing");
    CHECK(e.node_id == "mix");
    CHECK(e.port == "c");

    j = slice1();
    j["nodes"][0]["params"]["total_samples"] = 3e6;      // 超过 2 s × 1 MS/s
    e = expect_fail(j, "duration");
    CHECK(e.node_id == "tone");
    CHECK(contains(e.message, "2000000"));
    j["nodes"][0]["params"]["total_samples"] = 1.5e6;    // 不超过：显式值生效
    LoadedDiagram d;
    REQUIRE_MESSAGE(try_load(j, d, e), e.message);

    j = slice1();
    j["nodes"][0]["type"] = "LaserSource";
    e = expect_fail(j, "unknown_type");
    CHECK(e.node_id == "tone");
    CHECK(contains(e.message, "LaserSource"));

    j = slice1();
    j["nodes"][0]["params"]["amplitude"] = -1;           // 越过目录下限，由 validate_params 报
    e = expect_fail(j, "param");
    CHECK(e.node_id == "tone");
    CHECK(contains(e.message, "amplitude"));

    j = slice1();
    j["nodes"][3]["params"]["window"] = 3;               // 枚举给了数值
    e = expect_fail(j, "param");
    CHECK(e.node_id == "psd");
    CHECK(contains(e.message, "window"));
}

TEST_CASE("装载器：顶层与 run 段的基本约束") {
    json j = slice1();
    j["schema_version"] = "cuav-diagram/2";
    CHECK(contains(expect_fail(j, "schema").message, "cuav-diagram/1"));

    j = slice1();
    j["nodes"] = json::array();
    expect_fail(j, "schema");

    j = slice1();
    j["run"]["time_basis"] = "Wall";
    CHECK(contains(expect_fail(j, "schema").message, "LogicalSim"));

    j = slice1();
    j["run"]["seed"] = -1;
    expect_fail(j, "schema");
    j["run"]["seed"] = 1.5;
    expect_fail(j, "schema");

    j = slice1();
    j["run"]["duration_s"] = 0;
    expect_fail(j, "schema");

    j = slice1();
    j["nodes"][0]["params"]["amplitude"] = json::array({1, 2});
    DiagramError e = expect_fail(j, "schema");
    CHECK(e.node_id == "tone");

    j = slice1();
    j["diagram_id"] = "Has Space";
    expect_fail(j, "schema");

    j = slice1();
    j["scenario_ref"] = {{"scenario_id", "demo"}, {"sha256", "abc"}};
    expect_fail(j, "schema");

    j = slice1();
    j["trace"] = {{"created_by", "tester"}, {"notes", "x"}};
    LoadedDiagram d;
    REQUIRE_MESSAGE(try_load(j, d, e), e.message);
    CHECK(d.trace["created_by"] == "tester");
}

TEST_CASE("装载器：scene_binding 只允许目录可绑定的组件，且须有 scenario_ref") {
    json j = slice1();
    j["nodes"][0]["scene_binding"] = {{"scenario_id", "demo"}, {"entity_id", "uav1"}};
    DiagramError e = expect_fail(j, "scene_binding");
    CHECK(e.node_id == "tone");
    CHECK(contains(e.message, "scene_bindable"));

    j = slice1();
    j["nodes"].push_back(node("bound", "FakeBindable", json::object()));
    j["nodes"][4]["scene_binding"] = {{"scenario_id", "demo"}, {"entity_id", "uav1"}};
    e = expect_fail(j, "scene_binding");
    CHECK(e.node_id == "bound");
    CHECK(contains(e.message, "scenario_ref"));

    j["scenario_ref"] = {{"scenario_id", "demo"}, {"sha256", std::string(64, '0')}};
    LoadedDiagram d;
    REQUIRE_MESSAGE(try_load(j, d, e), e.message);
    CHECK(d.has_scenario_ref);
    CHECK(d.scenario_id == "demo");

    j["nodes"][4]["scene_binding"] = {{"scenario_id", "demo"}, {"entity_id", "uav1"}, {"site_id", "s1"}};
    expect_fail(j, "schema");
    j["nodes"][4]["scene_binding"] = {{"scenario_id", "demo"}};
    expect_fail(j, "schema");
}

TEST_CASE("装载器：错误报文四键；文件装载对缺失文件与非法 JSON 报 json_parse") {
    DiagramError e;
    e.code = "schema"; e.node_id = "n"; e.port = "p"; e.message = "m";
    json j = to_json(e);
    CHECK(j.size() == 4);
    CHECK(j["code"] == "schema");
    CHECK(j["node_id"] == "n");
    CHECK(j["port"] == "p");
    CHECK(j["message"] == "m");

    Registry r = builtin_registry();
    LoadOptions o;
    LoadedDiagram d;
    CHECK(!load_diagram_file(temp_root() + "/no-such-file.json", r, nullptr, o, d, e));
    CHECK(e.code == "json_parse");
    const std::string dir = temp_root() + "/bad";
    std::string err;
    REQUIRE(platform::make_dirs(dir, err));
    {
        std::ofstream f((dir + "/garbage.json").c_str());
        f << "{ not json";
    }
    CHECK(!load_diagram_file(dir + "/garbage.json", r, nullptr, o, d, e));
    CHECK(e.code == "json_parse");
    // 走文件路径装示例框图，与直接给 JSON 等价
    REQUIRE_MESSAGE(load_diagram_file(std::string(CUAV_SOURCE_DIR) + "/tests/diagrams/slice1_tone_noise_psd.json",
                                      r, nullptr, o, d, e), e.message);
    CHECK(d.graph.size() == 5);
}
