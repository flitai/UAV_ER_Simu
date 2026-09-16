// Channelizer：多相 FFT 信道化（04 §7.7「多相滤波器组」；06 备忘录 §9D M-3；D-071）。
//
// 把宽带 IQ 切成 M 条等宽子信道，**本期只输出其中一路**（10 报告 §3.7：「首期只输出一路 S5」；
// 「全部子信道并行」留后续，那要给观测点加第二根实例轴，是全仓第一个多输出组件）。
// 04 §15.2 的标准算例第 8 项「宽带 IQ 到信道化 IQ」由它兑现。
//
// **算法核是 MATLAB Coder 产物**（08 报告 §13 的首个使用者之一，D-036 / D-070 ②）：
// models/channelizer/coder/cuav_pfb_m{2,4,8,16,32,64}.c，来源 matlab/ref/cuav_pfb_cycle.m。
// 每个子信道数一个入口，因为 reshape 的行数与 ifft 的长度都必须是 codegen 常量。
// 本文件是 §13 规定的封装层，五项职责全在这里。
//
// 两条口径写在这里，改动即为基准变化：
//
// ① **时间锚**（08 §8 口径一、二）：输出样点 m ↔ 输入样点 m·M，做法与 DDC 相同 ——
//    把换向器相位的初值置为群时延 gd。抽头表保证 gd 是 M 的整数倍，于是多相 FFT 输出的
//    常数相位 exp(−j2πk·gd/M) 恒为 1，M 路输出不需要任何逐信道的相位修正。
//
// ② **内核吃正序连续切片**，不是倒序窗口。倒序的写法要封装层每个输出周期拷 pad_to 个样点
//    （29·M 次拷贝换 29·M 次乘加，内存流量翻倍）；正序则可以把工作缓冲的指针直接递进去，
//    一个样点都不用拷，代价只是每周期在 M 个元素上翻转一次（那在 .m 里）。

#ifndef CUAV_COMPONENTS_CHANNELIZER_H
#define CUAV_COMPONENTS_CHANNELIZER_H

#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/dsp.h"

extern "C" {
#include "cuav_pfb_m2.h"
}

namespace cuav {

class Channelizer : public IComponent {
public:
    std::string type_name() const override { return "Channelizer"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::IQStream}}; }
    std::vector<PortSpec> outputs() const override { return {PortSpec{"out", PortType::IQStream}}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    Step flush(PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    // 测试用读数
    int channels() const { return channels_; }
    int select_channel() const { return select_; }
    int raw_bin() const { return raw_bin_; }
    int ntaps() const { return ntaps_; }
    int pad_to() const { return pad_to_; }
    int group_delay() const { return group_delay_; }
    double sample_rate_out_Hz() const { return fs_out_; }
    std::uint64_t out_count() const { return out_count_; }

    // 界面编号 j（相对中心从低到高，j = M/2 是零频）→ 原始 FFT 下标 k（中心频率 k·fs/M）
    static int raw_bin_of(int select_channel, int channels) {
        return (select_channel + channels / 2) % channels;
    }

private:
    // 生成的六个入口签名一致，按子信道数在 configure() 里选一个
    typedef void (*PfbFn)(const creal_T*, const double*, creal_T*);

    int channels_ = 8;
    int select_ = 4;
    int raw_bin_ = 0;
    std::string fir_version_ = "pfb_v1";
    int ntaps_ = 0, pad_to_ = 0, group_delay_ = 0;
    PfbFn fn_ = 0;

    std::vector<double> taps_rev_;     // 零填充到 pad_to 再整体反转，算一次反复用
    std::vector<creal_T> work_;        // [历史 | 本块]，正序；内核直接收它的指针
    std::vector<creal_T> hist_;        // 上一块末尾 pad_to-1 个样点
    std::vector<creal_T> ybuf_;        // 内核出参：M 路
    std::size_t next_ = 0;             // 下一个输出在本块内的输入偏移，跨块递延

    std::vector<Complex> outbuf_;

    double fs_in_ = 0.0, fs_out_ = 0.0;
    bool have_fs_ = false;
    std::uint64_t expect_in_ = 0;
    bool have_expect_ = false;
    std::uint64_t out_count_ = 0, samples_in_ = 0, pend_clip_ = 0;
    ComponentStatus status_;
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_CHANNELIZER_H
