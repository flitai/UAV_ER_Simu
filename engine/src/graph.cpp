#include "cuav/graph.h"

#include <algorithm>
#include <map>
#include <set>

namespace cuav {

NodeId Graph::add(std::unique_ptr<IComponent> comp, const std::string& name) {
    Node n;
    n.comp = std::move(comp);
    n.name = name;
    nodes_.push_back(std::move(n));
    validated_ = false;
    return nodes_.size() - 1;
}

const PortSpec* Graph::find_port(const std::vector<PortSpec>& v,
                                 const std::string& name) const {
    for (const auto& p : v) {
        if (p.name == name) return &p;
    }
    return nullptr;
}

bool Graph::connect(NodeId from, const std::string& from_port,
                    NodeId to, const std::string& to_port, std::string& err) {
    if (from >= nodes_.size() || to >= nodes_.size()) {
        err = "连线的节点编号越界";
        return false;
    }
    if (from == to) {
        err = "不允许自环：节点 " + nodes_[from].name;
        return false;
    }
    const auto outs = nodes_[from].comp->outputs();
    const auto ins = nodes_[to].comp->inputs();
    const PortSpec* o = find_port(outs, from_port);
    const PortSpec* i = find_port(ins, to_port);
    if (!o) {
        err = nodes_[from].name + " 没有输出口 " + from_port;
        return false;
    }
    if (!i) {
        err = nodes_[to].name + " 没有输入口 " + to_port;
        return false;
    }
    if (!can_connect(o->type, i->type)) {
        // D-013：IQ 流与 SceneParamFrame / ChannelPathSet 不得直连，
        // 必须经过“施加”类 M3 组件。这里把违规挡在连线阶段，而不是运行时。
        err = std::string("端口类型不允许直连：") + to_string(o->type) + " → "
            + to_string(i->type) + "（" + nodes_[from].name + "." + from_port + " → "
            + nodes_[to].name + "." + to_port + "）";
        return false;
    }
    for (const auto& e : edges_) {
        if (e.to == to && e.to_port == to_port) {
            err = nodes_[to].name + " 的输入口 " + to_port + " 已被占用，一个输入口只能连一条边";
            return false;
        }
    }
    Edge e;
    e.from = from; e.from_port = from_port; e.to = to; e.to_port = to_port;
    edges_.push_back(e);
    validated_ = false;
    return true;
}

bool Graph::validate(std::string& err) {
    // Kahn 拓扑排序
    std::vector<int> indeg(nodes_.size(), 0);
    std::vector<std::vector<NodeId>> adj(nodes_.size());
    for (const auto& e : edges_) {
        adj[e.from].push_back(e.to);
        indeg[e.to]++;
    }
    std::vector<NodeId> ready;
    for (std::size_t i = 0; i < nodes_.size(); ++i) {
        if (indeg[i] == 0) ready.push_back(i);
    }
    order_.clear();
    while (!ready.empty()) {
        NodeId n = ready.front();
        ready.erase(ready.begin());
        order_.push_back(n);
        for (NodeId m : adj[n]) {
            if (--indeg[m] == 0) ready.push_back(m);
        }
    }
    if (order_.size() != nodes_.size()) {
        err = "框图里有环，无法拓扑排序";
        return false;
    }
    // 输入口必须全部连上：留空口会让组件收到空输入而静默产出错误结果
    for (std::size_t i = 0; i < nodes_.size(); ++i) {
        for (const auto& p : nodes_[i].comp->inputs()) {
            bool linked = false;
            for (const auto& e : edges_) {
                if (e.to == i && e.to_port == p.name) { linked = true; break; }
            }
            if (!linked) {
                err = nodes_[i].name + " 的输入口 " + p.name + " 没有连线";
                return false;
            }
        }
    }
    validated_ = true;
    return true;
}

RunReport Graph::run(IRandom& rng, std::uint64_t max_rounds) {
    RunReport rep;
    if (!validated_) {
        std::string err;
        if (!validate(err)) { rep.error = err; return rep; }
    }
    for (const auto& n : nodes_) rep.node_names.push_back(n.name);

    std::string err;
    for (auto& n : nodes_) {
        if (!n.comp->init(rng, err)) {
            rep.error = n.name + " 初始化失败：" + err;
            return rep;
        }
    }

    // 每条边一个单块缓冲。首期先行的是单线程调度，缓冲深度 1 就够，
    // 背压与多线程留待接口稳定后再加。
    std::map<std::string, PortData> buffers;
    auto key = [](NodeId to, const std::string& port) {
        return std::to_string(to) + "#" + port;
    };

    // 每个节点的上游集合。下游要靠它判断「上游都结束且缓冲已排空」，
    // 否则上游停产后下游永远等不到输入，调度会假死。
    std::vector<std::vector<NodeId>> preds(nodes_.size());
    for (const auto& e : edges_) preds[e.to].push_back(e.from);

    std::vector<bool> finished(nodes_.size(), false);
    std::uint64_t round = 0;
    for (; round < max_rounds; ++round) {
        bool any_progress = false;
        for (NodeId id : order_) {
            if (finished[id]) continue;
            PortMap in, out;
            bool inputs_ready = true;
            for (const auto& p : nodes_[id].comp->inputs()) {
                auto it = buffers.find(key(id, p.name));
                if (it == buffers.end() || !it->second.has_data) {
                    inputs_ready = false;
                    break;
                }
                in[p.name] = it->second;
            }
            const bool has_inputs = !nodes_[id].comp->inputs().empty();
            if (has_inputs && !inputs_ready) {
                // 上游全部结束、且本节点所有输入缓冲都空 → 本节点也该收尾了
                bool upstream_done = true;
                for (NodeId u : preds[id]) {
                    if (!finished[u]) { upstream_done = false; break; }
                }
                if (!upstream_done) continue;
                finished[id] = true;
                PortMap fout;
                Step fs = nodes_[id].comp->flush(fout, err);
                if (fs == Step::Error) {
                    rep.error = nodes_[id].name + " 收尾失败：" + err;
                    rep.rounds = round;
                    return rep;
                }
                for (auto& kv : fout) {
                    if (!kv.second.has_data) continue;
                    any_progress = true;
                    for (const auto& e : edges_) {
                        if (e.from == id && e.from_port == kv.first) {
                            buffers[key(e.to, e.to_port)] = kv.second;
                        }
                    }
                }
                any_progress = true;
                continue;
            }

            Step st = nodes_[id].comp->process(in, out, err);
            if (st == Step::Error) {
                rep.error = nodes_[id].name + " 处理失败：" + err;
                rep.rounds = round;
                return rep;
            }
            // 输入已消费
            for (const auto& p : nodes_[id].comp->inputs()) {
                buffers[key(id, p.name)].clear();
            }
            if (st == Step::Finished) {
                finished[id] = true;
                PortMap fout;
                Step fs = nodes_[id].comp->flush(fout, err);
                if (fs == Step::Error) {
                    rep.error = nodes_[id].name + " 收尾失败：" + err;
                    rep.rounds = round;
                    return rep;
                }
                for (auto& kv : fout) out[kv.first] = kv.second;
            }
            for (auto& kv : out) {
                if (!kv.second.has_data) continue;
                any_progress = true;
                for (const auto& e : edges_) {
                    if (e.from == id && e.from_port == kv.first) {
                        buffers[key(e.to, e.to_port)] = kv.second;
                    }
                }
            }
            if (st == Step::Produced) any_progress = true;
        }
        bool all_done = true;
        for (std::size_t i = 0; i < nodes_.size(); ++i) {
            if (!finished[i]) { all_done = false; break; }
        }
        if (all_done) break;
        if (!any_progress) {
            // 没有任何节点前进，也没有全部结束：说明有节点在等永远不会到的输入。
            // 这属于框图或组件的缺陷，报错而不是空转。
            rep.error = "调度停滞：本轮没有任何节点产出，且仍有节点未结束";
            rep.rounds = round;
            return rep;
        }
    }
    if (round >= max_rounds) {
        rep.error = "超过最大轮数仍未结束";
        rep.rounds = round;
        return rep;
    }

    rep.ok = true;
    rep.rounds = round;
    for (auto& n : nodes_) {
        ComponentStatus s = n.comp->status();
        rep.state = worst(rep.state, s.state);
        for (const auto& note : s.notes) rep.notes.push_back(n.name + "：" + note);
        rep.node_status.push_back(s);
    }
    return rep;
}

}  // namespace cuav
