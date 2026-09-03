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
npm run build  编译到 dist/
npm start      运行编译产物
```

## 现状

骨架。只有一个健康检查端点 `/api/v1/health`，实测可用。`src/range.ts` 是 Range 文件服务的
占位文件，列出了实现时必须覆盖的情形，本身尚未实现。
