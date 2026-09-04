// 随机性显式注入（铁律 9）：库内没有全局随机源，任何需要随机的组件都通过 IRandom& 拿。
// 固定种子必须逐位复现，因此实现是自带的确定性发生器，不用 std::random_device，
// 也不用各平台实现可能不同的 std::normal_distribution。
//
// 依据：04 §8.3、§15.2；CLAUDE.md 铁律 9。

#ifndef CUAV_RANDOM_H
#define CUAV_RANDOM_H

#include <cstdint>

namespace cuav {

class IRandom {
public:
    virtual ~IRandom() {}
    virtual std::uint64_t next_u64() = 0;
    // 均匀分布 [0,1)
    virtual double uniform() = 0;
    // 标准正态，单变量
    virtual double normal() = 0;
    // 复标准正态：实虚部各方差 1/2，即 E|z|^2 = 1
    virtual void complex_normal(float& re, float& im) = 0;
};

// xoshiro256++ 加 Box-Muller。选它是因为实现短、无平台差异、可逐位复现。
class Xoshiro256pp : public IRandom {
public:
    explicit Xoshiro256pp(std::uint64_t seed);
    std::uint64_t next_u64() override;
    double uniform() override;
    double normal() override;
    void complex_normal(float& re, float& im) override;

private:
    std::uint64_t s_[4];
    bool has_spare_ = false;
    double spare_ = 0.0;
};

}  // namespace cuav

#endif  // CUAV_RANDOM_H
