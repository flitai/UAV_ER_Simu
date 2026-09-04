// 类型语义与框图调度的单元测试。
#include "doctest/doctest.h"

#include "cuav/graph.h"
#include "cuav/components/processing.h"
#include "cuav/components/sources.h"

using namespace cuav;

TEST_CASE("四态取最差：not_applicable 不参与") {
    CHECK(worst(State::Valid, State::NotApplicable) == State::Valid);
    CHECK(worst(State::NotApplicable, State::Degraded) == State::Degraded);
    CHECK(worst(State::Valid, State::Degraded) == State::Degraded);
    CHECK(worst(State::Degraded, State::Invalid) == State::Invalid);
    CHECK(worst(State::NotApplicable, State::NotApplicable) == State::NotApplicable);
}

TEST_CASE("端口连线规则：IQ 流与参数流不得直连（D-013）") {
    CHECK(can_connect(PortType::IQStream, PortType::IQStream));
    CHECK_FALSE(can_connect(PortType::IQStream, PortType::SceneParamFrame));
    CHECK_FALSE(can_connect(PortType::SceneParamFrame, PortType::IQStream));
    CHECK_FALSE(can_connect(PortType::ChannelPathSet, PortType::IQStream));
    CHECK_FALSE(can_connect(PortType::IQStream, PortType::DetectionList));
}

TEST_CASE("溯源八件套不全就是不全") {
    ModelTrace t;
    CHECK_FALSE(t.complete());
    t.model_id = "a"; t.model_version = "b"; t.model_level = "E2";
    t.model_layer = "M3"; t.credibility = "V3"; t.parameter_version = "p";
    CHECK_FALSE(t.complete());
    t.trace_id = "x";
    CHECK(t.complete());
}

TEST_CASE("块元数据降级会累积理由，且不覆盖更差的状态") {
    BlockMeta m;
    m.degrade("甲");
    CHECK(m.state == State::Degraded);
    m.invalidate("乙");
    CHECK(m.state == State::Invalid);
    m.degrade("丙");
    CHECK(m.state == State::Invalid);          // 不得被降级“治好”
    CHECK(m.state_reasons.size() == 3u);
}

namespace {
std::unique_ptr<ToneSource> make_tone(std::size_t n, double fs, double off) {
    std::unique_ptr<ToneSource> s(new ToneSource());
    std::string err;
    std::map<std::string, double> p{{"sample_rate_Hz", fs},
                                    {"total_samples", static_cast<double>(n)},
                                    {"offset_Hz", off},
                                    {"block_samples", 4096.0}};
    REQUIRE(s->configure(p, {}, err));
    return s;
}
}  // namespace

TEST_CASE("连线校验：类型不匹配、端口不存在、输入口重复占用都要挡住") {
    Graph g;
    NodeId src = g.add(make_tone(4096, 1e6, 0.0), "tone");
    std::unique_ptr<EnergyDetector> det(new EnergyDetector());
    std::string err;
    std::map<std::string, double> dp{{"nfft", 256.0}, {"band_lo_Hz", -1e5},
                                     {"band_hi_Hz", 1e5}, {"noise_frames", 4.0}};
    REQUIRE(det->configure(dp, {}, err));
    NodeId d = g.add(std::move(det), "det");
    std::unique_ptr<DetectionSink> sink(new DetectionSink());
    NodeId k = g.add(std::move(sink), "sink");

    CHECK_FALSE(g.connect(src, "nope", d, "in", err));
    CHECK(err.find("没有输出口") != std::string::npos);
    CHECK_FALSE(g.connect(src, "out", d, "nope", err));
    CHECK_FALSE(g.connect(d, "out", d, "in", err));           // 自环
    CHECK(g.connect(src, "out", d, "in", err));
    CHECK_FALSE(g.connect(src, "out", d, "in", err));         // 输入口已占用
    CHECK(g.connect(d, "out", k, "in", err));
    CHECK(g.validate(err));
}

TEST_CASE("输入口没连线就不许跑") {
    Graph g;
    std::unique_ptr<EnergyDetector> det(new EnergyDetector());
    std::string err;
    std::map<std::string, double> dp{{"nfft", 256.0}, {"band_lo_Hz", -1e5},
                                     {"band_hi_Hz", 1e5}};
    REQUIRE(det->configure(dp, {}, err));
    g.add(std::move(det), "det");
    CHECK_FALSE(g.validate(err));
    CHECK(err.find("没有连线") != std::string::npos);
}

TEST_CASE("有环的框图必须报错") {
    Graph g;
    std::unique_ptr<AddMixer> m1(new AddMixer());
    std::unique_ptr<AddMixer> m2(new AddMixer());
    std::string err;
    NodeId a = g.add(std::move(m1), "m1");
    NodeId b = g.add(std::move(m2), "m2");
    REQUIRE(g.connect(a, "out", b, "a", err));
    REQUIRE(g.connect(b, "out", a, "a", err));
    CHECK_FALSE(g.validate(err));
    CHECK(err.find("环") != std::string::npos);
}
