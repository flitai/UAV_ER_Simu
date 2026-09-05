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

## 依赖

**零运行时依赖**，只用 Node 内置模块；B-6 起只加 `ws`（决策 D-032）。不引入 Web 框架。

## 命令与环境变量

```
npm run dev    开发模式，改动自动重启
npm run build  编译到 dist/（不含测试文件与 src/tasks/testkit.ts）
npm start      运行编译产物
npm test       58 项测试：Range 13、静态与路由 17、引擎封装 6、解析与脱敏 4、任务管理器 13、HTTP 端点 4、真引擎集成 1
```

| 环境变量 | 缺省 | 作用 |
|---|---|---|
| `PORT` / `HOST` | 8080 / 127.0.0.1 | 监听地址 |
| `CUAV_RUN` | `<仓库根>/engine/build/cuav_run`（Windows 加 `.exe`） | 引擎二进制 |
| `CUAV_MAX_CONCURRENT_TASKS` | 1 | 同时运行的任务数；其余排队 |

## 现状（2026-09-05，D1-1 + B-5）

端点表见 `docs/api-versions.md` 第 3 节（3.1 静态与场景、3.1a 组件目录与任务）。

| 模块 | 内容 |
|---|---|
| `src/range.ts` | Range 解析。单区间、开区间、后缀区间、416 越界、多区间按无 Range 处理 |
| `src/static.ts` | 静态文件下发、MIME、HEAD、路径穿越防护 |
| `src/index.ts` | 路由：健康检查（含 `engine` 字段）、场景数据包接口、`/data/` 静态、前端产物；任务路由交 `tasks/routes.ts`；`start()` 里做任务扫描、对账与退出处理器 |
| `src/tasks/engine.ts` | `cuav_run` 子进程封装：数组参数不走 shell、cwd = 仓库根、字节级切行去 `\r`、目录缓存、只校验 |
| `src/tasks/resolve.ts` | 数据索引扫描、`data_id → 相对清单路径`、解析旁挂、整行脱敏（仓库根前缀与清单路径都不出服务端） |
| `src/tasks/store.ts` | 任务目录、`task.json`（`cuav-task/1`）原子写、事件折叠、启动扫描与对账 |
| `src/tasks/manager.ts` | 状态机 `queued → running → finished / failed / cancelled`、FIFO 队列、事件环形缓冲（B-6 在其上加 WS）、取消、退出收尾 |
| `src/tasks/routes.ts` | `GET /components`、`POST /tasks`、`GET /tasks[/{id}]`、`POST /tasks/{id}/cancel` 的 HTTP 层 |
| `src/tasks/fake_engine.mjs` | 测试夹具：与 `cuav_run` 同构的假引擎，模式由框图 `name` 选（`fake:hang` 等），没有 C++ 构建也能测状态机 |

硬约束都有测试守着：底图必须经 Range 下发；`data/iq/` 不暴露（铁律 7）；只服务显式声明的根目录，
解析后落在根外一律 403；框图里出现内部参数即 400（D-037）；事件里不出现服务器路径（04 §8.6）；
真引擎集成测试在 `engine/build/cuav_run` 不存在时跳过并说明原因。

### 传给引擎的路径为什么都是相对的

引擎的 `main(int, char**)` 在 Windows 上收 ANSI 码页参数，仓库根若含中文或空格就会出问题。所以子进程 cwd 设为仓库根，
所有参数与旁挂里的路径都写成 `data/runs/<task_id>/…`、`data/iq/measured/<batch>/<data_id>.manifest.json` 这种仓库相对、
`/` 分隔、纯 ASCII 的形式，**禁止用 `path.join` 拼引擎参数**（Windows 会出 `\`，而引擎的 `make_dirs` 只按 `/` 切分）。

### 一处踩过的坑

入口判定原先写成 `import.meta.url === \`file://${process.argv[1]}\``，服务会静默不启动。
根因是仓库根目录名里有空格，`import.meta.url` 把它编码成 `%20`，字符串比较永远不相等。
已改用 `pathToFileURL(process.argv[1]).href`。凡是拼 `file://` 的地方都要注意这一条。
