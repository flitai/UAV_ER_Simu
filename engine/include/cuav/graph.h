// 有向无环图与单线程调度器。
//
// 依据：04 §8.3「运行引擎」；决策 D-013（连线校验：IQ 流与参数流不得直连）。
// 首期单线程调度先行，多线程与背压留到接口稳定之后再加——接口里已经为此留了位置：
// 组件不假设块大小、Step::Idle 表示“本轮没产出但没结束”。

#ifndef CUAV_GRAPH_H
#define CUAV_GRAPH_H

#include <memory>
#include <string>
#include <vector>

#include "cuav/component.h"
#include "cuav/observer.h"

namespace cuav {

using NodeId = std::size_t;

struct Edge {
    NodeId from = 0;
    std::string from_port;
    NodeId to = 0;
    std::string to_port;
};

struct RunReport {
    bool ok = false;
    std::string error;
    std::uint64_t rounds = 0;
    State state = State::Valid;
    std::vector<std::string> notes;
    std::vector<ComponentStatus> node_status;
    std::vector<std::string> node_names;
};

class Graph {
public:
    NodeId add(std::unique_ptr<IComponent> comp, const std::string& name);

    // 连线。类型不匹配、端口不存在、重复连同一输入口，都在这里挡住并写明理由。
    bool connect(NodeId from, const std::string& from_port,
                 NodeId to, const std::string& to_port, std::string& err);

    // 拓扑排序加环检测。有环即报错，不静默丢边。
    bool validate(std::string& err);

    // 单线程按拓扑序轮转，直到所有源结束且下游排空。
    RunReport run(IRandom& rng, std::uint64_t max_rounds = 1000000);
    // 带观察者的版本：init 前把观察者挂到每个节点，每轮结束回调 on_progress（B-3）。
    RunReport run(IRandom& rng, IRunObserver& observer, std::uint64_t max_rounds = 1000000);

    IComponent* node(NodeId id) { return nodes_.at(id).comp.get(); }
    std::size_t size() const { return nodes_.size(); }
    const std::vector<NodeId>& order() const { return order_; }

private:
    struct Node {
        std::unique_ptr<IComponent> comp;
        std::string name;
    };
    std::vector<Node> nodes_;
    std::vector<Edge> edges_;
    std::vector<NodeId> order_;
    bool validated_ = false;

    const PortSpec* find_port(const std::vector<PortSpec>& v, const std::string& name) const;
    RunReport run_impl(IRandom& rng, IRunObserver* observer, std::uint64_t max_rounds);
};

}  // namespace cuav

#endif  // CUAV_GRAPH_H
