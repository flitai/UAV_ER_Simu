# 应用服务接口规范

**状态**：骨架，绝大部分待写。第 2、3 节列出的是已冻结的硬性约束，不是完整接口表。

**依据**：`CLAUDE.md` 铁律第 7 条；04 号方案 §6.3、§8.6；决策 D-003。

---

## 1. 版本策略（待写）

需要定：版本号放在路径里还是请求头里；不兼容变更的判定标准；旧版本的下线周期。

## 2. 已冻结的硬性约束

| 约束 | 内容 | 依据 |
|---|---|---|
| 传输协议 | REST 加 WebSocket | 04 §6.3 |
| 事件可补取 | WebSocket 事件必须带序号，断线后可按序号补取遗漏事件 | 04 §8.6 |
| 必须支持 Range | 服务端必须支持 HTTP Range 请求，因为 PMTiles 依赖它。参考实现是 Airports 项目的 `serve.py` | 04 §8.6，D-003 |
| 浏览器不收原始 IQ | 浏览器只接收控制、状态，以及按视窗（时间窗、频段、像素宽度、统计量）抽取后的展示数据 | 铁律 7 |
| 大文件传输 | 分片续传。禁止用 JSON 或 Base64 封装二进制数据 | 铁律 7 |
| 浏览器不缓存原始 IQ | 同上 | 铁律 7 |

## 3. 端点清单（待写）

参考实现：`C-UAV Model Demo/emcore/` 中的 `emsvc` 提供了五个端点，可作为命名与返回结构
的参考，但本系统的端点集合与之不同。

```
/api/v1/health
/api/v1/models/catalog
/api/v1/radar/detect
/api/v1/signal/detect
/api/v1/los/check
```

**待写**：项目管理、试验管理、任务调度、框图存取、组件目录、运行控制、结果查询、
文件上传下载、审计日志各自的端点。

## 4. WebSocket 事件（待写）

**待写**：事件类型清单、序号语义、补取协议、背压处理。

## 5. 后置能力的端口命名预留（待写）

05 号方案 P0 定义的八个端口在首期只做命名预留，不实现：`ArrayIQStream`、
`MultiSiteIQSet`、`ChannelPathSet`、`CalibrationSet`、`BearingReport`、`PositionReport`、
`TrackReport`、`DeviceStatus`。

例外：`ChannelPathSet` 首期即启用（决策 D-013），单径与双径也走这个端口，避免后置阶段
再改接口。

## 6. 待写清单

- [ ] 第 1 节 版本策略
- [ ] 第 3 节 端点清单
- [ ] 第 4 节 WebSocket 事件
- [ ] 鉴权与审计（P2 阶段）
