// 航线运动学：航点插值、悬停、航向与速度。
//
// 依据：docs/scenario-format.md §5（运动学语义五条，已冻结）；决策 D-033（运动学在 geo/，
// 参数帧按样点序号推进）；CLAUDE.md 铁律 9（固定种子逐位复现）、铁律 1（方位真北顺时针）。
//
// **按绝对时间闭式求值，不做增量积分。** 语义参照 em-demo simulation/engine.ts 的 moveAlongPlan
// 并用 C++ 重写，但**有意偏离**它的实现方式：那边是 `segmentProgress += speed·dt/segLen` 的增量
// 积分，结果与调用步长 dt 耦合——引擎里 dt 由块长决定，换块长就换结果，「同种子逐字节复现」
// 立刻失守。这里改成先累加出段时轴、再对绝对时刻二分定位并闭式插值，`state_at(t)` 是纯函数：
// 调多少次、按什么顺序调、隔多大步长调，结果都逐位相同。偏离写进 08 报告 §9。
//
// 另一处与 em-demo 的差别：那边的 moveAlongPlan 恒循环（`(idx+1) % n`），本项目按
// docs/scenario-format.md §5 的 `loop` 字段，缺省是到末航点停住。

#ifndef CUAV_GEO_KINEMATICS_H
#define CUAV_GEO_KINEMATICS_H

#include <cstddef>
#include <string>
#include <vector>

#include "cuav_geo/geodesy.h"

namespace cuav {
namespace geo {

struct Waypoint {
    Lla position;
    double speed_mps;    // 段速度取该段**起点**航点的值（§5 第 2 条）
    double loiter_s;     // 到达本航点后悬停该时长，位置与航向不变（§5 第 3 条）

    Waypoint() : speed_mps(0.0), loiter_s(0.0) {}
};

struct MotionState {
    double t_s;
    Lla position;
    double heading_deg;   // 真北顺时针；悬停与终点保持进入时的航向
    double speed_mps;     // 悬停与终点为 0
    Ecef velocity;        // m/s，地固系（不含地球自转）；悬停与终点为零矢量
    bool moving;

    MotionState() : t_s(0.0), heading_deg(0.0), speed_mps(0.0), moving(false) {}
};

// 已预算的航线。build() 一次性累加「段长 / 段起点速度 + 悬停」得到段时轴，
// state_at() 对时轴二分后闭式插值，O(log n)，与调用顺序、次数、步长完全无关。
class Route {
public:
    Route();

    // 失败写 err 返回 false：航点为空、速度非正、悬停为负。
    bool build(const std::vector<Waypoint>& waypoints, bool loop, std::string& err);

    std::size_t waypoint_count() const { return waypoint_count_; }
    bool looping() const { return loop_; }
    // loop 时是一圈时长；否则是走完全程（含途中悬停）的时刻。
    double cycle_duration_s() const { return cycle_s_; }
    double total_length_m() const { return length_m_; }

    // 绝对时间闭式求值。t < 0 视为 0；loop = false 且 t 超出全程时停在末航点（speed = 0）。
    MotionState state_at(double t_s) const;

private:
    struct Leg {
        Lla from, to;
        Ecef from_ecef, to_ecef;
        double length_m;
        double speed_mps;
        double travel_s;
        double heading_deg;
        Ecef velocity;      // (to_ecef − from_ecef) / travel_s，模长恰等于 speed_mps
        Leg() : length_m(0.0), speed_mps(0.0), travel_s(0.0), heading_deg(0.0) {}
    };
    // 一个时间片：行进（moving = true，属 leg[i]）或悬停（moving = false，停在 leg[i].to）。
    struct Phase {
        double t0, t1;
        std::size_t leg;
        bool moving;
        Phase() : t0(0.0), t1(0.0), leg(0), moving(false) {}
    };

    std::vector<Leg> legs_;
    std::vector<Phase> phases_;
    bool loop_;
    double cycle_s_;
    double length_m_;
    std::size_t waypoint_count_;
    Lla single_;                 // 只有一个航点（或全部航点重合）时的静止位置
    double final_heading_deg_;

    MotionState still_at(const Lla& p, double heading_deg, double t_s) const;
};

}  // namespace geo
}  // namespace cuav

#endif  // CUAV_GEO_KINEMATICS_H
