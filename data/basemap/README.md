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

## 四条提醒

1. 底图必须经支持 HTTP Range 的服务提供（铁律 7）；用 Python 标准库 `http.server` 会对每个
   瓦片请求回传整个 137 GB 文件。
2. OpenStreetMap 数据按 ODbL 许可，署名必须随包保留（铁律 13）。
3. DEM 只作山体阴影的视觉效果，不进视距计算；建筑高度是离地高差，不得与 DEM 海拔隐式相加（铁律 2）。
4. 交付介质须装得下这 145 GB，阶段 0 冻结平台基线时一并定。
