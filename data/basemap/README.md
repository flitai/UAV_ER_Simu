# data/basemap 目录

全球底图与全球数字高程模型（DEM），**共享资产**，只有一份，供所有观测区域使用。
2026-09-04 起这两份资源是**本项目自持的真实文件**，不再是指向 `/Users/zhiyu/CC/Airports/` 的
软链（决策 D-023），因此本项目在任何机器上都不依赖外部工程的路径。

规范见 `docs/scene-package.md` 第 1、4、5 节；登记脚本 `scene/register_basemap.py`。

| 文件 | 内容 | 体积 | 入 git |
|---|---|---|---|
| `planet.pmtiles` | Protomaps 全球矢量底图，zoom 0 至 15，9 个矢量图层 | 137370745450 字节（约 137.4 GB） | 否 |
| `planet.manifest.json` | 底图身份：全文件 sha256 `b4c46742…`、planetiler 0.10.2、OSM 快照 2026-08-17T04:00:00Z、图层表、来源与形态 | 约 10 KB | 是 |
| `dem/{z}/{x}/{y}.png` | AWS terrarium DEM 瓦片，zoom 0 至 8，87381 个文件，九层均完整 | 7442617745 字节（约 7.44 GB） | 否 |
| `dem.manifest.json` | DEM 逐层文件数、字节数、完整性与索引哈希 | 约 2 KB | 是 |

两份资源合计约 145 GB。来源是 `/Users/zhiyu/CC/Airports/tiles/`，那份保持只读留档，与本副本
逐字节相同（sha256 一致即为证）。清单里的 `storage` 字段记录形态：`in_place` 为包内自持，
`symlink` 为软链，`external` 为资源在包外。

## 区域底图 `regional/`（2026-09-28，W-3，决策 D-084）

交付用的可安装软件**不带**上面那 145 GB，只带一片区域底图。两份并存、互不覆盖：

| 文件 | 内容 | 入 git |
|---|---|---|
| `regional/beijing.pmtiles` | 北京市外包框 `115.41,39.44,117.51,41.06` 的 zoom 0 至 15，48567 块，96534098 字节 | 否 |
| `regional/beijing.manifest.json` | 来源（全球底图的 sha256 与 planetiler 构建）、抽取命令、六项自检、产物 sha256 | 是 |
| `regional/beijing-dem/{z}/{x}/{y}.png` | 与范围相交的 DEM，zoom 0 至 8，19 块，1592703 字节 | 否 |
| `regional/beijing-dem.manifest.json` | 逐层计数与字节、索引哈希 | 是 |
| `overview/world-z6.pmtiles` | **全球概览** zoom 0 至 6，3400 块，44779778 字节：配区域底图用，缩小到北京以外不再空白 | 否 |
| `overview/world-z6.manifest.json` | 同上的清单（第六项自检在 zoom 6 查 `earth` 图层，那一级没有 `buildings`） | 是 |

生成：`uv run python scene/build_regional_basemap.py --region beijing` 与 `--region world-z6`（范围定义 `scene/regions/*.json`，只读本地文件、不联网）。

**概览与区域底图合成一个数据源**（`web/src/scene/style/compositeTiles.ts`，协议 `cuavpm://`）：zoom ≤ 6 取概览、以上取区域底图。两份出自同一快照，北京范围内 zoom ≤ 6 的瓦片相同；样式 60 层照旧只绑一个 `pm` 数据源。zoom 7 以上、北京瓦片范围之外仍是空白。概览不带 DEM（全球 zoom 0–6 约 303 MB），山体阴影只在北京范围内。

**用哪一份由应用服务决定**（`server/src/basemap.ts`，端点 `GET /api/v1/basemap`，前端照它取、不写死）：
环境变量 `CUAV_BASEMAP=planet` 或 `=beijing` 点名；**不设时全球底图在就用它**（开发机的行为与以前逐字相同），
不在就用唯一的那份区域底图。点了名却不在盘上即报错，不退回另一份（铁律 15）。区域底图框外为空白，照实显示。

## 四条提醒

1. 底图必须经支持 HTTP Range 的服务提供（铁律 7）；用 Python 标准库 `http.server` 会对每个
   瓦片请求回传整个 137 GB 文件。
2. OpenStreetMap 数据按 ODbL 许可，署名必须随包保留（铁律 13）。
3. DEM 只作山体阴影的视觉效果，不进视距计算；建筑高度是离地高差，不得与 DEM 海拔隐式相加（铁律 2）。
4. 交付介质不必装下这 145 GB：交付包只带区域底图（上一节，D-084）。
