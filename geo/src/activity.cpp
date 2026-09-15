#include "cuav_geo/activity.h"

#include <algorithm>
#include <cmath>
#include <sstream>

#include "cuav_geo/scenario.h"

namespace cuav {
namespace geo {
namespace {

std::string num(double v) {
    std::ostringstream os;
    os.precision(9);
    os << v;
    return os.str();
}

std::string u64s(std::uint64_t v) {
    std::ostringstream os;
    os << v;
    return os.str();
}

}  // namespace

const std::uint64_t ActivitySchedule::kNoChange = static_cast<std::uint64_t>(-1);

std::uint64_t sample_at(double t_s, double fs_Hz) {
    if (!(t_s > 0.0)) return 0;
    return static_cast<std::uint64_t>(t_s * fs_Hz + 0.5);
}

std::vector<CenterPoint> emitter_center_set(const Scenario& s, const std::string& emitter_id) {
    std::vector<CenterPoint> out;
    const Emitter* em = s.find_emitter(emitter_id);
    if (em == 0) return out;
    out.push_back(CenterPoint(em->emission.center_Hz, "emission.center_Hz"));

    for (std::size_t i = 0; i < s.activities.size(); ++i) {
        const Activity& a = s.activities[i];
        if (a.emitter_id != emitter_id || a.event != ActivityEvent::Hop) continue;
        const std::string base = "activities[" + u64s(static_cast<std::uint64_t>(i)) + "].args";
        if (a.has_center_Hz) {
            out.push_back(CenterPoint(a.center_Hz, base + ".center_Hz"));
        } else {
            for (std::size_t k = 0; k < a.sequence.size(); ++k)
                out.push_back(CenterPoint(a.sequence[k],
                                          base + ".sequence[" + u64s(static_cast<std::uint64_t>(k)) + "]"));
        }
    }

    // 升序去重，同频保留第一个出处（稳定排序保证「第一个」就是数组里靠前的那个）。
    std::stable_sort(out.begin(), out.end(),
                     [](const CenterPoint& a, const CenterPoint& b) { return a.Hz < b.Hz; });
    std::vector<CenterPoint> uniq;
    for (std::size_t i = 0; i < out.size(); ++i)
        if (uniq.empty() || uniq.back().Hz != out[i].Hz) uniq.push_back(out[i]);
    return uniq;
}

ActivitySchedule::ActivitySchedule()
    : fs_Hz_(0.0), base_center_Hz_(0.0), has_tx_events_(false) {}

bool ActivitySchedule::build(const Scenario& s, const std::string& emitter_id, double fs_Hz,
                             std::string& err) {
    const Emitter* em = s.find_emitter(emitter_id);
    if (em == 0) {
        err = "场景里没有辐射源 " + emitter_id;
        return false;
    }
    if (!(fs_Hz > 0.0)) {
        err = "活动时间线需要正的采样率，收到 " + num(fs_Hz);
        return false;
    }
    id_ = emitter_id;
    fs_Hz_ = fs_Hz;
    base_center_Hz_ = em->emission.center_Hz;
    has_tx_events_ = false;
    tx_n_.clear();
    tx_state_.clear();
    hops_.clear();
    notes_.clear();

    // 活动已按 t_s 非降排序（Scenario::cross_check 保证），故折出的样点号也非降。
    for (std::size_t i = 0; i < s.activities.size(); ++i) {
        const Activity& a = s.activities[i];
        if (a.emitter_id != emitter_id) continue;
        const std::string where = "activities[" + u64s(static_cast<std::uint64_t>(i)) + "]";

        if (a.event == ActivityEvent::TxOn || a.event == ActivityEvent::TxOff) {
            const std::uint64_t n = sample_at(a.t_s, fs_Hz);
            const char st = (a.event == ActivityEvent::TxOn) ? 1 : 0;
            if (has_tx_events_ && tx_n_.back() == n) {
                if (tx_state_.back() != st) {
                    err = "辐射源 " + emitter_id + " 的 " + where + "（t = " + num(a.t_s) + " s，" +
                          (st ? "tx_on" : "tx_off") + "）与前一条开关活动在 " + num(fs_Hz) +
                          " Hz 下都折到样点 " + u64s(n) +
                          "，中间那段发射一个样点都放不下；不静默合并（铁律 15）";
                    return false;
                }
                continue;                      // 同一样点同一状态：重复声明，收下即可
            }
            has_tx_events_ = true;
            tx_n_.push_back(n);
            tx_state_.push_back(st);
        } else if (a.event == ActivityEvent::Hop) {
            Hop h;
            h.start_n = sample_at(a.t_s, fs_Hz);
            if (a.has_center_Hz) {
                h.sequence.push_back(a.center_Hz);
                h.dwell_n = 0;
            } else {
                h.sequence = a.sequence;
                h.dwell_n = sample_at(a.dwell_s, fs_Hz);
                if (h.dwell_n == 0) {
                    err = "辐射源 " + emitter_id + " 的 " + where + " 跳频停留 " + num(a.dwell_s) +
                          " s 在 " + num(fs_Hz) + " Hz 下折出 0 个样点：一个停留窗放不下一个样点，"
                          "跳频序列表达不出来；请把 dwell_s 提到至少 " + num(0.5 / fs_Hz) +
                          " s（= 0.5/fs）或提高采样率（铁律 15）";
                    return false;
                }
                const double actual = static_cast<double>(h.dwell_n) / fs_Hz;
                if (std::fabs(actual - a.dwell_s) > 1e-3 * a.dwell_s) {
                    notes_.push_back("跳频停留 " + num(a.dwell_s) + " s 在 " + num(fs_Hz) +
                                     " Hz 下取整为 " + u64s(h.dwell_n) + " 个样点（实际 " +
                                     num(actual) + " s）");
                }
            }
            if (!hops_.empty() && hops_.back().start_n == h.start_n) {
                err = "辐射源 " + emitter_id + " 的 " + where + "（t = " + num(a.t_s) +
                      " s）与前一条跳频活动在 " + num(fs_Hz) + " Hz 下都折到样点 " +
                      u64s(h.start_n) + "，前一个跳频点一个样点都用不上；不静默丢弃（铁律 15）";
                return false;
            }
            hops_.push_back(h);
        }
        // takeoff / cruise / hover / land 只改状态标签与显示，不进波形（docs/scenario-format.md §6）
    }
    return true;
}

bool ActivitySchedule::tx_on_at_sample(std::uint64_t n) const {
    if (!has_tx_events_) return true;      // 无开关活动即自 t = 0 起持续发射（§6）
    // 生效的是最后一个 start ≤ n 的；一个都没有 → 首个 tx_on 之前不发射
    std::vector<std::uint64_t>::const_iterator it =
        std::upper_bound(tx_n_.begin(), tx_n_.end(), n);
    if (it == tx_n_.begin()) return false;
    return tx_state_[static_cast<std::size_t>((it - 1) - tx_n_.begin())] != 0;
}

double ActivitySchedule::center_Hz_at_sample(std::uint64_t n) const {
    for (std::size_t i = hops_.size(); i-- > 0;) {
        const Hop& h = hops_[i];
        if (h.start_n > n) continue;
        if (h.sequence.empty()) continue;
        if (h.dwell_n == 0) return h.sequence[0];
        const std::uint64_t k = (n - h.start_n) / h.dwell_n;
        return h.sequence[static_cast<std::size_t>(k % h.sequence.size())];
    }
    return base_center_Hz_;
}

std::uint64_t ActivitySchedule::next_change_sample(std::uint64_t n) const {
    std::uint64_t next = kNoChange;

    if (has_tx_events_) {
        std::vector<std::uint64_t>::const_iterator it =
            std::upper_bound(tx_n_.begin(), tx_n_.end(), n);
        // 状态相同的相邻条目已在 build() 里合并掉，故下一条一定是真的变化
        if (it != tx_n_.end()) next = *it;
    }

    // 下一条 hop 活动的起点
    for (std::size_t i = 0; i < hops_.size(); ++i) {
        if (hops_[i].start_n > n) { next = std::min(next, hops_[i].start_n); break; }
    }
    // 当前生效的 hop 序列内的下一次跳变
    for (std::size_t i = hops_.size(); i-- > 0;) {
        const Hop& h = hops_[i];
        if (h.start_n > n) continue;
        if (h.dwell_n == 0 || h.sequence.size() <= 1) break;   // 频点不变，不造边界
        const std::uint64_t k = (n - h.start_n) / h.dwell_n;
        next = std::min(next, h.start_n + (k + 1) * h.dwell_n);
        break;
    }
    return next;
}

ActivitySchedule::Segment ActivitySchedule::segment_at(std::uint64_t n) const {
    Segment seg;
    seg.begin = n;
    seg.end = next_change_sample(n);
    seg.tx_on = tx_on_at_sample(n);
    seg.center_Hz = center_Hz_at_sample(n);
    return seg;
}

}  // namespace geo
}  // namespace cuav
