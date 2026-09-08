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


// --------------------------------------------------------------- 可选输入口（D-051，C-1）

namespace {

// 一个必填输入口加一个可选输入口。process 记录本轮可选口有没有拿到数据，
// 用来验证「没连线时照跑、连了线时照收」两种情形都对。
struct OptionalInComponent : IComponent {
    mutable int rounds = 0;
    mutable int rounds_with_opt = 0;

    std::string type_name() const override { return "OptionalInComponent"; }
    std::vector<PortSpec> inputs() const override {
        PortSpec opt{"scene", PortType::SceneParamFrame};
        opt.optional = true;
        return {PortSpec{"in", PortType::IQStream}, opt};
    }
    std::vector<PortSpec> outputs() const override { return {}; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&,
                   std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { return true; }
    Step process(PortMap& in, PortMap&, std::string&) override {
        rounds++;
        auto it = in.find("scene");
        if (it != in.end() && it->second.has_data) rounds_with_opt++;
        return Step::Idle;
    }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

}  // namespace

TEST_CASE("可选输入口：没连线不算悬空，组件照常运行") {
    Graph g;
    std::unique_ptr<ToneSource> src(new ToneSource());
    std::string err;
    std::map<std::string, double> sp{{"sample_rate_Hz", 1e6}, {"total_samples", 4096.0},
                                     {"block_samples", 1024.0}};
    REQUIRE(src->configure(sp, {}, err));
    NodeId s = g.add(std::move(src), "tone");

    std::unique_ptr<OptionalInComponent> sinkp(new OptionalInComponent());
    OptionalInComponent* sink = sinkp.get();
    NodeId k = g.add(std::move(sinkp), "sink");

    REQUIRE(g.connect(s, "out", k, "in", err));
    // 必填口连上、可选口空着：validate 通过（若把可选口也当必填，这里会报「没有连线」）
    CHECK(g.validate(err));

    Xoshiro256pp rng(1);
    RunReport rep = g.run(rng);
    CHECK_MESSAGE(rep.ok, rep.error);
    CHECK(sink->rounds > 0);
    CHECK(sink->rounds_with_opt == 0);   // 没连线就不该收到该口的数据
}

TEST_CASE("可选输入口：连上之后照常参与就绪判断") {
    Graph g;
    std::string err;
    std::unique_ptr<ToneSource> src(new ToneSource());
    std::map<std::string, double> sp{{"sample_rate_Hz", 1e6}, {"total_samples", 4096.0},
                                     {"block_samples", 1024.0}};
    REQUIRE(src->configure(sp, {}, err));
    NodeId s = g.add(std::move(src), "tone");

    // 可选口的上游：一个每轮产出 SceneParamFrame 的桩
    struct FrameSource : IComponent {
        std::uint64_t left = 4;
        std::string type_name() const override { return "FrameSource"; }
        std::vector<PortSpec> inputs() const override { return {}; }
        std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::SceneParamFrame}}; }
        bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&,
                       std::string&) override { return true; }
        bool init(IRandom&, std::string&) override { return true; }
        Step process(PortMap&, PortMap& out, std::string&) override {
            if (left == 0) return Step::Finished;
            left--;
            PortData d;
            d.type = PortType::SceneParamFrame;
            d.has_data = true;
            d.scenes.push_back(SceneParamFrame());
            out["out"] = d;
            return Step::Produced;
        }
        void reset() override {}
        ComponentStatus status() const override { return ComponentStatus(); }
    };
    std::unique_ptr<FrameSource> fs(new FrameSource());
    NodeId f = g.add(std::move(fs), "frames");

    std::unique_ptr<OptionalInComponent> sinkp(new OptionalInComponent());
    OptionalInComponent* sink = sinkp.get();
    NodeId k = g.add(std::move(sinkp), "sink");

    REQUIRE(g.connect(s, "out", k, "in", err));
    REQUIRE(g.connect(f, "out", k, "scene", err));
    CHECK(g.validate(err));

    Xoshiro256pp rng(1);
    RunReport rep = g.run(rng);
    CHECK_MESSAGE(rep.ok, rep.error);
    CHECK(sink->rounds_with_opt > 0);
}

TEST_CASE("端口类型：RecognitionList 只与自己相连（D-051）") {
    CHECK(std::string(to_string(PortType::RecognitionList)) == "RecognitionList");
    CHECK(can_connect(PortType::RecognitionList, PortType::RecognitionList));
    CHECK_FALSE(can_connect(PortType::FeatureVector, PortType::RecognitionList));
    CHECK_FALSE(can_connect(PortType::RecognitionList, PortType::IQStream));
}

TEST_CASE("块元数据：削顶计数缺省为零，是标记不是降级（D-051）") {
    BlockMeta m;
    CHECK(m.clip_count == 0u);
    CHECK(m.state == State::Valid);
}
