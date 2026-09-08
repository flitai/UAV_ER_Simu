// 天线组件（06 备忘录 §9G C-2；决策 D-051、D-050 问题 ①）。
//
//   AntennaGain  入 in(IQStream) + scene(SceneParamFrame，**可选**)，出 out(IQStream)。
//                按方向图施加增益，接收端另计一次极化失配损耗与馈线损耗。
//
// 三条设计取舍写在这里，免得日后靠猜：
//
// ① **方向图用解析式，不用查表**（D-050 问题 ① 的拍板）。框图参数只允许四种标量
//    （docs/diagram-format.md §3），查表方向图必须走「版本号引用外部文件」那条路，而首期
//    没有任何实测方向图可填。解析式取 EM-B-07 §10.3 的 E1 抽象：主瓣按 12·(Δ/θ)² 的抛物线
//    近似衰减，截止在副瓣底。该式在 Δ = θ/2 处恰为 3 dB，即半功率波束宽度的定义。
//    E2 的查表方向图随 P3。
//
// ② **scene 口是可选输入**（PortSpec.optional，D-051）。接了就按帧里的到达角 / 离开角逐帧
//    施加；没接（定参链路 FreeSpaceChannel、无场景的算例）就按 aspect_az_deg / aspect_el_deg
//    两个参数当常量方向。两者都不是"默认值顶替缺失值"（铁律 15）：没有场景时来波方向本来就
//    只能由用户声明，这是组件声明过的能力，不是替用户做的假设。
//
// ③ **极化失配损耗只在 role = rx 时计一次**。发射端与接收端各算一次会重复计入。
//    对端极化由 peer_polarization 参数给出，典型链路视图从场景 emission.polarization 带出，
//    与 gain_dBi 从场景带出是同一件事——组件本身不读场景文件，因此它不必是场景绑定组件。
//
// 不变量：**不改变流长度**，逐样点乘一个实数增益，无状态、无历史缓冲。

#ifndef CUAV_COMPONENTS_ANTENNA_H
#define CUAV_COMPONENTS_ANTENNA_H

#include <string>
#include <vector>

#include "cuav/component.h"

namespace cuav {

class AntennaGain : public IComponent {
public:
    std::string type_name() const override { return "AntennaGain"; }
    std::vector<PortSpec> inputs() const override {
        PortSpec scene{"scene", PortType::SceneParamFrame};
        scene.optional = true;
        return {PortSpec{"in", PortType::IQStream}, scene};
    }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 供单测与解析锚点：给定相对视轴的方位、俯仰偏差时的方向增益（含馈线损耗，不含极化）。
    double gain_at_dB(double d_az_deg, double d_el_deg) const;
    // 极化失配损耗（dB，正值 = 变差）。role = tx 时恒为 0。
    double polarization_loss_dB() const;

private:
    std::string role_ = "rx";
    std::string pattern_ = "omni";
    std::string pointing_ = "fixed";
    std::string polarization_ = "vertical";
    std::string peer_polarization_ = "vertical";
    double gain_dBi_ = 0.0;
    double beamwidth_az_deg_ = 60.0, beamwidth_el_deg_ = 60.0;
    double sidelobe_dB_ = 20.0;
    double boresight_az_deg_ = 0.0, boresight_el_deg_ = 0.0;
    double feeder_loss_dB_ = 0.0;
    double aspect_az_deg_ = 0.0, aspect_el_deg_ = 0.0;

    // 帧队列与游标，与 SceneBoundChannel 同法：游标只前进，不用除法反算帧号。
    std::vector<SceneParamFrame> pend_;
    std::size_t cursor_ = 0;
    double fs_ = 0.0;
    bool have_fs_ = false;
    bool no_scene_note_done_ = false;
    ComponentStatus status_;

    const SceneParamFrame* frame_for(double t_s);
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_ANTENNA_H
