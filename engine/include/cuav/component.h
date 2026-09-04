// 组件接口与端口数据。
//
// 依据：04 §8.4「模型组件规范」的生命周期 init / configure / process / flush /
// reset / status / destroy；03 §11.6 端口；CLAUDE.md 铁律 8、9、15；决策 D-013。
//
// 设计取舍写在这里，免得日后靠猜：
// - 组件不许自带随机源，随机性由 run 时注入的 IRandom& 提供（铁律 9）。
// - 组件不许假设块大小固定，块大小由调度器决定，组件按到手的块长处理。
// - 组件不许静默降级：处理不了就把块标 Degraded / Invalid 并写明理由，不拿默认值顶替（铁律 15）。

#ifndef CUAV_COMPONENT_H
#define CUAV_COMPONENT_H

#include <map>
#include <string>
#include <vector>

#include "cuav/random.h"
#include "cuav/types.h"

namespace cuav {

// 一次能量判决的结果。
struct Detection {
    std::uint64_t start_sample = 0;   // 判决所用第一帧的首样点
    std::uint64_t frame_index = 0;
    double statistic = 0.0;           // 归一化检测量 Λ，H0 下均值为 1
    double threshold = 0.0;           // 所用门限 η
    bool hit = false;
};

struct DetectionList {
    std::vector<Detection> items;
    BlockMeta meta;
};

struct SpectrumFrame {
    std::vector<float> psd_dB;
    double bin_width_Hz = 0.0;
    BlockMeta meta;
};

// 端口上流动的数据。C++14 没有 variant，这里用带标志的聚合体，够用且不引依赖。
struct PortData {
    PortType type = PortType::IQStream;
    bool has_data = false;
    Block iq;
    DetectionList detections;
    SpectrumFrame spectrum;
    SceneParamFrame scene;

    void clear() {
        has_data = false;
        iq.samples.clear();
        detections.items.clear();
        spectrum.psd_dB.clear();
    }
};

using PortMap = std::map<std::string, PortData>;

struct PortSpec {
    std::string name;
    PortType type;
};

// 一次 process 的结果。
enum class Step {
    Produced = 0,   // 产出了数据
    Idle,           // 本轮没产出，但还没结束（例如攒够一帧才输出）
    Finished,       // 数据源耗尽，本组件不再产出
    Error,
};

struct ComponentStatus {
    State state = State::Valid;
    std::uint64_t blocks_in = 0;
    std::uint64_t blocks_out = 0;
    std::uint64_t samples_in = 0;
    std::uint64_t samples_out = 0;
    std::vector<std::string> notes;
};

class IComponent {
public:
    virtual ~IComponent() {}

    virtual std::string type_name() const = 0;
    virtual std::vector<PortSpec> inputs() const = 0;
    virtual std::vector<PortSpec> outputs() const = 0;

    // 参数配置。失败必须写 err 并返回 false，不得吞掉。
    virtual bool configure(const std::map<std::string, double>& params,
                           const std::map<std::string, std::string>& text_params,
                           std::string& err) = 0;

    // 运行前初始化。随机性由此注入（铁律 9）。
    virtual bool init(IRandom& rng, std::string& err) = 0;

    virtual Step process(PortMap& in, PortMap& out, std::string& err) = 0;

    // 收尾：把攒着的不满一帧的数据吐出来或丢弃并标记。
    virtual Step flush(PortMap& out, std::string& err) {
        (void)out; (void)err;
        return Step::Finished;
    }

    virtual void reset() = 0;
    virtual ComponentStatus status() const = 0;
};

}  // namespace cuav

#endif  // CUAV_COMPONENT_H
