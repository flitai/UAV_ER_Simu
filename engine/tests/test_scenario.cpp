// 场景文件读取、SHA-256 与航迹黄金基准（06 备忘录 §9C G-0 / G-1）。

#include <cmath>
#include <cstdio>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

#include "cuav_geo/activity.h"
#include "cuav/scenario_json.h"
#include "cuav/sha256.h"
#include "doctest/doctest.h"
#include "nlohmann/json.hpp"

using namespace cuav;

namespace {
#ifndef CUAV_SOURCE_DIR
#define CUAV_SOURCE_DIR "."
#endif
// CUAV_SOURCE_DIR 是 engine/，仓库根在它的上一级。
std::string repo(const std::string& rel) { return std::string(CUAV_SOURCE_DIR) + "/../" + rel; }

const char* kDemo = "data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json";

nlohmann::json demo_json() {
    std::ifstream f(repo(kDemo).c_str(), std::ios::binary);
    REQUIRE(f.good());
    std::stringstream ss;
    ss << f.rdbuf();
    return nlohmann::json::parse(ss.str());
}
}  // namespace

TEST_CASE("SHA-256：四条 NIST 测试向量逐字符相符") {
    CHECK(sha256_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    CHECK(sha256_hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    CHECK(sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    CHECK(sha256_hex("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnop"
                     "jklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu") ==
          "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
}

TEST_CASE("SHA-256：跨调用分段喂入与一次喂入结果相同；文件哈希与内存哈希一致") {
    const std::string text = "亚运村上空单机过顶后远去 0123456789";
    Sha256 a;
    a.update(text.data(), text.size());
    Sha256 b;
    for (std::size_t i = 0; i < text.size(); ++i) b.update(text.data() + i, 1);
    CHECK(a.hex() == b.hex());

    const std::string tmp = repo("engine/build/sha256_probe.tmp");
    {
        std::ofstream f(tmp.c_str(), std::ios::binary | std::ios::trunc);
        f.write(text.data(), static_cast<std::streamsize>(text.size()));
    }
    std::string hex, err;
    CHECK(sha256_file(tmp, hex, err));
    CHECK(hex == a.hex());
    std::remove(tmp.c_str());

    // 打不开必须写理由返回 false，不拿空串顶替（铁律 15）。
    CHECK_FALSE(sha256_file(repo("data/scene/不存在的文件.json"), hex, err));
    CHECK_FALSE(err.empty());
}

TEST_CASE("场景：示例文件读得通、跨引用校验过、哈希算的是原始字节") {
    LoadedScenario s;
    std::string err;
    REQUIRE_MESSAGE(load_scenario_file(repo(kDemo), s, err), err);
    CHECK(s.scenario.scenario_id == "demo-01");
    CHECK(s.scenario.synthetic);
    CHECK(s.scenario.sites.size() == 1);
    CHECK(s.scenario.emitters.size() == 1);
    CHECK(s.scenario.routes.size() == 1);
    CHECK(s.scenario.routes[0].waypoints.size() == 3);
    CHECK(s.scenario.duration_s == 180.0);
    CHECK(s.scenario.emitters[0].emission.waveform.type == geo::WaveformType::Tone);
    CHECK(s.sha256.size() == 64);

    // 哈希是文件原始字节的哈希，不是解析后再序列化的结果（场景编辑器保存时必须回传落盘哈希）。
    std::string direct, e2;
    REQUIRE(sha256_file(repo(kDemo), direct, e2));
    CHECK(s.sha256 == direct);
}

TEST_CASE("场景：观测区域清单哈希核对通过，占位符被拒") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));

    std::string actual;
    CHECK_MESSAGE(check_aoi_manifest(s.scenario, repo("data/scene"), actual, err), err);
    CHECK(actual == s.scenario.aoi_manifest_sha256);

    geo::Scenario placeholder = s.scenario;
    placeholder.aoi_manifest_sha256 = "<manifest.json 的 sha256>";
    CHECK_FALSE(check_aoi_manifest(placeholder, repo("data/scene"), actual, err));
    CHECK(err.find("占位符") != std::string::npos);

    geo::Scenario wrong = s.scenario;
    wrong.aoi_manifest_sha256 = std::string(64, 'a');
    CHECK_FALSE(check_aoi_manifest(wrong, repo("data/scene"), actual, err));
}

TEST_CASE("场景：未知键一律拒绝，报文点名那个键") {
    nlohmann::json j = demo_json();
    j["unexpected"] = 1;
    geo::Scenario s;
    std::string err;
    CHECK_FALSE(parse_scenario(j, s, err));
    CHECK(err.find("unexpected") != std::string::npos);

    nlohmann::json k = demo_json();
    k["sites"][0]["receiver"]["gain"] = 1.0;
    CHECK_FALSE(parse_scenario(k, s, err));
    CHECK(err.find("gain") != std::string::npos);
}

TEST_CASE("场景：四个冻结常量各自被守住") {
    geo::Scenario s;
    std::string err;

    nlohmann::json a = demo_json();
    a["schema_version"] = "cuav-scenario/2";
    CHECK_FALSE(parse_scenario(a, s, err));

    nlohmann::json b = demo_json();
    b["synthetic"] = false;
    CHECK_FALSE(parse_scenario(b, s, err));

    nlohmann::json c = demo_json();
    c["coordinate"]["crs"] = "GCJ-02";
    CHECK_FALSE(parse_scenario(c, s, err));

    nlohmann::json d = demo_json();
    d["time"]["basis"] = "DeviceHardware";
    CHECK_FALSE(parse_scenario(d, s, err));
}

TEST_CASE("场景：波形三分支按 oneOf 查字段") {
    geo::Scenario s;
    std::string err;

    nlohmann::json a = demo_json();
    a["emitters"][0]["emission"]["waveform"] = nlohmann::json{{"type", "tone"}};   // 缺 offset_Hz
    CHECK_FALSE(parse_scenario(a, s, err));

    nlohmann::json b = demo_json();
    b["emitters"][0]["emission"]["waveform"] =
        nlohmann::json{{"type", "burst"}, {"period_s", 0.05}, {"offset_Hz", 0.0}};  // 缺 duty
    CHECK_FALSE(parse_scenario(b, s, err));

    // noise 的 offset_Hz 自 C-8 起可选且**真的起作用**（此前 noise 不搬移频率，给了也白给）
    nlohmann::json c = demo_json();
    c["emitters"][0]["emission"]["waveform"] = nlohmann::json{{"type", "noise"}, {"offset_Hz", 12345.0}};
    CHECK(parse_scenario(c, s, err));
    CHECK(s.emitters[0].emission.waveform.offset_Hz == doctest::Approx(12345.0));
    nlohmann::json c2 = demo_json();
    c2["emitters"][0]["emission"]["waveform"] = nlohmann::json{{"type", "noise"}};   // 不写即 0
    CHECK(parse_scenario(c2, s, err));
    CHECK(s.emitters[0].emission.waveform.offset_Hz == doctest::Approx(0.0));
    nlohmann::json c3 = demo_json();
    c3["emitters"][0]["emission"]["waveform"] = nlohmann::json{{"type", "noise"}, {"bw_Hz", 1.0}};
    CHECK_FALSE(parse_scenario(c3, s, err));   // 未知键仍然拒

    nlohmann::json d = demo_json();
    d["emitters"][0]["emission"]["waveform"] =
        nlohmann::json{{"type", "burst"}, {"period_s", 0.05}, {"duty", 1.5}, {"offset_Hz", 0.0}};
    CHECK_FALSE(parse_scenario(d, s, err));   // 占空比越界

    nlohmann::json ok = demo_json();
    ok["emitters"][0]["emission"]["waveform"] =
        nlohmann::json{{"type", "burst"}, {"period_s", 0.05}, {"duty", 0.6}, {"offset_Hz", 0.0}};
    CHECK(parse_scenario(ok, s, err));
    CHECK(s.emitters[0].emission.waveform.type == geo::WaveformType::Burst);
}

TEST_CASE("场景：跨引用与物理约束（schema 管不到的那些）") {
    geo::Scenario base;
    std::string err;
    REQUIRE(parse_scenario(demo_json(), base, err));
    REQUIRE(base.cross_check(err));

    geo::Scenario s = base;
    s.routes[0].emitter_id = "uav-9";
    CHECK_FALSE(s.cross_check(err));

    s = base;
    s.routes.push_back(base.routes[0]);          // 同一辐射源两条航线
    CHECK_FALSE(s.cross_check(err));

    s = base;
    if (s.activities.size() >= 2) {
        const double t = s.activities[0].t_s;
        s.activities[0].t_s = s.activities[1].t_s + 1.0;
        s.activities[1].t_s = t;
        CHECK_FALSE(s.cross_check(err));         // 时间线逆序
    }

    // 铁律 4：辐射源频偏加半带宽必须小于采样率的一半。
    s = base;
    s.emitters[0].emission.center_Hz += 400000.0;
    CHECK_FALSE(s.cross_check(err));
    CHECK(err.find("铁律 4") != std::string::npos);

    // 站点接收带宽不得大于采样率。
    s = base;
    s.sites[0].receiver.bw_Hz = s.sites[0].receiver.fs_Hz * 2.0;
    CHECK_FALSE(s.cross_check(err));
}

TEST_CASE("场景运行时：无 tx 活动时恒发射；有活动时首个 tx_on 之前不发射") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));

    geo::EmitterRuntime rt;
    REQUIRE(rt.build(s.scenario, "uav-1", err));
    CHECK_FALSE(rt.tx_on_at(0.0));    // demo 的 tx_on 在 t = 3 s
    CHECK_FALSE(rt.tx_on_at(2.999));
    CHECK(rt.tx_on_at(3.0));
    CHECK(rt.tx_on_at(180.0));

    geo::Scenario no_tx = s.scenario;
    no_tx.activities.clear();
    geo::EmitterRuntime rt2;
    REQUIRE(rt2.build(no_tx, "uav-1", err));
    CHECK(rt2.tx_on_at(0.0));         // 无活动即自 t = 0 起持续发射
}

TEST_CASE("场景运行时：跳频按单值与序列两种形式改中心频率") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));

    geo::Scenario one = s.scenario;
    geo::Activity hop;
    hop.emitter_id = "uav-1";
    hop.t_s = 60.0;
    hop.event = geo::ActivityEvent::Hop;
    hop.has_center_Hz = true;
    hop.center_Hz = 2.46e9;
    one.activities.push_back(hop);
    geo::EmitterRuntime a;
    REQUIRE(a.build(one, "uav-1", err));
    CHECK(a.center_Hz_at(59.9) == doctest::Approx(2.4405e9));
    CHECK(a.center_Hz_at(60.0) == doctest::Approx(2.46e9));

    geo::Scenario seq = s.scenario;
    geo::Activity h2;
    h2.emitter_id = "uav-1";
    h2.t_s = 10.0;
    h2.event = geo::ActivityEvent::Hop;
    h2.sequence.push_back(2.41e9);
    h2.sequence.push_back(2.43e9);
    h2.dwell_s = 5.0;
    seq.activities.push_back(h2);
    geo::EmitterRuntime b;
    REQUIRE(b.build(seq, "uav-1", err));
    CHECK(b.center_Hz_at(12.0) == doctest::Approx(2.41e9));
    CHECK(b.center_Hz_at(17.0) == doctest::Approx(2.43e9));
    CHECK(b.center_Hz_at(22.0) == doctest::Approx(2.41e9));   // 按停留时长循环
}

TEST_CASE("链路帧：更新率越界被拒；帧边界按序号且不重不漏") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));

    geo::LinkFrameSource lf;
    CHECK_FALSE(lf.build(s.scenario, "site-1", "uav-1", 9.0, err));
    CHECK_FALSE(lf.build(s.scenario, "site-1", "uav-1", 101.0, err));
    REQUIRE(lf.build(s.scenario, "site-1", "uav-1", 20.0, err));
    CHECK(lf.link_id() == "site-1-uav-1");

    for (std::uint64_t k = 0; k < 50; ++k) {
        const geo::LinkFrameSource::Frame f = lf.frame(k);
        CHECK(f.index == k);
        // 生产与消费两侧必须用同一个表达式形式 k / R，不写成 k * (1/R)。
        CHECK(f.valid_from_s == static_cast<double>(k) / 20.0);
        CHECK(f.valid_to_s == static_cast<double>(k + 1) / 20.0);
        if (k > 0) CHECK(f.valid_from_s == lf.frame(k - 1).valid_to_s);
        CHECK(f.update_rate_Hz == 20.0);
        CHECK(f.line_of_sight);            // 首期平地假设恒真
        CHECK(f.valid);
    }
    CHECK(lf.frame_count(180.0) == 3600u);
}

TEST_CASE("链路帧：路损与多普勒符合示例场景的手算值，过顶处多普勒变号") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));
    geo::LinkFrameSource lf;
    REQUIRE(lf.build(s.scenario, "site-1", "uav-1", 20.0, err));

    // t = 0：斜距约 211 m，FSPL 约 86.7 dB（计划里逐时刻核算过）。
    const geo::LinkFrameSource::Frame f0 = lf.frame(0);
    CHECK(f0.distance_m == doctest::Approx(211.1).epsilon(0.01));
    CHECK(f0.path_loss_dB == doctest::Approx(86.69).epsilon(0.001));
    CHECK(f0.doppler_Hz > 0.0);            // 正在接近 → 观测频率上移 → 多普勒为正
    CHECK(f0.noise_floor_dBm_per_Hz == doctest::Approx(-168.0));

    // t = 180：斜距约 3037 m，FSPL 约 109.9 dB。
    const geo::LinkFrameSource::Frame fe = lf.frame(180 * 20);
    CHECK(fe.distance_m == doctest::Approx(3037.3).epsilon(0.01));
    CHECK(fe.path_loss_dB == doctest::Approx(109.85).epsilon(0.001));
    CHECK(fe.doppler_Hz < 0.0);            // 正在远离 → 多普勒为负

    // 全程衰落约 23 dB，这就是瀑布上要看到的那条渐暗的线。
    CHECK(fe.path_loss_dB - f0.path_loss_dB == doctest::Approx(23.16).epsilon(0.01));

    // 最近点在 t ≈ 15 s 附近，前后多普勒变号。
    CHECK(lf.frame(10 * 20).doppler_Hz > 0.0);
    CHECK(lf.frame(30 * 20).doppler_Hz < 0.0);
}

TEST_CASE("航迹黄金基准：同一时刻的位置与 tests/golden/scenario-track-demo-01.json 相符") {
    std::ifstream gf(repo("tests/golden/scenario-track-demo-01.json").c_str(), std::ios::binary);
    REQUIRE(gf.good());
    std::stringstream ss;
    ss << gf.rdbuf();
    const nlohmann::json g = nlohmann::json::parse(ss.str());
    CHECK(g["schema_version"] == "cuav-scenario-track/1");

    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));
    // 基准与场景文件必须配套：场景改了而基准没重生成，这里就红（铁律 10）。
    CHECK(g["scenario_sha256"].get<std::string>() == s.sha256);

    geo::EmitterRuntime rt;
    REQUIRE(rt.build(s.scenario, "uav-1", err));

    const double tol_deg = g["tolerance"]["position_deg"].get<double>();
    const double tol_alt = g["tolerance"]["alt_m"].get<double>();
    std::size_t checked = 0;
    for (const auto& smp : g["samples"]) {
        if (smp["id"].get<std::string>() != "uav-1") continue;
        const double t = smp["t_s"].get<double>();
        const geo::MotionState m = rt.motion_at(t);
        CHECK(std::fabs(m.position.lon_deg - smp["lon"].get<double>()) < tol_deg);
        CHECK(std::fabs(m.position.lat_deg - smp["lat"].get<double>()) < tol_deg);
        CHECK(std::fabs(m.position.alt_m - smp["alt_m"].get<double>()) < tol_alt);
        CHECK(rt.tx_on_at(t) == smp["tx_on"].get<bool>());
        ++checked;
    }
    CHECK(checked == g["sample_count"].get<std::size_t>());
    MESSAGE("航迹黄金基准逐点对拍：" << checked << " 个样点，容差 " << tol_deg << " 度");
}


TEST_CASE("航迹黄金基准：demo-03 三源三站与 tests/golden/scenario-track-demo-03.json 相符（D-053）") {
    std::ifstream gf(repo("tests/golden/scenario-track-demo-03.json").c_str(), std::ios::binary);
    REQUIRE(gf.good());
    std::stringstream ss;
    ss << gf.rdbuf();
    const nlohmann::json g = nlohmann::json::parse(ss.str());
    CHECK(g["schema_version"] == "cuav-scenario-track/1");

    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo("data/scene/beijing-yayuncun/scenarios/demo-03.scenario.json"), s, err));
    CHECK(g["scenario_sha256"].get<std::string>() == s.sha256);
    REQUIRE(s.scenario.sites.size() == 3);
    REQUIRE(s.scenario.emitters.size() == 3);
    REQUIRE_MESSAGE(s.scenario.cross_check(err), err);

    // 站钟：三个站各自的建模同步误差，site-3 是保持态且带固定钟差
    CHECK(s.scenario.sites[0].clock.has_clock);
    CHECK(s.scenario.sites[0].clock.sync_sigma_ns == doctest::Approx(3.0));
    CHECK(s.scenario.sites[2].clock.sync_state == geo::SyncState::Holdover);
    CHECK(s.scenario.sites[2].clock.bias_ns == doctest::Approx(20.0));
    // 各站必须同采样率同中心频率（多站的硬约束，11 报告 §6.5）
    for (std::size_t i = 1; i < s.scenario.sites.size(); ++i) {
        CHECK(s.scenario.sites[i].receiver.fs_Hz == s.scenario.sites[0].receiver.fs_Hz);
        CHECK(s.scenario.sites[i].receiver.center_Hz == s.scenario.sites[0].receiver.center_Hz);
    }
    // uav-1 与 uav-2 有意同频：同站同频多源的测向混叠靠它演示
    const geo::Emitter* e1 = s.scenario.find_emitter("uav-1");
    const geo::Emitter* e2 = s.scenario.find_emitter("uav-2");
    REQUIRE(e1 != nullptr);
    REQUIRE(e2 != nullptr);
    CHECK(e1->emission.center_Hz == e2->emission.center_Hz);
    CHECK(e1->emission.waveform.offset_Hz == doctest::Approx(e2->emission.waveform.offset_Hz));

    const double tol_deg = g["tolerance"]["position_deg"].get<double>();
    const double tol_alt = g["tolerance"]["alt_m"].get<double>();
    std::size_t checked = 0;
    for (const std::string id : {"uav-1", "uav-2", "uav-3"}) {
        geo::EmitterRuntime rt;
        REQUIRE_MESSAGE(rt.build(s.scenario, id, err), err);
        for (const auto& smp : g["samples"]) {
            if (smp["id"].get<std::string>() != id) continue;
            const double t = smp["t_s"].get<double>();
            const geo::MotionState m = rt.motion_at(t);
            CHECK(std::fabs(m.position.lon_deg - smp["lon"].get<double>()) < tol_deg);
            CHECK(std::fabs(m.position.lat_deg - smp["lat"].get<double>()) < tol_deg);
            CHECK(std::fabs(m.position.alt_m - smp["alt_m"].get<double>()) < tol_alt);
            CHECK(rt.tx_on_at(t) == smp["tx_on"].get<bool>());
            ++checked;
        }
    }
    CHECK(checked == g["sample_count"].get<std::size_t>());
    MESSAGE("demo-03 航迹黄金基准逐点对拍：" << checked << " 个样点（三个源），容差 " << tol_deg << " 度");
}

// ------------------------------------------------- C-1 新增字段（D-051）

TEST_CASE("场景：发射极化可缺省，给出时必须在五档之内（D-051）") {
    geo::Scenario s;
    std::string err;

    // 既有场景文件不写 polarization 也照旧合法，缺省 vertical
    nlohmann::json a = demo_json();
    REQUIRE_MESSAGE(parse_scenario(a, s, err), err);
    CHECK(s.emitters[0].emission.polarization == "vertical");

    for (const char* q : {"vertical", "horizontal", "slant45", "rhcp", "lhcp"}) {
        nlohmann::json b = demo_json();
        b["emitters"][0]["emission"]["polarization"] = q;
        REQUIRE_MESSAGE(parse_scenario(b, s, err), err);
        CHECK(s.emitters[0].emission.polarization == q);
    }

    nlohmann::json c = demo_json();
    c["emitters"][0]["emission"]["polarization"] = "circular";
    CHECK_FALSE(parse_scenario(c, s, err));
    CHECK(err.find("polarization") != std::string::npos);

    // 站点天线方向图入库，供装载器注入天线组件的缺省
    nlohmann::json d = demo_json();
    REQUIRE_MESSAGE(parse_scenario(d, s, err), err);
    CHECK(s.sites[0].antenna.pattern == "omni");
}

TEST_CASE("场景：设备型号可缺省，给出时收下并原样保存（D-054）") {
    geo::Scenario s;
    std::string err;

    // 既有场景文件不写 equipment_model 仍合法，读出来是空串（不拿默认值顶替，铁律 15）
    nlohmann::json a = demo_json();
    REQUIRE_MESSAGE(parse_scenario(a, s, err), err);
    CHECK(s.sites[0].equipment_model.empty());
    CHECK(s.emitters[0].equipment_model.empty());

    // 给出时逐字保存。引擎不解释它，只是不静默丢弃
    nlohmann::json b = demo_json();
    b["sites"][0]["equipment_model"] = "宽带站-A";
    b["emitters"][0]["equipment_model"] = "DJI-Mavic3";
    REQUIRE_MESSAGE(parse_scenario(b, s, err), err);
    CHECK(s.sites[0].equipment_model == "宽带站-A");
    CHECK(s.emitters[0].equipment_model == "DJI-Mavic3");

    // 类型写错不放行：静默忽略会让用户以为型号设上了
    nlohmann::json c = demo_json();
    c["sites"][0]["equipment_model"] = 7;
    CHECK_FALSE(parse_scenario(c, s, err));
    CHECK(err.find("equipment_model") != std::string::npos);
}

TEST_CASE("场景：站钟可缺省，缺省时 has_clock 为假（D-053）") {
    geo::Scenario s;
    std::string err;

    // 既有场景文件不写 clock 照旧合法；has_clock 保持假，TDOA 组件据此报错而不是假定完美时钟
    nlohmann::json a = demo_json();
    REQUIRE_MESSAGE(parse_scenario(a, s, err), err);
    CHECK_FALSE(s.sites[0].clock.has_clock);
    CHECK(s.sites[0].clock.sync_sigma_ns == 0.0);

    // 全字段
    nlohmann::json b = demo_json();
    b["sites"][0]["clock"] = {{"sync_sigma_ns", 3.0}, {"bias_ns", 20.0}, {"rx_delay_ns", 12.5},
                              {"rx_delay_sigma_ns", 0.5}, {"sync_state", "holdover"}};
    REQUIRE_MESSAGE(parse_scenario(b, s, err), err);
    CHECK(s.sites[0].clock.has_clock);
    CHECK(s.sites[0].clock.sync_sigma_ns == doctest::Approx(3.0));
    CHECK(s.sites[0].clock.bias_ns == doctest::Approx(20.0));
    CHECK(s.sites[0].clock.rx_delay_ns == doctest::Approx(12.5));
    CHECK(s.sites[0].clock.sync_state == geo::SyncState::Holdover);
    CHECK(std::string(geo::to_string(s.sites[0].clock.sync_state)) == "holdover");

    // 只给必填项，同步态缺省 locked
    nlohmann::json c = demo_json();
    c["sites"][0]["clock"] = {{"sync_sigma_ns", 5.0}};
    REQUIRE_MESSAGE(parse_scenario(c, s, err), err);
    CHECK(s.sites[0].clock.has_clock);
    CHECK(s.sites[0].clock.sync_state == geo::SyncState::Locked);
}

TEST_CASE("场景：站钟的非法取值被拒，报文点名字段（D-053）") {
    geo::Scenario s;
    std::string err;

    nlohmann::json a = demo_json();
    a["sites"][0]["clock"] = {{"sync_sigma_ns", -1.0}};
    CHECK_FALSE(parse_scenario(a, s, err));
    CHECK(err.find("sync_sigma_ns") != std::string::npos);

    nlohmann::json b = demo_json();
    b["sites"][0]["clock"] = {{"sync_sigma_ns", 3.0}, {"sync_state", "free_running"}};
    CHECK_FALSE(parse_scenario(b, s, err));
    CHECK(err.find("sync_state") != std::string::npos);

    // 未知键一律拒绝（与场景其余部分同一口径）
    nlohmann::json c = demo_json();
    c["sites"][0]["clock"] = {{"sync_sigma_ns", 3.0}, {"drift_ppb", 1.0}};
    CHECK_FALSE(parse_scenario(c, s, err));
    CHECK(err.find("drift_ppb") != std::string::npos);

    // sync_sigma_ns 是必填
    nlohmann::json d = demo_json();
    d["sites"][0]["clock"] = nlohmann::json::object();
    CHECK_FALSE(parse_scenario(d, s, err));
}

TEST_CASE("场景：多站不再被拒（D-053 替换了单站守卫），跨引用照常校验") {
    geo::Scenario s;
    std::string err;
    nlohmann::json a = demo_json();
    nlohmann::json second = a["sites"][0];
    second["id"] = "site-2";
    second["name"] = "第二站";
    second["position"]["lon"] = a["sites"][0]["position"]["lon"].get<double>() + 0.02;
    a["sites"].push_back(second);
    REQUIRE_MESSAGE(parse_scenario(a, s, err), err);
    CHECK(s.sites.size() == 2);
    CHECK(s.find_site("site-2") != nullptr);
    REQUIRE_MESSAGE(s.cross_check(err), err);

    // 站点标识仍必须唯一
    nlohmann::json b = a;
    b["sites"][1]["id"] = "site-1";
    geo::Scenario t;
    REQUIRE(parse_scenario(b, t, err));
    CHECK_FALSE(t.cross_check(err));
}

TEST_CASE("链路帧：离开角与到达角各算各的，不是互为反方位（D-051）") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));
    geo::LinkFrameSource lf;
    REQUIRE(lf.build(s.scenario, "site-1", "uav-1", 20.0, err));

    const geo::LinkFrameSource::Frame f = lf.frame(0);
    // t = 0：辐射源在站点西南、比站点高 20 m。站点朝它看是西南向、仰角为正；
    // 它朝站点看是东北向、俯角为负。
    CHECK(f.azimuth_deg > 180.0);
    CHECK(f.azimuth_deg < 270.0);
    CHECK(f.elevation_deg > 0.0);
    CHECK(f.aod_azimuth_deg > 0.0);
    CHECK(f.aod_azimuth_deg < 90.0);
    CHECK(f.aod_elevation_deg < 0.0);

    // 方位近似互为反向（短基线上差得很小），但不得当作恒等式使用：
    // 这条断言的意义是「两者确实是同一条视线的两端」，而不是「可以由一端取反推出另一端」。
    const double back = f.azimuth_deg - 180.0;
    CHECK(f.aod_azimuth_deg == doctest::Approx(back).epsilon(0.001));
    // 俯仰不是简单取反：地球曲率使两端的俯仰角之和不为零。
    CHECK(f.aod_elevation_deg != doctest::Approx(-f.elevation_deg).epsilon(1e-9));

    // 发射活动与航向随帧走（供评价器取真值、供天线随航向指向）
    CHECK(lf.frame(0).tx_on == false);            // demo-01 在 t = 3 s 才 tx_on
    CHECK(lf.frame(10 * 20).tx_on == true);
    CHECK(lf.frame(0).heading_deg >= 0.0);
    CHECK(lf.frame(0).center_Hz == doctest::Approx(2440500000.0));
}

TEST_CASE("场景：圆形告警区可缺省，给出时收下不解释；坏值一律拒（D-061）") {
    geo::Scenario s;
    std::string err;

    // 既有场景文件不写 zones 仍合法，读出来是空表
    nlohmann::json a = demo_json();
    REQUIRE_MESSAGE(parse_scenario(a, s, err), err);
    CHECK(s.zones.empty());

    // 给出时逐字保存；alt_max_m 缺席即 has_alt_max 为假，不拿默认值顶替
    nlohmann::json b = demo_json();
    b["zones"] = nlohmann::json::array();
    b["zones"].push_back({{"id", "z-1"}, {"name", "核心区"}, {"kind", "alert"}, {"shape", "circle"},
                          {"center", {{"lon", 116.405}, {"lat", 39.99}}}, {"radius_m", 500.0}, {"alt_max_m", 300.0}});
    b["zones"].push_back({{"id", "z-2"}, {"name", "外围"}, {"kind", "warning"}, {"shape", "circle"},
                          {"center", {{"lon", 116.41}, {"lat", 39.98}}}, {"radius_m", 1200.0}});
    REQUIRE_MESSAGE(parse_scenario(b, s, err), err);
    REQUIRE(s.zones.size() == 2);
    CHECK(s.zones[0].id == "z-1");
    CHECK(s.zones[0].kind == geo::ZoneKind::Alert);
    CHECK(s.zones[0].center_lon_deg == doctest::Approx(116.405));
    CHECK(s.zones[0].radius_m == doctest::Approx(500.0));
    CHECK(s.zones[0].has_alt_max);
    CHECK(s.zones[0].alt_max_m == doctest::Approx(300.0));
    CHECK(s.zones[1].kind == geo::ZoneKind::Warning);
    CHECK_FALSE(s.zones[1].has_alt_max);
    CHECK_MESSAGE(s.cross_check(err), err);

    // 坏值一律拒：未知档位、非圆、半径为零、未知键、重复标识
    auto bad = [&](std::function<void(nlohmann::json&)> mut, const char* what) {
        nlohmann::json c = b;
        mut(c);
        geo::Scenario t;
        std::string e;
        const bool ok = parse_scenario(c, t, e) && t.cross_check(e);
        CHECK_MESSAGE(!ok, what);
        // doctest 不拆 ||，先算成一个布尔
        const bool mentions = e.find("zones") != std::string::npos || e.find("告警区") != std::string::npos;
        CHECK_MESSAGE(mentions, what << " : " << e);
    };
    bad([](nlohmann::json& c) { c["zones"][0]["kind"] = "danger"; }, "未知档位");
    bad([](nlohmann::json& c) { c["zones"][0]["shape"] = "polygon"; }, "非圆");
    bad([](nlohmann::json& c) { c["zones"][0]["radius_m"] = 0.0; }, "半径为零");
    bad([](nlohmann::json& c) { c["zones"][0]["color"] = "#f00"; }, "未知键");
    bad([](nlohmann::json& c) { c["zones"][1]["id"] = "z-1"; }, "重复标识");
}

// --- 样点域活动时间线（G-6，D-069）--------------------------------------------

TEST_CASE("活动时间线（样点域）：停留序列按整数循环，子段边界落在整样点上") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));

    geo::Scenario sc = s.scenario;
    geo::Activity h;
    h.emitter_id = "uav-1";
    h.t_s = 1.0;
    h.event = geo::ActivityEvent::Hop;
    h.sequence.push_back(2.4400e9);
    h.sequence.push_back(2.4420e9);
    h.sequence.push_back(2.4410e9);
    h.dwell_s = 0.01;
    sc.activities.push_back(h);

    const double fs = 1.0e7;                       // 停留 0.01 s = 100000 样点
    geo::ActivitySchedule sch;
    REQUIRE(sch.build(sc, "uav-1", fs, err));
    CHECK(sch.has_hop());
    CHECK(sch.notes().empty());                    // 0.01 s 在 10 MS/s 下整除，没有取整落差

    const std::uint64_t n0 = geo::sample_at(1.0, fs);
    CHECK(n0 == 10000000u);
    CHECK(sch.center_Hz_at_sample(n0 - 1) == doctest::Approx(2.4405e9));   // 跳频之前取基频
    CHECK(sch.center_Hz_at_sample(n0) == doctest::Approx(2.4400e9));
    CHECK(sch.center_Hz_at_sample(n0 + 99999) == doctest::Approx(2.4400e9));
    CHECK(sch.center_Hz_at_sample(n0 + 100000) == doctest::Approx(2.4420e9));
    CHECK(sch.center_Hz_at_sample(n0 + 200000) == doctest::Approx(2.4410e9));
    CHECK(sch.center_Hz_at_sample(n0 + 300000) == doctest::Approx(2.4400e9));   // 循环回第一项

    // 边界查询：段末最后一个样点问出来的下一次变化就是段末
    CHECK(sch.next_change_sample(n0) == n0 + 100000);
    CHECK(sch.next_change_sample(n0 + 99999) == n0 + 100000);
    CHECK(sch.next_change_sample(n0 + 100000) == n0 + 200000);

    const geo::ActivitySchedule::Segment seg = sch.segment_at(n0 + 50000);
    CHECK(seg.begin == n0 + 50000);
    CHECK(seg.end == n0 + 100000);
    CHECK_FALSE(seg.tx_on);                        // demo-01 的 tx_on 在 t = 3 s，此刻（约 1.005 s）还没开
    CHECK(seg.center_Hz == doctest::Approx(2.4400e9));
}

TEST_CASE("活动时间线（样点域）：与 EmitterRuntime 的双精度版稠密对拍，例外只在事件边界") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));

    geo::Scenario sc = s.scenario;                 // demo-01 自带 tx_on@3 s
    geo::Activity h;
    h.emitter_id = "uav-1";
    h.t_s = 2.0;
    h.event = geo::ActivityEvent::Hop;
    h.sequence.push_back(2.4400e9);
    h.sequence.push_back(2.4420e9);
    h.dwell_s = 0.5;
    sc.activities.push_back(h);
    geo::Activity off;
    off.emitter_id = "uav-1";
    off.t_s = 4.0;
    off.event = geo::ActivityEvent::TxOff;
    sc.activities.push_back(off);

    const double fs = 100000.0;                    // 对拍跑 5 s = 500000 个样点，够密也跑得动
    geo::ActivitySchedule sch;
    REQUIRE(sch.build(sc, "uav-1", fs, err));
    geo::EmitterRuntime rt;
    REQUIRE(rt.build(sc, "uav-1", err));

    // 事件折出的样点：tx_on@3、tx_off@4，以及 hop 序列自 t=2 起每 0.5 s 一次直到 5 s
    std::size_t diffs = 0;
    for (std::uint64_t n = 0; n < 500000; ++n) {
        const double t = static_cast<double>(n) / fs;
        const bool same_tx = sch.tx_on_at_sample(n) == rt.tx_on_at(t);
        const bool same_f = sch.center_Hz_at_sample(n) == rt.center_Hz_at(t);
        if (!same_tx || !same_f) ++diffs;
    }
    // 两域的取整方向不同（样点域四舍五入、时间域直接比大小），差异只可能落在事件边界上，
    // 每个边界至多一个样点。本夹具的边界数 = 2 个开关 + 6 次跳频 = 8。
    CHECK(diffs <= 8u);
}

TEST_CASE("活动时间线（样点域）：三条铁律 15 的闸——亚样点停留、开关同样点、跳频同样点") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));

    {   // ① 停留折出 0 个样点
        geo::Scenario sc = s.scenario;
        geo::Activity h;
        h.emitter_id = "uav-1";
        h.t_s = 1.0;
        h.event = geo::ActivityEvent::Hop;
        h.sequence.push_back(2.44e9);
        h.sequence.push_back(2.45e9);
        h.dwell_s = 1e-7;                          // 500 kS/s 下是 0.05 个样点
        sc.activities.push_back(h);
        geo::ActivitySchedule sch;
        std::string e;
        CHECK_FALSE(sch.build(sc, "uav-1", 500000.0, e));
        CHECK(e.find("折出 0 个样点") != std::string::npos);
        CHECK(e.find("铁律 15") != std::string::npos);
    }
    {   // ② 两个状态相反的开关活动折到同一样点
        geo::Scenario sc = s.scenario;
        geo::Activity off;
        off.emitter_id = "uav-1";
        off.t_s = 3.0000001;                       // 与自带的 tx_on@3 在 500 kS/s 下同一个样点
        off.event = geo::ActivityEvent::TxOff;
        sc.activities.push_back(off);
        geo::ActivitySchedule sch;
        std::string e;
        CHECK_FALSE(sch.build(sc, "uav-1", 500000.0, e));
        CHECK(e.find("都折到样点") != std::string::npos);
    }
    {   // ③ 两条跳频活动折到同一样点
        geo::Scenario sc = s.scenario;
        for (int k = 0; k < 2; ++k) {
            geo::Activity h;
            h.emitter_id = "uav-1";
            h.t_s = 5.0 + k * 1e-7;
            h.event = geo::ActivityEvent::Hop;
            h.has_center_Hz = true;
            h.center_Hz = 2.44e9 + k * 1e6;
            sc.activities.push_back(h);
        }
        geo::ActivitySchedule sch;
        std::string e;
        CHECK_FALSE(sch.build(sc, "uav-1", 500000.0, e));
        CHECK(e.find("前一个跳频点一个样点都用不上") != std::string::npos);
    }
}

TEST_CASE("活动时间线（样点域）：全部中心频点集合供铁律 4 的闸用，升序去重并带出处") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));

    // 无 hop 时只有基频
    std::vector<geo::CenterPoint> one = geo::emitter_center_set(s.scenario, "uav-1");
    REQUIRE(one.size() == 1u);
    CHECK(one[0].Hz == doctest::Approx(2.4405e9));
    CHECK(one[0].where == "emission.center_Hz");

    geo::Scenario sc = s.scenario;
    geo::Activity h;
    h.emitter_id = "uav-1";
    h.t_s = 1.0;
    h.event = geo::ActivityEvent::Hop;
    h.sequence.push_back(2.4430e9);
    h.sequence.push_back(2.4390e9);
    h.sequence.push_back(2.4405e9);                // 与基频同频，应当被去重
    h.dwell_s = 0.01;
    sc.activities.push_back(h);

    std::vector<geo::CenterPoint> all = geo::emitter_center_set(sc, "uav-1");
    REQUIRE(all.size() == 3u);
    CHECK(all[0].Hz == doctest::Approx(2.4390e9));
    CHECK(all[1].Hz == doctest::Approx(2.4405e9));
    CHECK(all[2].Hz == doctest::Approx(2.4430e9));
    CHECK(all[0].where.find("sequence[1]") != std::string::npos);
    CHECK(all[1].where == "emission.center_Hz");   // 同频保留第一个出处（基频在前）
}

TEST_CASE("场景：铁律 4 的闸覆盖跳频点——序列里有一跳出界即拒，报文带出处（G-6，D-069）") {
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo), s, err));
    // demo-01：站点 fs 500 kHz、center 2440.5 MHz，辐射源 bw 400 kHz、频偏 48828.125 Hz。
    // 基频过得了闸（48828 + 200000 < 250000），把一个跳频点推到 100 kHz 外就过不了。
    geo::Scenario sc = s.scenario;
    geo::Activity h;
    h.emitter_id = "uav-1";
    h.t_s = 70.0;                                  // 排在 demo-01 最后一条活动（t = 68）之后
    h.event = geo::ActivityEvent::Hop;
    h.sequence.push_back(2.4405e9);                // 这一跳没问题
    h.sequence.push_back(2.4406e9);                // 这一跳把 |Δf| 推到 148828 Hz，加半带宽越界
    h.dwell_s = 0.01;
    sc.activities.push_back(h);

    std::string e;
    CHECK_FALSE(sc.cross_check(e));
    CHECK(e.find("跳频点") != std::string::npos);
    CHECK(e.find("sequence[1]") != std::string::npos);
    CHECK(e.find("铁律 4") != std::string::npos);

    // 基频自己越界时报文与改动前逐字相同（既有夹具靠它）
    geo::Scenario bad = s.scenario;
    bad.emitters[0].emission.center_Hz = 2.4408e9;
    std::string e2;
    CHECK_FALSE(bad.cross_check(e2));
    CHECK(e2 == "辐射源 uav-1 相对站点 site-1 的频偏加半带宽不小于采样率的一半，"
                "违反 |Δf| + B/2 < Fs/2（铁律 4）");
}

TEST_CASE("航迹黄金基准：demo-02 宽带双源与 tests/golden/scenario-track-demo-02.json 相符（C-8）") {
    std::ifstream gf(repo("tests/golden/scenario-track-demo-02.json").c_str(), std::ios::binary);
    REQUIRE(gf.good());
    std::stringstream ss;
    ss << gf.rdbuf();
    nlohmann::json g = nlohmann::json::parse(ss.str());

    const char* kDemo02 = "data/scene/beijing-yayuncun/scenarios/demo-02.scenario.json";
    LoadedScenario s;
    std::string err;
    REQUIRE(load_scenario_file(repo(kDemo02), s, err));
    CHECK(s.sha256 == g["scenario_sha256"].get<std::string>());

    // 宽带配置：10 MS/s、8 MHz 接收带宽、两个源在频率上不重叠
    REQUIRE(s.scenario.sites.size() == 1u);
    CHECK(s.scenario.sites[0].receiver.fs_Hz == doctest::Approx(1.0e7));
    CHECK(s.scenario.sites[0].receiver.bw_Hz == doctest::Approx(8.0e6));
    const geo::Emitter* video = s.scenario.find_emitter("uav-1");
    const geo::Emitter* rc = s.scenario.find_emitter("uav-2");
    REQUIRE(video != nullptr);
    REQUIRE(rc != nullptr);
    CHECK(video->emission.waveform.type == geo::WaveformType::Noise);
    CHECK(video->emission.bw_Hz == doctest::Approx(2.0e6));
    CHECK(rc->emission.waveform.type == geo::WaveformType::Burst);

    // 跳频序列：五个频点、相邻差都不小于模板库要求的 200 kHz，且全部在观测带内
    const std::vector<geo::CenterPoint> centers = geo::emitter_center_set(s.scenario, "uav-2");
    REQUIRE(centers.size() == 6u);        // 基频 + 五个跳频点
    for (std::size_t i = 0; i < centers.size(); ++i) {
        const double df = std::fabs(centers[i].Hz - s.scenario.sites[0].receiver.center_Hz);
        CHECK(df + rc->emission.bw_Hz / 2.0 < s.scenario.sites[0].receiver.fs_Hz / 2.0);
    }
    // 序列里相邻两跳（含绕回）的频差
    geo::ActivitySchedule sch;
    REQUIRE(sch.build(s.scenario, "uav-2", 1.0e7, err));
    CHECK(sch.has_hop());
    const std::uint64_t dwell_n = 100000;              // 0.01 s × 10 MS/s
    double prev = sch.center_Hz_at_sample(0);
    for (int k = 1; k <= 5; ++k) {
        const double now = sch.center_Hz_at_sample(static_cast<std::uint64_t>(k) * dwell_n);
        CHECK_MESSAGE(std::fabs(now - prev) >= 200e3,
                      "第 " << k << " 跳只差 " << std::fabs(now - prev) << " Hz，模板库要求 ≥ 200 kHz");
        prev = now;
    }
    // 停留与突发周期相等 → 一跳一个突发，跳不到突发中间
    CHECK(dwell_n == static_cast<std::uint64_t>(rc->emission.waveform.period_s * 1.0e7 + 0.5));

    const double tol_deg = g["tolerance"]["position_deg"].get<double>();
    const double tol_alt = g["tolerance"]["alt_m"].get<double>();
    std::size_t checked = 0;
    for (const std::string id : {"uav-1", "uav-2"}) {
        geo::EmitterRuntime rt;
        REQUIRE_MESSAGE(rt.build(s.scenario, id, err), err);
        for (const auto& smp : g["samples"]) {
            if (smp["id"].get<std::string>() != id) continue;
            const double t = smp["t_s"].get<double>();
            const geo::MotionState m = rt.motion_at(t);
            CHECK(std::fabs(m.position.lon_deg - smp["lon"].get<double>()) < tol_deg);
            CHECK(std::fabs(m.position.lat_deg - smp["lat"].get<double>()) < tol_deg);
            CHECK(std::fabs(m.position.alt_m - smp["alt_m"].get<double>()) < tol_alt);
            CHECK(rt.tx_on_at(t) == smp["tx_on"].get<bool>());
            ++checked;
        }
    }
    CHECK(checked == g["sample_count"].get<std::size_t>());
}
