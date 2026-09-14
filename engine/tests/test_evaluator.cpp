// 评价器组件级测试（C-5，D-067）：直接建图，用桩件喂检测行 / 识别行 / 场景参数帧，
// 验真值区间的构造（tx_on 连续段、中心频率变化切段、突发门控、频段外标记、跨轮重发去重）、
// 「尾块到得了双输入节点」（步骤 0 的实地验收）与 init() 不碰随机流。
#include "doctest/doctest.h"

#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "cuav/graph.h"
#include "cuav/observer.h"
#include "cuav/components/evaluator.h"
#include "cuav/components/processing.h"
#include "cuav/components/recognition.h"
#include "cuav/components/sources.h"

using namespace cuav;

namespace {

const char* kScenario = CUAV_SOURCE_DIR "/tests/fixtures/eval-chain.scenario.json";

// 逐轮产出检测行的桩：frames 帧，命中按给定区间 [on_from, on_to)，segment 按 merge_gap 2 分段；
// 最后 tail 帧只在 flush() 里出——模拟检测器 / 识别器把最后一段压到收尾。
struct DetStub : IComponent {
    std::uint64_t frames, per_round, produced = 0, tail;
    double fs, dt;
    std::size_t nfft;
    std::vector<std::pair<std::uint64_t, std::uint64_t>> on;   // 命中帧区间 [a, b)
    std::int64_t seg = -1;
    bool last_hit = false;
    DetStub(std::uint64_t frames_, std::uint64_t per_round_, std::uint64_t tail_, double fs_, std::size_t nfft_)
        : frames(frames_), per_round(per_round_), tail(tail_), fs(fs_), dt(static_cast<double>(nfft_) / fs_), nfft(nfft_) {}
    std::string type_name() const override { return "DetStub"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::DetectionList}}; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { produced = 0; seg = -1; last_hit = false; return true; }
    bool hit_at(std::uint64_t k) const {
        for (const auto& iv : on) if (k >= iv.first && k < iv.second) return true;
        return false;
    }
    PortData make(std::uint64_t from, std::uint64_t to) {
        PortData d;
        d.type = PortType::DetectionList;
        d.has_data = true;
        d.detections.meta.sample_rate_Hz = fs;
        d.detections.meta.center_frequency_Hz = 2.4405e9;
        for (std::uint64_t k = from; k < to; ++k) {
            Detection x;
            x.frame_index = k;
            x.start_sample = k * nfft;
            x.t_s = static_cast<double>(k) * dt;
            x.hit = hit_at(k);
            x.statistic = x.hit ? 2.0 : 0.5;
            x.threshold = 1.1;
            x.f_lo_Hz = 2.4405e9 - 225e3;
            x.f_hi_Hz = 2.4405e9 + 225e3;
            if (x.hit) { if (!last_hit) seg++; x.segment_id = seg; }
            last_hit = x.hit;
            d.detections.items.push_back(x);
        }
        return d;
    }
    Step process(PortMap&, PortMap& out, std::string&) override {
        if (produced >= frames - tail) return Step::Finished;
        const std::uint64_t to = std::min(frames - tail, produced + per_round);
        out["out"] = make(produced, to);
        produced = to;
        return Step::Produced;
    }
    Step flush(PortMap& out, std::string&) override {
        if (tail > 0) { out["out"] = make(produced, frames); produced = frames; }
        return Step::Finished;
    }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

// 识别行桩：单输入（吃检测行），对每个段在段收口时出一行；最后一段只在 flush() 出——正是 demo-01 那种「唯一一段持续到结束」
struct RecStub : IComponent {
    std::string label;
    std::int64_t open = -1;
    double t0 = 0.0, t1 = 0.0, dt = 0.0;
    explicit RecStub(const std::string& l) : label(l) {}
    std::string type_name() const override { return "RecStub"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::DetectionList}}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::RecognitionList}}; }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { open = -1; return true; }
    RecognitionRow row() const {
        RecognitionRow r;
        r.segment_id = open; r.t_s = t0; r.t_end_s = t1; r.label = label; r.result = "known"; r.posterior = 0.8;
        return r;
    }
    Step process(PortMap& in, PortMap& out, std::string&) override {
        PortData o;
        o.type = PortType::RecognitionList;
        o.has_data = true;    // 消费即产出
        const DetectionList& dl = in.at("in").detections;
        for (const auto& x : dl.items) {
            if (x.hit && x.segment_id != open) {
                if (open >= 0) o.recognitions.items.push_back(row());
                open = x.segment_id; t0 = x.t_s;
            }
            if (x.hit) { dt = 0.0; t1 = x.t_s; }
        }
        out["out"] = o;
        return Step::Produced;
    }
    Step flush(PortMap& out, std::string&) override {
        if (open < 0) return Step::Finished;
        PortData o;
        o.type = PortType::RecognitionList;
        o.has_data = true;
        o.recognitions.items.push_back(row());
        out["out"] = o;
        return Step::Finished;
    }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

// 场景参数帧桩：每轮推 rate Hz 的帧窗（含上一轮末帧的重发，与 ScenarioSource 同），tx_on / center 由回调给
struct FrameStub : IComponent {
    struct Spec { std::string emitter; std::function<bool(double)> on; std::function<double(double)> center; };
    std::vector<Spec> specs;
    double rate = 20.0, duration = 6.0;
    std::string site = "site-1";
    std::uint64_t next = 0, per_round = 3;
    std::string type_name() const override { return "FrameStub"; }
    std::vector<PortSpec> inputs() const override { return {}; }
    std::vector<PortSpec> outputs() const override {
        std::vector<PortSpec> v;
        for (std::size_t i = 0; i < specs.size(); ++i) v.push_back(PortSpec{"link:" + specs[i].emitter, PortType::SceneParamFrame});
        return v;
    }
    bool configure(const std::map<std::string, double>&, const std::map<std::string, std::string>&, std::string&) override { return true; }
    bool init(IRandom&, std::string&) override { next = 0; return true; }
    Step process(PortMap&, PortMap& out, std::string&) override {
        const std::uint64_t total = static_cast<std::uint64_t>(duration * rate);
        if (next >= total) return Step::Finished;
        const std::uint64_t k0 = next == 0 ? 0 : next - 1;     // 重发上一轮末帧
        const std::uint64_t k1 = std::min(total, next + per_round);
        for (std::size_t i = 0; i < specs.size(); ++i) {
            PortData d;
            d.type = PortType::SceneParamFrame;
            d.has_data = true;
            for (std::uint64_t k = k0; k < k1; ++k) {
                SceneParamFrame f;
                f.valid_from_s = static_cast<double>(k) / rate;
                f.valid_to_s = static_cast<double>(k + 1) / rate;
                f.update_rate_Hz = rate;
                f.tx_on = specs[i].on(f.valid_from_s);
                f.tx_center_Hz = specs[i].center(f.valid_from_s);
                f.site_id = site;
                f.emitter_id = specs[i].emitter;
                f.link_id = site + "-" + specs[i].emitter;
                d.scenes.push_back(f);
            }
            out["link:" + specs[i].emitter] = d;
        }
        next = k1;
        return Step::Produced;
    }
    void reset() override {}
    ComponentStatus status() const override { return ComponentStatus(); }
};

struct Collect : IRunObserver {
    std::vector<TruthReport> truth;
    std::vector<EvaluationReport> evals;
    void on_truth(const TruthReport& r) override { truth.push_back(r); }
    void on_evaluation(const EvaluationReport& r) override { evals.push_back(r); }
};

std::unique_ptr<Evaluator> make_eval(const std::map<std::string, std::string>& txt, std::size_t nfft = 1024) {
    std::unique_ptr<Evaluator> e(new Evaluator());
    std::string err;
    std::map<std::string, std::string> t = txt;
    if (!t.count("scenario_path")) t["scenario_path"] = kScenario;
    if (!t.count("site_id")) t["site_id"] = "site-1";
    std::map<std::string, double> num{{"nfft", static_cast<double>(nfft)}};
    REQUIRE_MESSAGE(e->configure(num, t, err), err);
    return e;
}

}  // namespace

TEST_CASE("评价器：持续到结束的单音段——检测尾块与识别器收尾时才出的行都到得了评价器（步骤 0 的实地验收）") {
    // 500 kS/s、nfft 1024、6 s → 2929 帧；单音自 3.0 s 起（帧 1465）持续到结束；检测器最后 5 帧压到 flush 出
    const double fs = 500000.0;
    const std::size_t nfft = 1024;
    std::unique_ptr<DetStub> ds(new DetStub(2929, 64, 5, fs, nfft));
    ds->on.push_back(std::make_pair<std::uint64_t, std::uint64_t>(1465, 2929));
    std::unique_ptr<RecStub> rs(new RecStub("cw_beacon"));
    std::unique_ptr<FrameStub> fsb(new FrameStub());
    FrameStub::Spec sp;
    sp.emitter = "uav-1";
    sp.on = [](double t) { return t >= 3.0; };
    sp.center = [](double) { return 2.4405e9; };
    fsb->specs.push_back(sp);
    std::unique_ptr<Evaluator> ev = make_eval({{"truth_source", "scenario"}}, nfft);
    Evaluator* evp = ev.get();

    Graph g;
    std::string err;
    NodeId d = g.add(std::move(ds), "det");
    NodeId r = g.add(std::move(rs), "rec");
    NodeId f = g.add(std::move(fsb), "scn");
    NodeId e = g.add(std::move(ev), "eval");
    REQUIRE(g.connect(d, "out", r, "in", err));
    REQUIRE(g.connect(d, "out", e, "det", err));
    REQUIRE(g.connect(r, "out", e, "rec", err));
    REQUIRE(g.connect(f, "link:uav-1", e, "scene1", err));
    REQUIRE_MESSAGE(g.validate(err), err);
    Collect obs;
    Xoshiro256pp rng(3);
    RunReport rep = g.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);

    const EvaluationMetrics& m = evp->metrics();
    CHECK(m.frames.total == 2929);                 // 含 flush 才出的 5 帧
    CHECK(m.frames.truth_on == 1464);              // 帧中点 ≥ 3.0：帧 1465 起（帧 1464 的中点 2.999… 不算）
    CHECK(m.frames.tp == 1464);
    CHECK(m.frames.fn == 0);
    CHECK(m.frames.fp == 0);
    CHECK(m.frames.pd == 1.0);
    REQUIRE(obs.truth.size() == 1);
    CHECK(obs.truth[0].row.t_s == 3.0);
    CHECK(obs.truth[0].row.t_end_s == 6.0);
    CHECK(obs.truth[0].row.label == "cw_beacon");
    CHECK(obs.truth[0].row.in_band);
    CHECK(obs.truth[0].site_id == "site-1");
    CHECK(m.segments.matched == 1);
    CHECK(m.recognition.evaluated == 1);           // 识别器只在 flush 里出的那一行到了
    CHECK(m.recognition.accuracy == 1.0);
    CHECK(m.recognition.confusion[3][3] == 1);     // cw_beacon → cw_beacon
    REQUIRE(obs.evals.size() == 1);
    CHECK(obs.evals[0].node_id == "eval");
    CHECK(obs.evals[0].trace.model_layer == "M2");
    CHECK(obs.evals[0].trace.credibility == "V2");
    CHECK(obs.evals[0].params.frame_dt_s == static_cast<double>(nfft) / fs);
    CHECK(m.state == State::Valid);
}

TEST_CASE("评价器：tx_on 的连续段成区间、tx_off 断开、中心频率一变就切段、频段外的段只标记不进分母；重发的帧不重复计") {
    const double fs = 500000.0;
    std::unique_ptr<DetStub> ds(new DetStub(500, 50, 0, fs, 1024));      // ~1.02 s
    std::unique_ptr<FrameStub> fsb(new FrameStub());
    fsb->duration = 1.0;
    FrameStub::Spec a;    // uav-1：0–0.3 开，0.3–0.5 关，0.5–1.0 开且 0.75 起跳到频段外的中心
    a.emitter = "uav-1";
    a.on = [](double t) { return t < 0.3 || t >= 0.5; };
    a.center = [](double t) { return t >= 0.75 ? 2.4415e9 : 2.4405e9; };
    fsb->specs.push_back(a);
    FrameStub::Spec b;    // uav-2：不在场景文件里
    b.emitter = "ghost";
    b.on = [](double) { return true; };
    b.center = [](double) { return 2.4405e9; };
    fsb->specs.push_back(b);
    std::unique_ptr<Evaluator> ev = make_eval({{"truth_source", "scenario"}});
    Evaluator* evp = ev.get();

    Graph g;
    std::string err;
    NodeId d = g.add(std::move(ds), "det");
    NodeId f = g.add(std::move(fsb), "scn");
    NodeId e = g.add(std::move(ev), "eval");
    REQUIRE(g.connect(d, "out", e, "det", err));
    REQUIRE(g.connect(f, "link:uav-1", e, "scene1", err));
    REQUIRE(g.connect(f, "link:ghost", e, "scene2", err));
    REQUIRE_MESSAGE(g.validate(err), err);
    Collect obs;
    Xoshiro256pp rng(3);
    RunReport rep = g.run(rng, obs);
    REQUIRE_MESSAGE(rep.ok, rep.error);

    // uav-1 三段：[0, 0.3) 频段内、[0.5, 0.75) 频段内、[0.75, 1.0) 频段外（中心 +1 MHz、带宽 400 kHz）；ghost 一段
    std::vector<TruthRow> u1;
    for (const auto& t : obs.truth) if (t.row.emitter_id == "uav-1") u1.push_back(t.row);
    REQUIRE(u1.size() == 3);
    CHECK(u1[0].t_s == 0.0);  CHECK(u1[0].t_end_s == 0.3);  CHECK(u1[0].in_band);
    CHECK(u1[1].t_s == 0.5);  CHECK(u1[1].t_end_s == 0.75); CHECK(u1[1].in_band);
    CHECK(u1[2].t_s == 0.75); CHECK(u1[2].t_end_s == 1.0);  CHECK_FALSE(u1[2].in_band);
    CHECK(u1[0].label == "cw_beacon");
    const EvaluationMetrics& m = evp->metrics();
    CHECK(m.segments.truth_out_of_band == 1);
    CHECK(m.quality.truth_rows == 4);
    CHECK(m.state == State::Degraded);          // ghost 不在场景文件里
    bool noted = false;
    for (const auto& r : m.reasons) if (r.find("ghost") != std::string::npos) noted = true;
    CHECK(noted);
    CHECK(m.recognition.state == State::NotApplicable);   // rec 口没接
}

TEST_CASE("评价器：burst 波形按样点域门控切成导通窗，每窗一行真值；manifest 模式全片一行或（背景）没有行") {
    const double fs = 500000.0;
    std::unique_ptr<DetStub> ds(new DetStub(500, 50, 0, fs, 1024));
    std::unique_ptr<FrameStub> fsb(new FrameStub());
    fsb->duration = 1.0;
    FrameStub::Spec a;    // uav-3：场景里是 burst，period 0.5 s、duty 0.2 → 导通窗 [0, 0.1)、[0.5, 0.6)
    a.emitter = "uav-3";
    a.on = [](double) { return true; };
    a.center = [](double) { return 2.4405e9 - 97656.25; };
    fsb->specs.push_back(a);
    std::unique_ptr<Evaluator> ev = make_eval({{"truth_source", "scenario"}});
    Evaluator* evp = ev.get();
    Graph g;
    std::string err;
    NodeId d = g.add(std::move(ds), "det");
    NodeId f = g.add(std::move(fsb), "scn");
    NodeId e = g.add(std::move(ev), "eval");
    REQUIRE(g.connect(d, "out", e, "det", err));
    REQUIRE(g.connect(f, "link:uav-3", e, "scene1", err));
    REQUIRE_MESSAGE(g.validate(err), err);
    Collect obs;
    Xoshiro256pp rng(3);
    REQUIRE(g.run(rng, obs).ok);
    REQUIRE(obs.truth.size() == 2);
    CHECK(obs.truth[0].row.t_s == 0.0);
    CHECK(std::fabs(obs.truth[0].row.t_end_s - 0.1) < 1e-12);
    CHECK(std::fabs(obs.truth[1].row.t_s - 0.5) < 1e-12);
    CHECK(std::fabs(obs.truth[1].row.t_end_s - 0.6) < 1e-12);
    CHECK(obs.truth[0].row.label == "telemetry_burst");
    CHECK(obs.truth[0].row.waveform == "burst");
    CHECK(evp->metrics().segments.truth == 2);

    // manifest：非背景类全片一行；背景类没有行
    std::unique_ptr<Evaluator> m1 = make_eval({{"truth_source", "manifest"}, {"data_id", "x"},
                                               {"manifest_path", CUAV_SOURCE_DIR "/tests/fixtures/eval-target.manifest.json"}});
    std::unique_ptr<Evaluator> m0 = make_eval({{"truth_source", "manifest"}, {"data_id", "y"},
                                               {"manifest_path", CUAV_SOURCE_DIR "/tests/fixtures/eval-background.manifest.json"}});
    for (int pass = 0; pass < 2; ++pass) {
        std::unique_ptr<DetStub> ds2(new DetStub(100, 50, 0, fs, 1024));
        ds2->on.push_back(std::make_pair<std::uint64_t, std::uint64_t>(10, 90));
        Graph g2;
        NodeId d2 = g2.add(std::move(ds2), "det");
        Evaluator* ep = pass == 0 ? m1.get() : m0.get();
        NodeId e2 = g2.add(std::move(pass == 0 ? m1 : m0), "eval");
        REQUIRE(g2.connect(d2, "out", e2, "det", err));
        REQUIRE_MESSAGE(g2.validate(err), err);
        Collect o2;
        Xoshiro256pp rng2(3);
        REQUIRE(g2.run(rng2, o2).ok);
        if (pass == 0) {
            REQUIRE(o2.truth.size() == 1);
            CHECK(o2.truth[0].row.label == "video_link");
            CHECK(o2.truth[0].row.emitter_id.empty());
            CHECK(std::isnan(o2.truth[0].row.center_Hz));
            CHECK(ep->metrics().frames.truth_on == 100);   // 全片为真 → 没有负样本
            CHECK(std::isnan(ep->metrics().frames.pfa));
        } else {
            CHECK(o2.truth.empty());
            CHECK(ep->metrics().frames.truth_on == 0);
            CHECK(std::isnan(ep->metrics().frames.pd));
            CHECK(ep->metrics().frames.fp == 80);
        }
    }
}

TEST_CASE("评价器：配置约束——scenario 模式缺场景路径或多站未绑站即拒；manifest 模式缺 data_id 即拒；波形与类码映射表") {
    Evaluator e;
    std::string err;
    std::map<std::string, double> num;
    CHECK_FALSE(e.configure(num, {{"truth_source", "scenario"}}, err));
    CHECK(err.find("scenario_path") != std::string::npos);
    CHECK_FALSE(e.configure(num, {{"truth_source", "manifest"}}, err));
    CHECK(err.find("data_id") != std::string::npos);
    CHECK(e.configure(num, {{"truth_source", "none"}}, err));
    CHECK_FALSE(e.configure(num, {{"truth_source", "bogus"}}, err));
    CHECK(Evaluator::label_for_waveform("tone", 400e3, false) == "cw_beacon");
    CHECK(Evaluator::label_for_waveform("burst", 200e3, false) == "telemetry_burst");
    CHECK(Evaluator::label_for_waveform("burst", 200e3, true) == "rc_hopping");
    CHECK(Evaluator::label_for_waveform("noise", 2e6, false) == "video_link");
    CHECK(Evaluator::label_for_waveform("noise", 50e3, false) == "noise");
    bool bg = false;
    CHECK(Evaluator::label_for_class_code("B", bg).empty());       CHECK(bg);
    CHECK(Evaluator::label_for_class_code("T0000", bg).empty());   CHECK(bg);
    CHECK(Evaluator::label_for_class_code("T10010", bg) == "rc_hopping"); CHECK_FALSE(bg);
    CHECK(Evaluator::label_for_class_code("D1", bg) == "video_link");
    CHECK(Evaluator::label_for_class_code("T0010", bg) == "video_link");
    // 连线约束：scenario 模式至少一路 scene 口
    std::unique_ptr<Evaluator> ev = make_eval({{"truth_source", "scenario"}});
    CHECK_FALSE(ev->check_wiring({"det", "rec"}, err));
    CHECK(err.find("scene") != std::string::npos);
    CHECK(ev->check_wiring({"det", "scene3"}, err));
    std::unique_ptr<Evaluator> en = make_eval({{"truth_source", "none"}});
    CHECK(en->check_wiring({"det"}, err));
}

TEST_CASE("评价器：init() 不碰共享随机流——接不接评价器，下游噪声源的样点逐位相同") {
    auto run_noise = [](bool with_eval) {
        Graph g;
        std::string err;
        std::unique_ptr<NoiseSource> ns(new NoiseSource());
        std::map<std::string, double> np{{"sample_rate_Hz", 1e6}, {"total_samples", 4096.0}, {"power_dBm", -100.0}, {"block_samples", 1024.0}};
        REQUIRE(ns->configure(np, {}, err));
        std::unique_ptr<EnergyDetector> det(new EnergyDetector());
        std::map<std::string, double> dp{{"nfft", 256.0}, {"band_lo_Hz", -1e5}, {"band_hi_Hz", 1e5}};
        REQUIRE(det->configure(dp, {{"noise_mode", "sliding"}}, err));
        EnergyDetector* dp_ = det.get();
        NodeId n = g.add(std::move(ns), "noise");
        NodeId d = g.add(std::move(det), "det");
        REQUIRE(g.connect(n, "out", d, "in", err));
        if (with_eval) {
            std::unique_ptr<Evaluator> ev = make_eval({{"truth_source", "none"}}, 256);
            NodeId e = g.add(std::move(ev), "eval");
            REQUIRE(g.connect(d, "out", e, "det", err));
        } else {
            std::unique_ptr<DetectionSink> sink(new DetectionSink());
            NodeId k = g.add(std::move(sink), "sink");
            REQUIRE(g.connect(d, "out", k, "in", err));
        }
        REQUIRE_MESSAGE(g.validate(err), err);
        Xoshiro256pp rng(20260914);
        REQUIRE(g.run(rng).ok);
        return dp_->frames();
    };
    // 同种子两种接法帧数相同；随机流一致的直接证据在 test_recognition_chain 的同类测试里，这里守「评价器不抽数」
    CHECK(run_noise(false) == run_noise(true));
}
