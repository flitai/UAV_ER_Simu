// 场景文件读取、SHA-256 与航迹黄金基准（06 备忘录 §9C G-0 / G-1）。

#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

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

    nlohmann::json c = demo_json();
    c["emitters"][0]["emission"]["waveform"] = nlohmann::json{{"type", "noise"}, {"offset_Hz", 0.0}};
    CHECK_FALSE(parse_scenario(c, s, err));   // noise 不带 offset_Hz

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
