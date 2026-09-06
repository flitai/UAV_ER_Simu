#include "cuav/types.h"

namespace cuav {

const char* engine_version() { return "0.1.0"; }

const char* to_string(State s) {
    switch (s) {
        case State::Valid: return "valid";
        case State::Degraded: return "degraded";
        case State::Invalid: return "invalid";
        case State::NotApplicable: return "not_applicable";
    }
    return "unknown";
}

State worst(State a, State b) {
    // NotApplicable 不参与取最差：「不适用」与「检查通过」是两回事，
    // 混同会让统计失真（docs/iq-format.md 第 4.4 节）。
    if (a == State::NotApplicable) return b;
    if (b == State::NotApplicable) return a;
    auto rank = [](State s) {
        switch (s) {
            case State::Valid: return 0;
            case State::Degraded: return 1;
            case State::Invalid: return 2;
            default: return -1;
        }
    };
    return rank(a) >= rank(b) ? a : b;
}

const char* to_string(PortType t) {
    switch (t) {
        case PortType::IQStream: return "IQStream";
        case PortType::SceneParamFrame: return "SceneParamFrame";
        case PortType::ChannelPathSet: return "ChannelPathSet";
        case PortType::SpectrumFrame: return "SpectrumFrame";
        case PortType::DetectionList: return "DetectionList";
        case PortType::FeatureVector: return "FeatureVector";
    }
    return "unknown";
}

bool can_connect(PortType from, PortType to) {
    // 只允许同类型相连。跨类型的转换必须由组件显式承担：
    // 参数流要作用到 IQ 上，得经过“施加”类组件的两个输入口，而不是把线直接连过去。
    return from == to;
}

const char* to_string(TimeBasis b) {
    switch (b) {
        case TimeBasis::LogicalSim: return "logical_sim";
        case TimeBasis::FileAcquisition: return "file_acquisition";
        case TimeBasis::DeviceHardware: return "device_hw";
        case TimeBasis::External: return "external";
    }
    return "unknown";
}

bool ModelTrace::complete() const {
    return !model_id.empty() && !model_version.empty() && !model_level.empty()
        && !model_layer.empty() && !credibility.empty() && !parameter_version.empty()
        && !trace_id.empty();
}

std::string weaker_source(const std::string& a, const std::string& b) {
    auto rank = [](const std::string& s) {
        if (s == "measured") return 4;
        if (s == "paper") return 3;
        if (s == "model") return 2;
        return 1;   // assumed 与未知
    };
    return rank(a) <= rank(b) ? a : b;
}

void BlockMeta::degrade(const std::string& why) {
    state = worst(state, State::Degraded);
    state_reasons.push_back(why);
}

void BlockMeta::invalidate(const std::string& why) {
    state = worst(state, State::Invalid);
    state_reasons.push_back(why);
}

}  // namespace cuav
