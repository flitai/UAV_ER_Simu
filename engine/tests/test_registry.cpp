// 组件注册表、参数描述与目录导出的单元测试（06 备忘录 §9A B-1）。
//
// 守三件事：按名构造与直接构造等价；参数校验按描述执行且报错带参数名；
// describe() 与 configure() 的规则一致（默认值自洽、必填项一致）。
#include "doctest/doctest.h"

#include <map>
#include <set>
#include <string>

#include "cuav/catalog.h"
#include "cuav/graph.h"
#include "cuav/random.h"
#include "cuav/registry.h"
#include "cuav/components/processing.h"
#include "cuav/components/sources.h"

using namespace cuav;

namespace {

using Num = std::map<std::string, double>;
using Txt = std::map<std::string, std::string>;

// 每个组件一组能通过 configure() 的必填参数样本；描述里带默认值的参数不写，
// 这样同时验证「默认值自洽」。
Num required_sample(const std::string& type) {
    if (type == "ToneSource" || type == "NoiseSource") return {{"sample_rate_Hz", 1e6}, {"total_samples", 4096}};
    if (type == "EnergyDetector") return {{"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5}};
    return {};
}

}  // namespace

TEST_CASE("内置注册表列出八个组件，按名排序") {
    Registry r = builtin_registry();
    const std::vector<std::string> want = {"AddMixer", "DetectionSink", "EnergyDetector",
                                           "FileReplaySource", "NoiseSource", "ObservationTap", "SpectrumAnalyzer", "ToneSource"};
    CHECK(r.types() == want);
    for (const auto& t : want) CHECK(r.has(t));
}

TEST_CASE("按名构造得到同类型组件；未知类型报错带名字") {
    Registry r = builtin_registry();
    std::string err;
    auto c = r.create("ToneSource", err);
    REQUIRE(c);
    CHECK(c->type_name() == "ToneSource");
    CHECK(c->describe().type == "ToneSource");

    auto bad = r.create("NoSuchThing", err);
    CHECK(!bad);
    CHECK(err.find("NoSuchThing") != std::string::npos);

    std::string dup;
    CHECK(!r.add<ToneSource>(dup));
    CHECK(dup.find("ToneSource") != std::string::npos);
}

TEST_CASE("参数校验：未知参数、越界、缺必填、类型错位都被挡住且报错含参数名") {
    Registry r = builtin_registry();
    std::string err;

    // 未知参数
    CHECK(!r.create_configured("ToneSource",
          {{"sample_rate_Hz", 1e6}, {"total_samples", 100}, {"amplitud", 1.0}}, {}, err));
    CHECK(err.find("amplitud") != std::string::npos);

    // 越过下限（含端点）
    CHECK(!r.create_configured("ToneSource",
          {{"sample_rate_Hz", 1e6}, {"total_samples", 100}, {"amplitude", -1.0}}, {}, err));
    CHECK(err.find("amplitude") != std::string::npos);

    // 开区间上限
    CHECK(!r.create_configured("EnergyDetector",
          {{"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5}, {"pfa", 1.0}}, {}, err));
    CHECK(err.find("pfa") != std::string::npos);

    // 开区间下限：采样率 0 不合法
    CHECK(!r.create_configured("NoiseSource", {{"sample_rate_Hz", 0.0}, {"total_samples", 10}}, {}, err));
    CHECK(err.find("sample_rate_Hz") != std::string::npos);

    // 缺必填（数值）
    CHECK(!r.create_configured("NoiseSource", {{"sample_rate_Hz", 1e6}}, {}, err));
    CHECK(err.find("total_samples") != std::string::npos);

    // 缺必填（文本）：用户侧必填的是 data_id，不是路径
    CHECK(!r.create_configured("FileReplaySource", {}, {}, err));
    CHECK(err.find("data_id") != std::string::npos);

    // 只给 data_id 不给内部参数：configure 报的是「应由装载器注入」而不是让用户填路径
    CHECK(!r.create_configured("FileReplaySource", {}, {{"data_id", "dronerfb_0_CH0_S4"}}, err));
    CHECK(err.find("manifest_path") != std::string::npos);
    CHECK(err.find("data_id") != std::string::npos);

    // 类型错位：文本参数按数值给
    CHECK(!r.create_configured("FileReplaySource", {{"manifest_path", 1.0}}, {}, err));
    CHECK(err.find("manifest_path") != std::string::npos);

    // 跨参数约束仍由 configure() 把关：频偏超奈奎斯特
    CHECK(!r.create_configured("ToneSource",
          {{"sample_rate_Hz", 1e6}, {"total_samples", 100}, {"offset_Hz", 6e5}}, {}, err));
    CHECK(err.find("奈奎斯特") != std::string::npos);
}

TEST_CASE("describe() 与 configure() 一致：只给必填项即可构造，必填项与 configure 的要求相同") {
    Registry r = builtin_registry();
    for (const std::string& type : r.types()) {
        if (type == "FileReplaySource" || type == "ObservationTap") continue;   // 必填含文件路径或产品目录，另有夹具测试
        std::string err;
        ComponentInfo info;
        REQUIRE(r.describe(type, info, err));
        const Num sample = required_sample(type);

        // 只给必填：能过
        auto c = r.create_configured(type, sample, {}, err);
        CHECK_MESSAGE(c, type << ": " << err);

        // 去掉任一必填：描述说必填，configure 也必须拒绝（两道闸一致）
        for (const auto& p : info.params) {
            if (!p.required) continue;
            Num less = sample;
            less.erase(p.name);
            auto d = r.create(type, err);
            REQUIRE(d);
            std::string e2;
            CHECK_MESSAGE(!d->configure(less, {}, e2), type << " 缺 " << p.name << " 却通过了 configure");
            CHECK(e2.find(p.name) != std::string::npos);
        }

        // 描述里的默认值必须在自己的范围内
        for (const auto& p : info.params) {
            if (!p.has_default || p.type != ParamType::Number) continue;
            Num one = sample;
            one[p.name] = p.default_number;
            CHECK_MESSAGE(validate_params(info, one, {}, err), type << "." << p.name << " 默认值越界：" << err);
        }
    }
}

TEST_CASE("目录导出：六类、端口兼容矩阵全枚举、D-013 规则、确定性") {
    Registry r = builtin_registry();
    nlohmann::json j = catalog_json(r);
    CHECK(j["schema_version"] == "cuav-catalog/1");
    CHECK(j["engine_version"] == std::string(engine_version()));
    CHECK(j["port_types"].size() == 6);
    CHECK(j["port_compat"].size() == 36);

    int ok_count = 0;
    for (const auto& row : j["port_compat"]) {
        const bool ok = row[2].get<bool>();
        if (ok) ++ok_count;
        if (row[0] == "IQStream" && row[1] == "SceneParamFrame") CHECK(!ok);
        if (row[0] == "IQStream" && row[1] == "ChannelPathSet") CHECK(!ok);
        if (row[0] == row[1]) CHECK(ok);
        if (!ok) CHECK(row.size() == 4);   // 拒绝理由随行
    }
    CHECK(ok_count == 6);

    CHECK(j["components"].size() == 8);
    const std::set<std::string> types = {"number", "string", "enum", "bool"};
    const std::set<std::string> cats = {"source", "channel", "antenna", "receiver", "data", "algorithm"};
    std::string prev;
    for (const auto& c : j["components"]) {
        const std::string type = c["type"].get<std::string>();
        CHECK(type > prev);   // 按类型名排序
        prev = type;
        CHECK(cats.count(c["category"].get<std::string>()) == 1);
        for (const auto& p : c["params"]) {
            CHECK(types.count(p["type"].get<std::string>()) == 1);
            CHECK(p.contains("unit"));
            CHECK(p.contains("required"));
        }
        if (type == "FileReplaySource") {
            CHECK(c["scene_bindable"] == false);
            bool saw_data_id = false, saw_internal_path = false;
            for (const auto& p : c["params"]) {
                if (p["name"] == "data_id") { saw_data_id = true; CHECK(p["required"] == true); CHECK(!p.contains("internal")); }
                if (p["name"] == "manifest_path") { saw_internal_path = true; CHECK(p["internal"] == true); CHECK(p["required"] == false); }
            }
            CHECK(saw_data_id);
            CHECK(saw_internal_path);   // 内部参数进目录但标 internal，画布据此隐藏、装载器据此拒绝
        }
        if (type == "EnergyDetector") CHECK(c["ports"]["out"][0]["type"] == "DetectionList");
    }

    // 两次导出逐字节相同
    CHECK(catalog_json(r).dump() == j.dump());
}

TEST_CASE("目录条目自检：类别不在六类、Coder 产物缺 source_ref 都被拒") {
    ComponentInfo bad;
    bad.type = "X";
    bad.category = "misc";
    bad.model_layer = "M3"; bad.model_level = "E1"; bad.version = "0.0.1"; bad.display_name = "x";
    std::string err;
    CHECK(!validate_catalog_entry(bad, err));
    CHECK(err.find("类别") != std::string::npos);

    bad.category = category::Channel;
    bad.implementation = "coder";
    CHECK(!validate_catalog_entry(bad, err));
    CHECK(err.find("source_ref") != std::string::npos);

    bad.source_ref = "matlab/ref/x.m@R2025a";
    bad.params = {ParamSpec::number("a", "", "").req().def(1.0)};
    CHECK(!validate_catalog_entry(bad, err));
    CHECK(err.find("既必填又带默认值") != std::string::npos);

    bad.params = {ParamSpec::number("a", "", "").def(1.0)};
    CHECK(validate_catalog_entry(bad, err));
}

TEST_CASE("经注册表构造的处理链与直接构造等价：单音加噪声到能量检测跑通") {
    Registry r = builtin_registry();
    std::string err;
    const double fs = 1e6;
    const double total = 256.0 * 400;
    auto tone = r.create_configured("ToneSource",
        {{"sample_rate_Hz", fs}, {"total_samples", total}, {"offset_Hz", 1e4}, {"amplitude", 2.0},
         {"start_sample", 256.0 * 200}, {"block_samples", 4096}}, {}, err);
    REQUIRE_MESSAGE(tone, err);
    auto noise = r.create_configured("NoiseSource",
        {{"sample_rate_Hz", fs}, {"total_samples", total}, {"power", 1.0}, {"block_samples", 4096}}, {}, err);
    REQUIRE_MESSAGE(noise, err);
    auto mix = r.create_configured("AddMixer", {}, {}, err);
    REQUIRE_MESSAGE(mix, err);
    auto det = r.create_configured("EnergyDetector",
        {{"nfft", 256}, {"band_lo_Hz", -5e4}, {"band_hi_Hz", 5e4}, {"pfa", 1e-3}, {"noise_frames", 100}}, {}, err);
    REQUIRE_MESSAGE(det, err);
    auto sink_c = r.create_configured("DetectionSink", {}, {}, err);
    REQUIRE_MESSAGE(sink_c, err);
    auto* sink = dynamic_cast<DetectionSink*>(sink_c.get());
    REQUIRE(sink);

    Graph g;
    const NodeId a = g.add(std::move(tone), "tone");
    const NodeId b = g.add(std::move(noise), "noise");
    const NodeId m = g.add(std::move(mix), "mix");
    const NodeId d = g.add(std::move(det), "det");
    const NodeId s = g.add(std::move(sink_c), "sink");
    REQUIRE(g.connect(a, "out", m, "a", err));
    REQUIRE(g.connect(b, "out", m, "b", err));
    REQUIRE(g.connect(m, "out", d, "in", err));
    REQUIRE(g.connect(d, "out", s, "in", err));
    REQUIRE(g.validate(err));

    Xoshiro256pp rng(20260904ull);
    RunReport rep = g.run(rng);
    CHECK_MESSAGE(rep.ok, rep.error);
    CHECK(sink->frames() > 0);
    // 后半段有强单音，检出率必然远高于虚警率
    CHECK(sink->hit_rate() > 0.3);
}
