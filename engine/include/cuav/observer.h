// 运行观察者（06 备忘录 §9A B-3）。引擎把进度、实体状态、链路读数、日志与显示产品行
// 经回调交给运行器（cuav_run，B-4），运行器再转成 stdout JSON 事件与文件。
//
// 为什么用回调而不是端口：这些都不是数据流（04 §8.3「将运行状态、日志摘要和降采样显示产品
// 发布给应用服务」），实体状态与链路读数按决策 D-033 也不做端口类型。
// 观察者是可选的：Graph::run 不带观察者时行为不变。

#ifndef CUAV_OBSERVER_H
#define CUAV_OBSERVER_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "cuav/component.h"

namespace cuav {

struct ProgressInfo {
    std::uint64_t round = 0;
    std::vector<std::string> node_names;
    std::vector<ComponentStatus> node_status;
};

// 实体状态与链路读数的结构见 docs/scenario-format.md §7 与 docs/api-versions.md §4（link 事件）。
struct EntityState {
    double t_s = 0.0;
    std::string id;
    double lon = 0.0, lat = 0.0, alt_m = 0.0;
    double heading_deg = 0.0, speed_mps = 0.0;
    bool tx_on = true;
    double center_Hz = 0.0;
};

struct LinkFrame {
    std::string link_id;
    double t_s = 0.0;
    bool line_of_sight = true;
    double distance_m = 0.0, azimuth_deg = 0.0, elevation_deg = 0.0;
    double path_loss_dB = 0.0, delay_s = 0.0, doppler_Hz = 0.0;
    double valid_from_s = 0.0, valid_to_s = 0.0, update_rate_Hz = 0.0;
    State state = State::Valid;
};

class IRunObserver {
public:
    virtual ~IRunObserver() {}
    virtual void on_progress(const ProgressInfo&) {}
    virtual void on_entity(const EntityState&) {}
    virtual void on_link(const LinkFrame&) {}
    virtual void on_log(const std::string& level, const std::string& message) { (void)level; (void)message; }
    // 一行显示产品：kind ∈ {spectrum, envelope}；row 为 float32，len 个元素；t_s 为该行首样点的逻辑时间。
    virtual void on_product_row(const std::string& op_id, const std::string& kind, std::uint64_t row_index,
                                const float* row, std::size_t len, double t_s) {
        (void)op_id; (void)kind; (void)row_index; (void)row; (void)len; (void)t_s;
    }
};

}  // namespace cuav

#endif  // CUAV_OBSERVER_H
