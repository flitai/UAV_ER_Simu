// 活动时间线的**样点域**时间表（G-6；docs/scenario-format.md §6；决策 D-069）。
//
// 与 EmitterRuntime::tx_on_at(double) / center_Hz_at(double) 是**两个域，并存不替换**：
//
//   · EmitterRuntime 的那两个函数服务**帧域与航迹域** —— 参数帧按 1/update_rate 取值
//     （geo/src/scenario.cpp 的 LinkFrameSource::frame）、航迹事件按 --track-rate 取值。
//     它们一个字符都不动，于是 tests/golden/scenario-track-demo-0*.json 逐点逐位不变。
//   · 本类服务**波形域与真值域** —— SceneEmitterSource 按它生成 IQ、Evaluator 按它记真值。
//     遥控跳频的停留在 1–20 ms 量级，块（缺省 65536 样点）与帧（20–100 Hz）都表达不了它，
//     只有绝对样点号够细。两边共用本类，于是「源怎么发的」与「真值怎么记的」逐位同源。
//
// 两域在事件时刻上必然差不超过一个样点（取整方向不同），由 engine/tests/test_scenario.cpp
// 的稠密对拍用例钉住：例外只许落在事件边界，且每处不超过 1 个样点。
//
// **硬不变量**：build() 之后全部查询都是 const 纯函数，无游标、无缓存。
// 可以任意乱序、任意次数调用，结果逐位相同 —— 源是顺序访问、评价器是乱序访问，
// 共用一个实例语义才安全（与 LinkFrameSource::frame 立的是同一条约束）。
//
// 纯函数、无第三方依赖，因此 geo/ 仍可独立构建。

#ifndef CUAV_GEO_ACTIVITY_H
#define CUAV_GEO_ACTIVITY_H

#include <cstdint>
#include <string>
#include <vector>

namespace cuav {
namespace geo {

struct Scenario;

// 时刻 → 样点序号。**全仓只有这一处定义**：四舍五入到最近样点，与 SceneEmitterSource
// 折 burst 图案的算式同式（engine/src/scenario.cpp 的 burst_period_n_）。源与评价器都调它，
// 于是两边不可能各 round 各的。t_s < 0 由 schema 的 minimum: 0 挡掉，这里按 0 处理。
std::uint64_t sample_at(double t_s, double fs_Hz);

// 一个中心频点及其出处。出处只在报错时用（铁律 15：说得出是哪条活动的哪一项）。
struct CenterPoint {
    double Hz;
    std::string where;            // 如 "emission.center_Hz" 或 "activities[6].args.sequence[3]"
    CenterPoint() : Hz(0.0) {}
    CenterPoint(double hz, const std::string& w) : Hz(hz), where(w) {}
};

// 某辐射源可能用到的全部中心频点：基频 + 每条 hop 活动的 center_Hz 或 sequence[]。
// 按频率升序、去重（同频保留第一个出处）。铁律 4 的三道闸共用它作唯一口径。
// 不需要 fs，因此 Scenario::cross_check 也能调（那里拿不到采样率，也不该拿）。
std::vector<CenterPoint> emitter_center_set(const Scenario& s, const std::string& emitter_id);

class ActivitySchedule {
public:
    // 到流末尾都不再变。用 UINT64_MAX 而不是 0 或 -1：调用方拿它去 min() 就直接对。
    static const std::uint64_t kNoChange;

    // 「同频同开关」的极大子段。调用方主用 segment_at()：拿到一段就能整段按同一个
    // 频偏与同一个开关状态推进，热循环里不必逐样点查表。
    struct Segment {
        std::uint64_t begin;      // = 查询点（子段自查询点起算，不回溯到真正的段首）
        std::uint64_t end;        // > begin，下一次变化处；kNoChange 表示永不变
        bool tx_on;
        double center_Hz;
        Segment() : begin(0), end(kNoChange), tx_on(true), center_Hz(0.0) {}
    };

    ActivitySchedule();

    // fs_Hz 必须为正。三条铁律 15 的闸在这里报错（不静默夹到 1 个样点）：
    //   ① 跳频停留折出 0 个样点（亚样点停留）；
    //   ② 两个状态相反的开关事件折到同一个样点（中间那段发射会整个消失）；
    //   ③ 两条 hop 活动折到同一个样点（前一个跳频点一个样点都用不上）。
    bool build(const Scenario& s, const std::string& emitter_id, double fs_Hz, std::string& err);

    bool tx_on_at_sample(std::uint64_t n) const;
    double center_Hz_at_sample(std::uint64_t n) const;
    std::uint64_t next_change_sample(std::uint64_t n) const;   // 最小的 m > n 使状态或频点变
    Segment segment_at(std::uint64_t n) const;

    bool has_hop() const { return !hops_.empty(); }
    double fs_Hz() const { return fs_Hz_; }
    const std::string& emitter_id() const { return id_; }

    // 取整落差之类的说明。不报错、但也不静默（调用方转进组件的 status_.notes）。
    const std::vector<std::string>& notes() const { return notes_; }

private:
    struct Hop {
        std::uint64_t start_n;
        std::vector<double> sequence;   // 单值形式即长度 1
        std::uint64_t dwell_n;          // 0 表示不循环（单值形式）
        Hop() : start_n(0), dwell_n(0) {}
    };

    std::string id_;
    double fs_Hz_;
    double base_center_Hz_;
    bool has_tx_events_;
    std::vector<std::uint64_t> tx_n_;   // 升序
    std::vector<char> tx_state_;
    std::vector<Hop> hops_;             // 按 start_n 升序
    std::vector<std::string> notes_;
};

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_ACTIVITY_H
