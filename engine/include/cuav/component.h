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
#include "cuav/param_spec.h"
#include "cuav/types.h"

namespace cuav {

class IRunObserver;   // observer.h

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

// 一帧功率谱（P1-4a）。口径：Welch 平均的功率谱（不是密度），每段加窗、|DFT|²、各段平均、
// 除以 (Σw)²，零频居中；复单音峰值等于其功率 A²，满量程单音读 0 dBFS。
// 值用 double：显示产品落盘时再转 float32，但帧本身要能与 MATLAB / numpy 对到 1e-9。
struct SpectrumFrame {
    std::vector<double> psd_dB;
    double bin_width_Hz = 0.0;
    std::uint64_t segments = 0;       // 本帧平均了几段
    std::string scale = "dBFS";       // 未标定一律 dBFS（D-020）；dBm 只在有绝对功率标定时出现
    std::string window;
    BlockMeta meta;                   // start_sample = 本帧第一段的首样点
};

// 端口上流动的数据。C++14 没有 variant，这里用带标志的聚合体，够用且不引依赖。
struct PortData {
    PortType type = PortType::IQStream;
    bool has_data = false;
    Block iq;
    DetectionList detections;
    std::vector<SpectrumFrame> spectra;   // 一个输入块可能切出多帧，一次 process 全部交出
    SceneParamFrame scene;

    void clear() {
        has_data = false;
        iq.samples.clear();
        detections.items.clear();
        spectra.clear();
    }
};

using PortMap = std::map<std::string, PortData>;

struct PortSpec {
    std::string name;
    PortType type;
};

// 组件目录里的类别（04 §8.1 六类：辐射源、信道、天线、接收机、数据、算法）。
namespace category {
const char* const Source = "source";
const char* const Channel = "channel";
const char* const Antenna = "antenna";
const char* const Receiver = "receiver";
const char* const Data = "data";
const char* const Algorithm = "algorithm";
}  // namespace category

// 组件的自描述（docs/component-catalog.md 第 3 节）。目录、框图装载器、参数表单都只读它，
// 不各自维护一份组件清单（决策 D-030：组件目录只由引擎生成）。
struct ComponentInfo {
    std::string type;                 // 与 type_name() 一致
    std::string category;             // category:: 六类之一
    std::string display_name;
    std::string description;
    std::string model_layer;          // M1 / M2 / M3
    std::string model_level;          // E1 – E4
    std::string model_id;             // 对应概念模型编号，可空
    std::string version;
    std::vector<PortSpec> inputs;
    std::vector<PortSpec> outputs;
    std::vector<ParamSpec> params;
    bool scene_bindable = false;      // 回放源永远为 false（06 备忘录防线二、三）
    bool stateful = false;
    std::string implementation = "cpp";   // cpp | coder（决策 D-036）
    std::string source_ref;           // coder 产物必填：来源 .m、MATLAB 与 Coder 版本、codegen 参数哈希
    bool has_dynamic_ports = false;   // 场景绑定组件按绑定生成端口，如 link:<emitter_id>
    std::string dynamic_port_pattern;
    PortType dynamic_port_type = PortType::IQStream;
    std::string dynamic_port_source;
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

    // 自描述。默认实现只带类型与端口，没有参数描述与类别；进目录的组件必须重写它，
    // 否则目录校验会把它挡下来（test_registry.cpp）。
    virtual ComponentInfo describe() const {
        ComponentInfo i;
        i.type = type_name();
        i.inputs = inputs();
        i.outputs = outputs();
        return i;
    }

    // 参数配置。失败必须写 err 并返回 false，不得吞掉。
    virtual bool configure(const std::map<std::string, double>& params,
                           const std::map<std::string, std::string>& text_params,
                           std::string& err) = 0;

    // 运行前初始化。随机性由此注入（铁律 9）。
    virtual bool init(IRandom& rng, std::string& err) = 0;

    // 挂接运行观察者（observer.h）。Graph::run 在 init 之前对每个节点调一次；多数组件不需要，默认忽略。
    virtual void attach(IRunObserver* obs) { (void)obs; }

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
