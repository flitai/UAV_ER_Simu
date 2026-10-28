# deploy 目录

单机一体化包的组包脚本、启动器与冒烟测试（W-2，决策 D-099；Electron 外壳与 Mac 版，D-111；程序形式与 DMG，D-112）。对应 04 号方案的 WP8。

## 已冻结

| 项 | 内容 | 依据 |
|---|---|---|
| 运行形态 | 浏览器加服务端。单机模式由本地启动器拉起应用服务并打开系统浏览器 | 04 §2.5、§6.5 |
| 不用 Tauri | 其自定义协议不支持 Range，且 WKWebView 明显慢于 Chrome | D-003 |
| 客户端与单机包 | Windows x64 优先 | D-015 |
| 集中部署服务端 | Windows 或 Linux x64 视情况选择 | D-016 |
| 启动器形态 | `start.bat` + 便携 Node | D-084 |
| 程序窗口 | Electron 外壳作主入口（Windows `app\CuavDemo.exe`、Mac `CuavDemo.app`），窗口里打开同一个本机地址；`start.bat` / `start.command` 加系统浏览器保留作备用 | D-111 |
| 目标平台 | `win-x64`（CI 的 MSVC 引擎）与 `mac-arm64`（CI 的 macOS 引擎，最低系统 13.0） | D-099、D-111 |
| 两种形式 | `--layout folder`（缺省，目录形式，带备用启动方式）与 `--layout app`（程序形式：运行环境放进程序里，Windows 压缩包展开即程序目录，Mac 出 DMG；首次运行拷到用户目录） | D-111、D-112 |
| 交付底图 | 北京市区域底图 + 全球概览（zoom 0–6），不带全球底图 | D-084 |
| 引擎运行库 | MSVC 静态链接（/MT），不依赖 VC++ 运行库 DLL | D-099 |
| 实测片段 | 每个类别一段，取自实测样本集（不取验证集），共 13 段 | D-099 |

## 文件

| 文件 | 作用 |
|---|---|
| `pack.py` | 组包。只用标准库，开发机与 Windows CI 都能跑 |
| `smoke.mjs` | 冒烟：用包自己的启动器起服务，跑几件演示必经的事，再停掉 |
| `pe_imports.py` | 读 Windows 可执行文件的导入表；`--forbid` 见到 VC++ 运行库即失败 |
| `electron/main.js`、`electron/package.json` | Electron 外壳：找包根目录、用 Electron 自带的 Node 以子进程起 `launch.mjs`、开窗口、退出时停服务（D-111） |
| `mac/start.command` | Mac 包的备用启动方式：用 `CuavDemo.app` 自带的 Node 起服务并打开系统浏览器。**只含 ASCII、LF 换行** |
| `mac/README.template.txt` | Mac 包内中文使用说明的模板（UTF-8、LF） |
| `windows/README.app.template.txt`、`mac/README.app.template.txt` | 程序形式的包内说明（D-112） |
| `iq-subset.json` | 进包的实测片段清单，由 `pack.py subset` 按写死的规则生成，审阅后入库 |
| `windows/start.bat` | 包根目录的启动脚本。**只含 ASCII、CRLF 换行** |
| `windows/launch.mjs` | 启动器本体（两个平台共用）：补环境变量、防重复启动、等服务监听成功再开浏览器；由外壳经 IPC 调起时报就绪、收 `stop` 即停 |
| `windows/README.template.txt` | 包内中文使用说明的模板（UTF-8 带 BOM、CRLF，记事本能正确显示） |
| `.cache/` | 下载的便携 Node、Electron 与 CI 引擎产物，按 sha256 核对后复用。不入 git |

## 包的布局

包根目录与仓库同构：服务按 `server/dist/../..` 找根，引擎子进程的工作目录就是根、参数全是相对路径
（D-042 ②）。每个文件放在它在仓库里的位置，另加启动器、便携 Node 与引擎二进制。

```
cuav-demo-<提交日期>-<短哈希>-win-x64/
  app/CuavDemo.exe ...               Electron v44.7.1 运行时（electron.exe 改名），外壳在 app/resources/app/
  start.bat  launch.mjs  README.txt  THIRD-PARTY-NOTICES  package.manifest.json
  node/{node.exe, LICENSE}           便携 Node v22.23.3（start.bat 用）
  bin/cuav_run.exe                   CI 上 MSVC 编出、静态链接运行库
  server/{package.json, dist/**/*.js, node_modules/ws/}
  web/dist/                          不带 .map
  models/                            识别库运行时读，两张 FIR 表导出时读
  data/basemap/regional/{beijing.pmtiles, beijing-dem/, *.manifest.json}
  data/basemap/overview/{world-z6.pmtiles, world-z6.manifest.json}
  data/scene/beijing-yayuncun/{manifest.json, buildings.geojson, buildings.manifest.json, scenarios/}
  data/iq/measured/{holdout.manifest.json, dronerfb/{index.manifest.json（裁剪）, 13 段实测片段}}
  data/{runs, diagrams, exports, tmp}/   空目录，运行时写入
```

Mac 包（`-mac-arm64`）的不同处：根目录是 `CuavDemo.app`（Electron 运行时，外壳在 `Contents/Resources/app/`，
`Info.plist` 改了名称与标识、整体重新做临时签名）与 `start.command`，没有 `node/`（备用启动方式用 `CuavDemo.app` 自带的 Node），
引擎是 `bin/cuav_run`（CI 的 macOS 一路编出，最低系统 13.0，只依赖系统库）。

**程序形式**（`--layout app`，D-112）：上面根目录下除外壳以外的东西（`launch.mjs`、`server/`、`web/`、`bin/`、`models/`、`data/`、
`THIRD-PARTY-NOTICES`）整体挪进程序里，另加 `payload.json`（包名与提交，外壳按它决定装到哪、要不要重装）：

```
cuav-demo-<…>-win-x64-app/              压缩包展开即是程序目录
  CuavDemo.exe ...  README.txt  package.manifest.json
  resources/app/                        外壳
  resources/payload/                    运行环境
cuav-demo-<…>-mac-arm64-app.dmg         卷里：CuavDemo.app、README.txt、package.manifest.json、「应用程序」快捷方式
  CuavDemo.app/Contents/Resources/payload/
```

首次运行外壳把 `payload/` 拷到 `%LOCALAPPDATA%\CuavDemo\runtime\<包名>`（Mac：`~/Library/Application Support/CuavDemo/runtime/<包名>`），
写完成标记 `.installed.json`，此后直接从那里运行；任务结果与导出也写在那里（菜单「文件 → 打开数据目录」）。
没有备用启动方式，端口由外壳从 8080 起自动选到 8099。

`package.manifest.json` 列出包内每个文件的大小与 sha256、git 提交、引擎来源（CI 运行号、编译器）、Node 与 Electron 版本；
Mac 包另列 `.app` 里的符号链接（`links`）。

## 组包

完整包只能在开发机上组：建筑集、区域底图、全球概览与实测片段都不在 git 里。

1. 提交全部改动并推送；等 CI 的 `build` 工作流跑完。包里每个文件都出自同一个提交：
   引擎产物的构建记录写着它出自哪个提交；与当前 HEAD 不同时，两者之间编进引擎的源（`ENGINE_SOURCES`：engine、geo、models、third_party、CI 配置）一个字节没变才照用，否则拒；包的来源目录（`PACKAGE_SOURCES`：deploy、server、web、models、engine、geo、third_party、data 等）里有未提交改动也拒，别处的改动不挡组包。
2. 查 CI 运行号：`gh run list --limit 3`。
3. 组包（Mac 包只能在 Mac 上组：要 `ditto` 解压保留符号链接、`codesign` 重新签名）：

   ```sh
   uv run --quiet python deploy/pack.py build --scope full --engine-ci <运行号> --zip
   uv run --quiet python deploy/pack.py build --target mac-arm64 --scope full --engine-ci <运行号> --zip
   # 程序形式（D-112）
   uv run --quiet python deploy/pack.py build --layout app --scope full --engine-ci <运行号> --zip
   uv run --quiet python deploy/pack.py build --target mac-arm64 --layout app --scope full --engine-ci <运行号> --dmg
   ```

   产物在 `dist/`：一个目录与同名 `.zip`。同一输入两次出包，压缩包逐字节相同。
4. 在开发机上验数据是全的（开发机跑不了 Windows 二进制，所以另组一份宿主二进制的包，**只验证、不交付**）：

   ```sh
   uv run --quiet python deploy/pack.py build --scope full --host
   node deploy/smoke.mjs dist/cuav-demo-<...>-host-darwin --full
   ```

   Mac 包可以在开发机上直接冒烟（含外壳的四项）：`node deploy/smoke.mjs dist/cuav-demo-<...>-mac-arm64 --full`；
   DMG 直接给 `.dmg`（只读挂载、从卷上打开程序，运行环境装到临时目录，跑完卸下）：`node deploy/smoke.mjs dist/<…>-mac-arm64-app.dmg --full`。
   不等 CI、只在本机试 Mac 包：先按最低系统单独编引擎
   `cmake -S engine -B engine/build-mac -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 && cmake --build engine/build-mac --parallel`，
   再用 `--engine-local` 组包（清单写 `deliverable: false`）。

### 在 Windows 上用本机编译的引擎组包

没有 CI 产物时（例如同事拿到源码在自己的 Windows 机上组包），引擎可以本机编：

1. 前提：Git、Python ≥ 3.11、Node.js 22（npm）、Visual Studio 2022 生成工具的「使用 C++ 的桌面开发」（含 CMake）。
   不在 git 里的数据（建筑集、两份底图与 DEM、13 段实测片段、便携 Node 压缩包）按仓库相对路径放进来。
2. `cd server && npm ci && npm run build`，`cd web && npm ci && npm run build`。
3. `cmake -S engine -B engine/build`，`cmake --build engine/build --config Release --parallel`（运行库 /MT 由引擎 CMake 设）。
4. `python deploy\pack.py build --scope full --engine-local --skip-build --zip`，再 `node deploy\smoke.mjs dist\<包目录> --full`。

`--engine-local` 只在 Windows 上可用，读 `engine/build/Release/cuav_run.exe`。本机构建没有构建记录，证不了 exe 出自哪个提交，
所以清单写 `source.kind = local`、`deliverable: false`：包能用，但只供本机自用；交付的包仍用 CI 产物。导入表检查照旧。

改了实测片段的规则或批索引之后，先 `uv run --quiet python deploy/pack.py subset` 重新生成 `iq-subset.json`、
审阅后提交；清单与规则算出来的不一致时组包会拒。

## 组包前的检查

`pack.py` 在写清单与压缩包之前逐项检查，任何一项不过即拒：

| 检查 | 依据 |
|---|---|
| 建筑集、两份底图按清单的 sha256；DEM 按建库时同一口径的逐块索引哈希；每段实测片段按它的清单与批索引 | 铁律 10、15 |
| 三份基准场景记的场景数据包清单哈希等于包里那一份（引擎会核） | D-049 ⑦ |
| 包内文件名是不含空格的 ASCII（`CuavDemo.app` 内部由 Electron 上游定名，只要求 ASCII） | 铁律 15 |
| 包内全部文本文件不含机器路径（Electron 运行时是上游原样文件，不扫；外壳照扫） | 铁律 17 |
| `start.bat` 只含 ASCII、每行以 CRLF 结尾；`start.command` 以 `#!/bin/sh` 开头、只用 LF | 本节「已知坑」第 1 条 |
| Mac 引擎只依赖系统库、最低系统不高于 13.0 | D-111 |
| `CuavDemo.app` 重新签名后 `codesign --verify --deep --strict` 通过 | D-111 |
| `cuav_run.exe` 不依赖 VC++ 运行库 | D-099 |
| `ws` 的版本等于锁文件与随包约定的 8.21.3 | D-032 |

## 持续集成

`.github/workflows/build.yml`：

- Windows 那一路编完引擎后跑 `pe_imports.py --forbid`，再上传产物 `cuav_run-win-x64`（`cuav_run.exe` 与 `cuav_run.build.json`）。
- macOS 那一路按 `MACOSX_DEPLOYMENT_TARGET=13.0` 编引擎，查依赖与最低系统，上传 `cuav_run-mac-arm64`（D-111）。
- `package-smoke`（Windows 与 macOS 各一个）：用这个产物组「程序部分」的包（`--scope program`，只取 git 里的文件），
  再用包自己的备用启动器跑 `smoke.mjs`，并打开 Electron 外壳：已有服务时直接用、空闲端口上自己起服务、退出时停服务。

CI 证明不了的，留 W-4 在干净的 Windows 机上验：构建机装着 Visual Studio，缺系统组件看不出来；
Edge 的实际渲染；断网运行；性能。

## Windows 上的已知坑

1. 启动脚本 `.bat` 由 cmd.exe 按系统代码页读。本项目的做法是 `start.bat` **只用 ASCII**，中文提示全部由
   `launch.mjs` 输出（Node 向控制台写的是 UTF-16，不受代码页影响）。换行必须是 CRLF；仓库的 `.gitattributes`
   是 `* -text`，入库字节就是包内字节。
2. 在 macOS 上用 zip 打包，中文文件名到 Windows 解压会乱码。包内文件名一律 ASCII，`pack.py` 出包前检查。
3. Windows 的原生构建无法在 macOS 上交叉完成，引擎取 CI 产物。
4. 包不能解压到 `C:\Program Files` 下面：运行时要在 `data/` 里写任务结果。包内 `README.txt` 写明了。
5. 关闭控制台窗口发的是 SIGHUP、Ctrl+Break 发 SIGBREAK；应用服务在 Windows 上把这两个也当作停止信号，
   运行中的任务因此能落终态。

## Electron 外壳与 Mac 版的已知坑（D-111）

1. **环境变量 `ELECTRON_RUN_AS_NODE` 设着时，外壳不是窗口程序而是一个 Node**（`CuavDemo.exe` / `Electron` 原地等标准输入）。
   从资源管理器或 Finder 打开不会有它；从 VS Code 之类 Electron 程序的终端里直接运行时会继承它，要先 `unset`。
   `smoke.mjs` 起外壳前会删掉它；`start.command` 正是靠它把同一个二进制当 Node 用。
2. **没有 Apple 开发者账号，Mac 版只做临时签名、不公证**。从网络收到的压缩包带隔离属性，第一次打开要放行
   （「系统设置 → 隐私与安全性 → 仍要打开」，或 `xattr -dr com.apple.quarantine <目录>`）。带隔离属性直接打开时
   系统可能把 `.app` 挪到临时位置运行（App Translocation），外壳找不到同目录的服务，会弹框说明怎么处理。
3. **Mac 的 `.app` 里有符号链接**（框架的 `Versions/Current` 等）。解压要用 `ditto`，打包把它们按 Unix 约定存成链接；
   当普通文件展开会破坏框架与签名，程序起不来。
4. **服务不放进外壳主进程**：放进去的话一次几十毫秒的抽取、导出或解调会卡住窗口。外壳经 IPC 等 `launch.mjs`
   报「就绪」，退出时发 `stop`，与关控制台窗口走同一条停止处理；外壳被强行结束时通道断开，服务同样会停。
5. 界面在视口宽度小于 1920 时收起两栏（加载时判一次）。外壳按屏幕工作区宽度设初始缩放
   `min(1, max(0.75, 宽 / 1920))`，14 英寸 MacBook Pro（1512）上是 0.7875。
6. **程序形式不能在程序所在位置写数据**（DMG 只读、「应用程序」与 Program Files 要管理员权限、Mac 对下载的程序可能临时隔离运行），
   所以首次运行拷一份运行环境到用户目录（约 0.4 GB）。换版本另拷一份（目录按包名），旧任务留在旧目录，不自动删。
7. Mac 程序形式的签名放在最后做：运行环境要先放进 `Contents/Resources/payload/`，签完再改签名就作废。
