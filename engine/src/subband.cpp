// 分子带检测的逐帧状态（Q-4b，D-093）。契约与七步顺序见 cuav/subband.h。

#include "cuav/subband.h"

#include <algorithm>
#include <cmath>

#include "cuav/dsp.h"

namespace cuav {

namespace {
const double kLn2 = 0.69314718055994530942;
}

std::pair<long long, long long> subband_core_span(const std::map<long long, std::uint64_t>& count, std::uint64_t frames) {
    long long lo = 0, hi = 0;
    bool have = false;
    for (const auto& c : count) {
        if (2 * c.second < frames) continue;
        if (!have) { lo = hi = c.first; have = true; } else { lo = std::min(lo, c.first); hi = std::max(hi, c.first); }
    }
    if (!have) { lo = count.begin()->first; hi = count.rbegin()->first; }
    return std::make_pair(lo, hi);
}

bool SubbandStage::allowed_k0(int k0) {
    return k0 == 2 || k0 == 4 || k0 == 8 || k0 == 16 || k0 == 32 || k0 == 64;
}

bool SubbandStage::configure(std::size_t m_bins, int k0, double pfa, std::size_t window, std::uint64_t merge_gap,
                             std::string& err) {
    if (!allowed_k0(k0)) { err = "subband_bins 必须取 2 / 4 / 8 / 16 / 32 / 64"; return false; }
    if (m_bins == 0) { err = "检测频段内没有频点，分子带检测无从切块"; return false; }
    m_ = m_bins;
    k0_ = k0;
    w_ = window;
    gap_ = merge_gap;
    sizes_.clear();
    for (std::size_t s = static_cast<std::size_t>(k0); s <= m_; s *= 2) sizes_.push_back(s);
    if (sizes_.empty()) sizes_.push_back(m_);
    tests_ = 0;
    for (std::size_t s : sizes_) tests_ += (m_ + s - 1) / s;
    pfa_test_ = pfa / static_cast<double>(tests_);
    eta_.clear();
    for (std::size_t s : sizes_) {
        for (std::size_t b0 = 0; b0 < m_; b0 += s) {
            const std::size_t width = std::min(s, m_ - b0);
            if (eta_.find(width) == eta_.end()) eta_[width] = dsp::subband_threshold(width, pfa_test_);
        }
    }
    ring_.assign(m_, std::deque<double>());
    sorted_.assign(m_, std::vector<double>());
    noise_.assign(m_, 0.0);
    dirty_.assign(m_, false);
    ever_full_.assign(m_, false);
    since_.assign(m_, 0);
    open_.clear();
    next_id_ = 0;
    hit_frames_ = 0;
    stale_ = 0;
    return true;
}

double SubbandStage::threshold_for(std::size_t width) const {
    auto it = eta_.find(width);
    return it == eta_.end() ? 0.0 : it->second;
}

std::size_t SubbandStage::never_full_bins() const {
    std::size_t n = 0;
    for (bool v : ever_full_) if (!v) ++n;
    return n;
}

void SubbandStage::push(std::size_t j, double v) {
    std::deque<double>& r = ring_[j];
    std::vector<double>& s = sorted_[j];
    if (r.size() == w_) {
        const double old = r.front();
        r.pop_front();
        auto it = std::lower_bound(s.begin(), s.end(), old);
        if (it != s.end()) s.erase(it);
    }
    r.push_back(v);
    s.insert(std::upper_bound(s.begin(), s.end(), v), v);
    if (r.size() == w_) ever_full_[j] = true;
    dirty_[j] = true;
}

void SubbandStage::frame(const std::vector<double>& p, std::uint64_t f, std::vector<SubbandCluster>& out) {
    out.clear();
    const std::size_t M = m_;
    std::vector<bool> admitted(M, false);
    // ② 环空先入环；环变过的重算噪声
    for (std::size_t j = 0; j < M; ++j) {
        if (ring_[j].empty()) { push(j, p[j]); admitted[j] = true; }
    }
    for (std::size_t j = 0; j < M; ++j) {
        if (!dirty_[j]) continue;
        const std::vector<double>& s = sorted_[j];
        const std::size_t n = s.size();
        const double med = (n % 2) ? s[n / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
        noise_[j] = med / kLn2;
        dirty_[j] = false;
    }
    std::uint64_t mx = 0;
    for (std::size_t j = 0; j < M; ++j) mx = std::max(mx, since_[j]);
    if (mx > w_) ++stale_;

    // ③ 多级块
    std::vector<std::vector<bool> > hits(sizes_.size());
    for (std::size_t li = 0; li < sizes_.size(); ++li) {
        const std::size_t s = sizes_[li];
        for (std::size_t b0 = 0; b0 < M; b0 += s) {
            const std::size_t b1 = std::min(b0 + s, M);
            double e = 0.0, n = 0.0;
            for (std::size_t j = b0; j < b1; ++j) { e += p[j]; n += noise_[j]; }
            const double eta = eta_[b1 - b0];
            hits[li].push_back(n > 0.0 && e / n > eta);
        }
    }
    // ④ 标记：块命中、且它下面任何一级都没命中
    std::vector<bool> mark(M, false);
    std::vector<bool> below;
    for (std::size_t li = 0; li < sizes_.size(); ++li) {
        const std::vector<bool>& row = hits[li];
        std::vector<bool> below_l(row.size(), false);
        std::vector<bool> marked(row.size(), false);
        if (li == 0) {
            marked = row;
        } else {
            const std::vector<bool>& prev = hits[li - 1];
            for (std::size_t b = 0; b < row.size(); ++b) {
                bool any = false;
                for (std::size_t c = 2 * b; c <= 2 * b + 1; ++c) {
                    if (c < prev.size() && (prev[c] || below[c])) any = true;
                }
                below_l[b] = any;
                marked[b] = row[b] && !any;
            }
        }
        const std::size_t s = sizes_[li];
        for (std::size_t b = 0; b < marked.size(); ++b) {
            if (!marked[b]) continue;
            for (std::size_t j = b * s; j < std::min(b * s + s, M); ++j) mark[j] = true;
        }
        below = below_l;
    }
    // ⑤ 成簇：间隙 ≤ K0 的串并成一簇
    std::vector<std::pair<std::size_t, std::size_t> > clusters;
    for (std::size_t j = 0; j < M;) {
        if (!mark[j]) { ++j; continue; }
        const std::size_t lo = j;
        std::size_t hi = j;
        while (hi + 1 < M && mark[hi + 1]) ++hi;
        if (!clusters.empty() && lo - clusters.back().second - 1 <= static_cast<std::size_t>(k0_)) {
            clusters.back().second = hi;
        } else {
            clusters.push_back(std::make_pair(lo, hi));
        }
        j = hi + 1;
    }
    // ⑥ 连接
    std::vector<Seg> kept;
    for (Seg& sg : open_) {
        if (f - sg.last - 1 <= gap_) kept.push_back(sg);
    }
    open_.swap(kept);
    const std::int64_t tol = static_cast<std::int64_t>(k0_);
    for (const auto& c : clusters) {
        const std::int64_t lo = static_cast<std::int64_t>(c.first);
        const std::int64_t hi = static_cast<std::int64_t>(c.second);
        Seg* best = nullptr;
        std::int64_t best_ov = 0;
        for (Seg& sg : open_) {
            std::deque<Recent>& q = sg.recent;
            while (!q.empty() && q.front().f + kLinkFrames < f) q.pop_front();   // 帧号 < f − L 的弹掉
            if (q.empty()) continue;
            std::int64_t rlo = static_cast<std::int64_t>(q.front().lo);
            std::int64_t rhi = static_cast<std::int64_t>(q.front().hi);
            for (const Recent& r : q) {
                rlo = std::min(rlo, static_cast<std::int64_t>(r.lo));
                rhi = std::max(rhi, static_cast<std::int64_t>(r.hi));
            }
            if (lo <= rhi + tol && hi >= rlo - tol) {
                const std::int64_t ov = std::min(hi, rhi) - std::max(lo, rlo);
                if (best == nullptr || ov > best_ov) { best = &sg; best_ov = ov; }
            }
        }
        if (best == nullptr) {
            Seg sg;
            sg.id = next_id_++;
            sg.last = f;
            open_.push_back(sg);
            best = &open_.back();
        }
        Recent r;
        r.f = f;
        r.lo = c.first;
        r.hi = c.second;
        best->recent.push_back(r);
        best->last = f;
        SubbandCluster out_c;
        out_c.lo = c.first;
        out_c.hi = c.second;
        for (std::size_t j = c.first; j <= c.second; ++j) { out_c.e += p[j]; out_c.n += noise_[j]; }
        out_c.segment_id = best->id;
        out.push_back(out_c);
    }
    // ⑦ 删截与入环
    std::vector<bool> guard(M, false);
    for (std::size_t j = 0; j < M; ++j) {
        if (!mark[j]) continue;
        const std::size_t g0 = j >= kGuardBins ? j - kGuardBins : 0;
        const std::size_t g1 = std::min(M - 1, j + kGuardBins);
        for (std::size_t g = g0; g <= g1; ++g) guard[g] = true;
    }
    for (std::size_t j = 0; j < M; ++j) {
        if (!guard[j] && !admitted[j]) { push(j, p[j]); admitted[j] = true; }
        since_[j] = admitted[j] ? 0 : since_[j] + 1;
    }
    if (!out.empty()) ++hit_frames_;
}

}  // namespace cuav
