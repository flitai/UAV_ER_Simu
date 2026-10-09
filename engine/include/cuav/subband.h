// 分子带检测的逐帧状态（Q-4b，D-093）。由 EnergyDetector 在 subband_bins > 0 时持有。
//
// 逐帧顺序是契约，与 algos/reference/subband.py 的 SubbandDetector.frame 一字同序，
// 黄金基准 engine/tests/golden/energy_detector_subband.json 逐帧对拍：
//   ① 输入是频段内每个频点的 Hann 窗功率（调用方算好，见 EnergyDetector::consume_frame）；
//   ② 每个频点一个长 W 的环：环空的频点本帧先入环；环变过的重算噪声 n_j = 中位数 / ln 2；
//      判决时任一频点已连续超过 W 帧没入环，计一帧陈旧；
//   ③ 多级块（块宽 K0·2^l ≤ M，从频段第一个频点起切、尾块保留），Λ = ΣP / Σn，命中当且仅当
//      Λ > η(块宽, pfa / 检验总数)（dsp::subband_threshold）；
//   ④ 块命中、且它下面任何一级的块都没命中，才标记它；
//   ⑤ 标记的频点连成串，间隙 ≤ K0 的串并成一簇；
//   ⑥ 先关掉超过 merge_gap 没续上的段；每簇对每个开着的段的最近 kLinkFrames 帧频段并集比，
//      重叠（容差 K0）最多的连上，平局取段号小的，没有就开新段；只往前连、不重编段号；
//   ⑦ 标记的频点两边各扩 kGuardBins 不入环，其余频点各自入环（满则弹最旧）。
// 帧级的全带判决不经这里，一字不动。

#ifndef CUAV_SUBBAND_H
#define CUAV_SUBBAND_H

#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace cuav {

struct SubbandCluster {
    std::size_t lo = 0, hi = 0;     // 频段内频点下标（含两端）
    double e = 0.0;                 // 簇内 Hann 窗功率之和
    double n = 0.0;                 // 簇内噪声估计之和
    std::int64_t segment_id = -1;
};

// 分子带段的核心频段（Q-4c，D-094）：count = {频点号: 命中帧数}，frames = 该段的帧数；返回在至少一半的帧里
// 命中的频点的首末（闭区间），没有就取全部命中过的。评价器（tf_metrics）、特征提取（FeatureExtractor 的分子带口径）
// 与网页同一条规则、按整数频点号比；Python 同名 evaluate.core_span。count 不得为空。
std::pair<long long, long long> subband_core_span(const std::map<long long, std::uint64_t>& count, std::uint64_t frames);

class SubbandStage {
public:
    static const std::size_t kLinkFrames = 64;
    static const std::size_t kGuardBins = 2;
    static bool allowed_k0(int k0);

    // m_bins：频段内频点数；k0：最小块宽；window：环长 W
    bool configure(std::size_t m_bins, int k0, double pfa, std::size_t window, std::uint64_t merge_gap,
                   std::string& err);
    void frame(const std::vector<double>& p, std::uint64_t f, std::vector<SubbandCluster>& out);

    int k0() const { return k0_; }
    std::size_t levels() const { return sizes_.size(); }
    std::size_t tests() const { return tests_; }
    double pfa_test() const { return pfa_test_; }
    double threshold_for(std::size_t width) const;
    std::uint64_t segments() const { return static_cast<std::uint64_t>(next_id_); }
    std::uint64_t hit_frames() const { return hit_frames_; }
    std::uint64_t stale_frames() const { return stale_; }
    std::size_t never_full_bins() const;
    bool configured() const { return m_ > 0; }

private:
    struct Recent { std::uint64_t f; std::size_t lo, hi; };
    struct Seg { std::int64_t id; std::uint64_t last; std::deque<Recent> recent; };

    std::size_t m_ = 0;
    int k0_ = 0;
    std::size_t w_ = 0;
    std::uint64_t gap_ = 0;
    std::vector<std::size_t> sizes_;
    std::size_t tests_ = 0;
    double pfa_test_ = 0.0;
    std::map<std::size_t, double> eta_;
    std::vector<std::deque<double> > ring_;
    std::vector<std::vector<double> > sorted_;
    std::vector<double> noise_;
    std::vector<bool> dirty_;
    std::vector<bool> ever_full_;
    std::vector<std::uint64_t> since_;
    std::vector<Seg> open_;
    std::int64_t next_id_ = 0;
    std::uint64_t hit_frames_ = 0;
    std::uint64_t stale_ = 0;

    void push(std::size_t j, double v);
};

}  // namespace cuav

#endif
