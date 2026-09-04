# server 目录

应用服务。Node 加 TypeScript。

## 已冻结的约束

| 约束 | 内容 | 依据 |
|---|---|---|
| 协议 | REST 加 WebSocket | 04 §6.3 |
| 事件可补取 | WebSocket 事件带序号，断线后可按序号补取 | 04 §8.6 |
| **必须支持 HTTP Range** | PMTiles 依赖 Range 请求。参考实现是 Airports 的 `serve.py` | 04 §8.6 |
| 数据库 | 单机用 SQLite，内网用 PostgreSQL | 04 §6.3 |
| 平台 | Windows 或 Linux x64，二者都进持续集成 | 决策 D-016 |

## 尚未决定

Web 框架选型。目前**零运行时依赖**，只用 Node 内置模块。推迟到 P2 阶段的框图平台设计
报告一并决定。

## 命令

```
npm run dev    开发模式，改动自动重启
npm run build  编译到 dist/（不含测试文件）
npm start      运行编译产物
npm test       30 项测试：Range 解析 13 项、静态服务与路由 17 项
```

## 现状（2026-09-04，里程碑 D1-1）

已实现显示子线需要的最小集合，端点表与 Range 语义见 `docs/api-versions.md` 第 3 节。

| 模块 | 内容 |
|---|---|
| `src/range.ts` | Range 解析。单区间、开区间、后缀区间、416 越界、多区间按无 Range 处理 |
| `src/static.ts` | 静态文件下发、MIME、HEAD、路径穿越防护 |
| `src/index.ts` | 路由：健康检查、场景数据包接口、`/data/` 静态、前端产物 |

三条硬约束都有测试守着：底图必须经 Range 下发；`data/iq/` 不暴露（铁律 7）；
只服务显式声明的根目录，解析后落在根外一律 403。

### 一处踩过的坑

入口判定原先写成 `import.meta.url === \`file://${process.argv[1]}\``，服务会静默不启动。
根因是仓库根目录名里有空格，`import.meta.url` 把它编码成 `%20`，字符串比较永远不相等。
已改用 `pathToFileURL(process.argv[1]).href`。凡是拼 `file://` 的地方都要注意这一条。
