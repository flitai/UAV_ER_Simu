# data/basemap 目录

全球底图与全球数字高程模型（DEM），**共享资产**，只有一份，供所有观测区域使用。
规范见 `docs/scene-package.md` 第 1、4、5 节；登记脚本 `scene/register_basemap.py`。

| 文件 | 内容 | 入 git |
|---|---|---|
| `planet.pmtiles` | Protomaps 全球矢量底图，zoom 0 至 15，137370745450 字节。开发机上是指向 `/Users/zhiyu/CC/Airports/tiles/planet.pmtiles` 的软链；目标机上放真实文件 | 否 |
| `planet.manifest.json` | 底图身份：全文件 sha256 `b4c46742…`、planetiler 0.10.2、OSM 快照 2026-08-17T04:00:00Z、9 个矢量图层 | 是 |
| `dem/` | AWS terrarium DEM 瓦片，zoom 0 至 8，87381 个文件。开发机上是软链 | 否 |
| `dem.manifest.json` | DEM 逐层索引与索引哈希 | 是 |

## 三条提醒

1. 底图必须经支持 HTTP Range 的服务提供（铁律 7）；用 Python 标准库 `http.server` 会对每个
   瓦片请求回传整个 137 GB 文件。
2. OpenStreetMap 数据按 ODbL 许可，署名必须随包保留（铁律 13）。
3. DEM 只作山体阴影的视觉效果，不进视距计算；建筑高度是离地高差，不得与 DEM 海拔隐式相加（铁律 2）。
