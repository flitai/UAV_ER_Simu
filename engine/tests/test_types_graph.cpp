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

// --------------------------------------------------------------- 接受部分输入（C-5，D-067）

namespace {

// 产出 n 块后 Finished，收尾时再吐一块「尾块」——模拟检测器 / 特征提取器在 flush() 里才出的行。
struct TailSource : IComponent {
    std::uint64_t n, produced = 0;
    explicit TailSource(std::uint64_t n_) : n(n_) {}
    std::string type_name() const override { return "TailSource"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&,
                   std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { return true; }
    static PortData block(std::uint64_t k) {
        PortData d;
        d.type = PortType::IQStream;
        d.has_data = true;
        d.iq.meta.start_sample = k;
        return d;
    }
    Step process(PortMap&, PortMap& out, std::string&) override {
        if (produced >= n) return Step::Finished;
        out["out"] = block(produced++);
        return Step::Produced;
    }
    Step flush(PortMap& out, std::string&) override {
        out["out"] = block(produced++);   // 尾块编号紧接其后
        return Step::Finished;
    }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

// 单输入中继：把收到的块压一轮再放出去，最后一块只在 flush() 里出——让尾块到得比上游结束晚。
struct DelayRelay : IComponent {
    bool holding = false;
    PortData held;
    std::string type_name() const override { return "DelayRelay"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::IQStream}}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&,
                   std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { return true; }
    Step process(PortMap& in, PortMap& out, std::string&) override {
        if (holding) out["out"] = held;
        held = in.at("in");
        holding = true;
        return Step::Produced;
    }
    Step flush(PortMap& out, std::string&) override {
        if (holding) out["out"] = held;
        holding = false;
        return Step::Finished;
    }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

// 双输入汇聚器：记录每次调用哪些口有数据、收到的块编号；partial 为真即声明接受部分输入。
struct TwoInSink : IComponent {
    bool partial;
    std::vector<std::uint64_t> got_a, got_b;
    int calls = 0, flushes = 0, calls_with_both = 0;
    explicit TwoInSink(bool p) : partial(p) {}
    std::string type_name() const override { return "TwoInSink"; }
    std::vector<PortSpec> inputs() const override {
        return {PortSpec{"a", PortType::IQStream}, PortSpec{"b", PortType::IQStream}};
    }
    std::vector<PortSpec> outputs() const override { return {}; }
    bool accepts_partial_inputs() const override { return partial; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&,
                   std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { return true; }
    Step process(PortMap& in, PortMap&, std::string&) override {
        calls++;
        const bool ha = in.count("a") && in.at("a").has_data;
        const bool hb = in.count("b") && in.at("b").has_data;
        if (ha) got_a.push_back(in.at("a").iq.meta.start_sample);
        if (hb) got_b.push_back(in.at("b").iq.meta.start_sample);
        if (ha && hb) calls_with_both++;
        return Step::Idle;
    }
    Step flush(PortMap&, std::string&) override { flushes++; return Step::Finished; }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

// A 三块 + 尾块直连；B 一块 + 尾块经中继压一轮。返回汇聚器供断言。
TwoInSink* build_two_in(Graph& g, bool partial) {
    std::string err;
    NodeId a = g.add(std::unique_ptr<IComponent>(new TailSource(3)), "A");
    NodeId b = g.add(std::unique_ptr<IComponent>(new TailSource(1)), "B");
    NodeId r = g.add(std::unique_ptr<IComponent>(new DelayRelay()), "relay");
    std::unique_ptr<TwoInSink> sp(new TwoInSink(partial));
    TwoInSink* sink = sp.get();
    NodeId k = g.add(std::move(sp), "sink");
    REQUIRE(g.connect(a, "out", k, "a", err));
    REQUIRE(g.connect(b, "out", r, "in", err));
    REQUIRE(g.connect(r, "out", k, "b", err));
    REQUIRE(g.validate(err));
    return sink;
}

}  // namespace

TEST_CASE("调度器：缺省的双输入节点只在两口都到齐时运行，尾块与错拍的块被丢（既有行为，写成断言）") {
    Graph g;
    TwoInSink* sink = build_two_in(g, false);
    Xoshiro256pp rng(1);
    RunReport rep = g.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);
    // A 的 a0 在第 0 轮到而 b 还空 → 第 1 轮被 a1 覆盖；A 的尾块 a3 到时 b 已空且上游全结束 → 收尾时丢
    CHECK(sink->got_a == std::vector<std::uint64_t>{1, 2});
    CHECK(sink->got_b == std::vector<std::uint64_t>{0, 1});
    CHECK(sink->calls == 2);
    CHECK(sink->calls_with_both == 2);
    CHECK(sink->flushes == 1);
}

TEST_CASE("调度器：接受部分输入的节点任一口有数据即运行，尾块与错拍的块一块不丢，上游全结束且缓冲空才收尾（C-5）") {
    Graph g;
    TwoInSink* sink = build_two_in(g, true);
    Xoshiro256pp rng(1);
    RunReport rep = g.run(rng);
    REQUIRE_MESSAGE(rep.ok, rep.error);        // 只有一口有数据时返回 Idle 也不触发「调度停滞」
    CHECK(sink->got_a == std::vector<std::uint64_t>{0, 1, 2, 3});   // 含 A 的尾块
    CHECK(sink->got_b == std::vector<std::uint64_t>{0, 1});         // 含经中继晚到的 B 尾块
    CHECK(sink->calls == 4);                    // 每块只消费一次：a0 | a1+b0 | a2+b1 | a3
    CHECK(sink->calls_with_both == 2);
    CHECK(sink->flushes == 1);
}
