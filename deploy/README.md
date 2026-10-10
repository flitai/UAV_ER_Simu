# deploy 目录

单机一体化包的组包脚本、启动器与冒烟测试（W-2，决策 D-099）。对应 04 号方案的 WP8。

## 已冻结

| 项 | 内容 | 依据 |
|---|---|---|
| 运行形态 | 浏览器加服务端。单机模式由本地启动器拉起应用服务并打开系统浏览器 | 04 §2.5、§6.5 |
| 不用 Tauri | 其自定义协议不支持 Range，且 WKWebView 明显慢于 Chrome | D-003 |
| 客户端与单机包 | Windows x64 优先 | D-015 |
| 集中部署服务端 | Windows 或 Linux x64 视情况选择 | D-016 |
| 启动器形态 | `start.bat` + 便携 Node | D-084 |
| 交付底图 | 北京市区域底图 + 全球概览（zoom 0–6），不带全球底图 | D-084 |
| 引擎运行库 | MSVC 静态链接（/MT），不依赖 VC++ 运行库 DLL | D-099 |
| 实测片段 | 每个类别一段，取自实测样本集（不取验证集），共 13 段 | D-099 |

## 文件

| 文件 | 作用 |
|---|---|
| `pack.py` | 组包。只用标准库，开发机与 Windows CI 都能跑 |
| `smoke.mjs` | 冒烟：用包自己的启动器起服务，跑几件演示必经的事，再停掉 |
| `pe_imports.py` | 读 Windows 可执行文件的导入表；`--forbid` 见到 VC++ 运行库即失败 |
| `iq-subset.json` | 进包的实测片段清单，由 `pack.py subset` 按写死的规则生成，审阅后入库 |
| `windows/start.bat` | 包根目录的启动脚本。**只含 ASCII、CRLF 换行** |
| `windows/launch.mjs` | 启动器本体：补环境变量、防重复启动、等服务监听成功再开浏览器 |
| `windows/README.template.txt` | 包内中文使用说明的模板（UTF-8 带 BOM、CRLF，记事本能正确显示） |
| `.cache/` | 下载的便携 Node 与 CI 引擎产物，按 sha256 核对后复用。不入 git |

## 包的布局

包根目录与仓库同构：服务按 `server/dist/../..` 找根，引擎子进程的工作目录就是根、参数全是相对路径
（D-042 ②）。每个文件放在它在仓库里的位置，另加启动器、便携 Node 与引擎二进制。

```
cuav-demo-<提交日期>-<短哈希>-win-x64/
  start.bat  launch.mjs  README.txt  THIRD-PARTY-NOTICES  package.manifest.json
  node/{node.exe, LICENSE}           便携 Node v22.23.3
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

`package.manifest.json` 列出包内每个文件的大小与 sha256、git 提交、引擎来源（CI 运行号、编译器）与 Node 版本。

## 组包

完整包只能在开发机上组：建筑集、区域底图、全球概览与实测片段都不在 git 里。

1. 提交全部改动并推送；等 CI 的 `build` 工作流跑完。包里每个文件都出自同一个提交：
   引擎产物的构建记录写着它出自哪个提交；与当前 HEAD 不同时，两者之间编进引擎的源（`ENGINE_SOURCES`：engine、geo、models、third_party、CI 配置）一个字节没变才照用，否则拒；包的来源目录（`PACKAGE_SOURCES`：deploy、server、web、models、engine、geo、third_party、data 等）里有未提交改动也拒，别处的改动不挡组包。
2. 查 CI 运行号：`gh run list --limit 3`。
3. 组包：

   ```sh
   uv run --quiet python deploy/pack.py build --scope full --engine-ci <运行号> --zip
   ```

   产物在 `dist/`：一个目录与同名 `.zip`。同一输入两次出包，压缩包逐字节相同。
4. 在开发机上验数据是全的（开发机跑不了 Windows 二进制，所以另组一份宿主二进制的包，**只验证、不交付**）：

   ```sh
   uv run --quiet python deploy/pack.py build --scope full --host
   node deploy/smoke.mjs dist/cuav-demo-<...>-host-darwin --full
   ```

改了实测片段的规则或批索引之后，先 `uv run --quiet python deploy/pack.py subset` 重新生成 `iq-subset.json`、
审阅后提交；清单与规则算出来的不一致时组包会拒。

## 组包前的检查

`pack.py` 在写清单与压缩包之前逐项检查，任何一项不过即拒：

| 检查 | 依据 |
|---|---|
| 建筑集、两份底图按清单的 sha256；DEM 按建库时同一口径的逐块索引哈希；每段实测片段按它的清单与批索引 | 铁律 10、15 |
| 三份基准场景记的场景数据包清单哈希等于包里那一份（引擎会核） | D-049 ⑦ |
| 包内文件名是不含空格的 ASCII | 铁律 15 |
| 包内全部文本文件不含机器路径 | 铁律 17 |
| `start.bat` 只含 ASCII、每行以 CRLF 结尾 | 本节「已知坑」第 1 条 |
| `cuav_run.exe` 不依赖 VC++ 运行库 | D-099 |
| `ws` 的版本等于锁文件与随包约定的 8.21.3 | D-032 |

## 持续集成

`.github/workflows/build.yml`：

- Windows 那一路编完引擎后跑 `pe_imports.py --forbid`，再上传产物 `cuav_run-win-x64`（`cuav_run.exe` 与 `cuav_run.build.json`）。
- `package-smoke`（windows-latest）：用这个产物组「程序部分」的包（`--scope program`，只取 git 里的文件），
  再用包自己的便携 Node 与启动器跑 `smoke.mjs`。

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
