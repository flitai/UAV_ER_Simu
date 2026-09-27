// 传播效应配置的解析（D-058 的十五个参数 → geo::PropagationConfig）。
//
// 原来写在 ScenarioSource::configure() 里；覆盖场（cuav_run --field，D-080）要按同一套参数、
// 同一条校验算链路预算，于是抽到这里，两处共用——**一份解析，不许各写一份**，否则框图里选的
// 效应与覆盖图算的效应迟早会对不上。

#ifndef CUAV_PROPAGATION_PARAMS_H
#define CUAV_PROPAGATION_PARAMS_H

#include <map>
#include <string>
#include <vector>

#include "cuav_geo/propagation.h"

namespace cuav {

// 十五个参数名，顺序同组件目录（ScenarioSource 的参数表里它们连在一起）。
const std::vector<std::string>& propagation_param_names();

// 数值表（含布尔 0/1）与文本表 → 配置。枚举认不出、跨参数约束不满足都失败并写 err（铁律 15）。
bool propagation_from_params(const std::map<std::string, double>& params,
                             const std::map<std::string, std::string>& text_params,
                             geo::PropagationConfig& out, std::string& err);

}  // namespace cuav

#endif  // CUAV_PROPAGATION_PARAMS_H
