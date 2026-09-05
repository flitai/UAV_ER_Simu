// 观测点组件（06 备忘录 §9A B-3；04 §8.2「中间观测点」）。
//
// 接任一 IQ 输出口（框图里 observation_points[] 在装载时并联成本组件，docs/diagram-format.md §5），
// 把显示产品写成 docs/display-products.md 规定的定长行二进制加索引：
//   spectrum.f32 / spectrum.index.json   每行 nfft 个 float32（dBFS），口径同 SpectrumAnalyzer（共用 WelchAccumulator）
//   envelope.f32 / envelope.index.json   每行 3 个 float32：桶内 |x| 的 min、max、rms
// 同时把每一行交给运行观察者（on_product_row），运行器据此实时推送。
// 索引里的 rows「最后更新」并原子替换，读端只读 rows 以内的行；行定长追加。
// 原始 IQ 产品（iq/）留待后续步骤，本组件暂不声明该参数（目录只增不改）。

#ifndef CUAV_COMPONENTS_TAP_H
#define CUAV_COMPONENTS_TAP_H

#include <cstdio>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/components/spectrum.h"
#include "cuav/observer.h"

namespace cuav {

class ObservationTap : public IComponent {
public:
    ~ObservationTap() override;
    std::string type_name() const override { return "ObservationTap"; }
    std::vector<PortSpec> inputs() const override { return {PortSpec{"in", PortType::IQStream}}; }
    std::vector<PortSpec> outputs() const override { return {}; }
    ComponentInfo describe() const override;
    bool configure(const std::map<std::string, double>& params,
                   const std::map<std::string, std::string>& text_params,
                   std::string& err) override;
    bool init(IRandom& rng, std::string& err) override;
    void attach(IRunObserver* obs) override { obs_ = obs; }
    Step process(PortMap& in, PortMap& out, std::string& err) override;
    Step flush(PortMap& out, std::string& err) override;
    void reset() override;
    ComponentStatus status() const override { return status_; }

    std::uint64_t spectrum_rows() const { return spec_rows_; }
    std::uint64_t envelope_rows() const { return env_rows_; }

private:
    // 参数
    std::string op_id_;
    std::string out_dir_;            // 内部参数，运行器注入
    bool want_spectrum_ = true, want_envelope_ = true;
    std::size_t nfft_ = 1024, segments_per_frame_ = 1, bucket_samples_ = 4096;
    double overlap_ = 0.0;
    std::string window_ = "hann";

    // 状态
    IRunObserver* obs_ = nullptr;
    WelchAccumulator acc_;
    bool seen_block_ = false;
    BlockMeta last_meta_;
    double sample_rate_Hz_ = 0.0, center_frequency_Hz_ = 0.0;
    std::uint64_t first_sample_ = 0;

    std::FILE* spec_file_ = nullptr;
    std::FILE* env_file_ = nullptr;
    std::uint64_t spec_rows_ = 0, env_rows_ = 0;
    std::uint64_t spec_first_sample_ = 0;
    bool spec_first_known_ = false;

    // 包络桶
    std::uint64_t bucket_start_sample_ = 0;
    std::size_t bucket_count_ = 0;
    double bucket_min_ = 0.0, bucket_max_ = 0.0, bucket_sumsq_ = 0.0;
    std::size_t last_bucket_samples_ = 0;

    std::vector<std::string> reasons_;   // 索引 notes：说明性备注，不是降级原因
    ComponentStatus status_;

    bool open_files(std::string& err);
    void close_files();
    bool write_spectrum_row(const std::vector<double>& power, std::uint64_t first_sample, std::size_t segments, std::string& err);
    bool write_envelope_row(std::string& err);
    bool write_index(const char* kind, std::string& err);
    void feed_envelope(const Block& blk, std::string& err, bool& ok);
};

}  // namespace cuav

#endif  // CUAV_COMPONENTS_TAP_H
