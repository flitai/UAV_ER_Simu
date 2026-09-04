# scene 目录

场景数据的**生产脚本**与**观测区域定义**。产物写入 `data/basemap/`（共享资产）与
`data/scene/<aoi>/`（区域专属），规范见 `docs/scene-package.md`。

## 离线边界（铁律 6）

建库阶段**可以联网**，运行阶段**不联网**。因此 Overpass 查询、planet 抽取、依赖安装这类
联网动作**只允许出现在本目录**。交付环境不得依赖内容分发网络、在线字体、在线地图或
外部身份服务。

## 输入

| 输入 | 路径 | 说明 |
|---|---|---|
| 全球底图 | `data/basemap/planet.pmtiles` | 137370745450 字节，zoom 0 至 15，planetiler 0.10.2，OSM 快照 2026-08-17。**整份直接作为正式底图**（D-022），且已拷入本项目自持（D-023）。来源 `/Users/zhiyu/CC/Airports/tiles/planet.pmtiles`，那份只读留档 |
| 数字高程 | `data/basemap/dem/{z}/{x}/{y}.png` | AWS terrarium，zoom 0 至 8，87381 个文件、7442617745 字节，整层登记；同样已拷入本项目自持（D-023） |
| 观测区域 | `aoi/beijing-yayuncun.json` | 北京亚运村周围，中心 (116.405, 39.990)，`116.288,39.900,116.522,40.080`，实测 19.96 × 19.97 km；中心由用户 2026-09-03 指定（D-021），范围由用户 2026-09-04 定（D-024） |

## 脚本

| 脚本 | 作用 | 对应步骤 | 状态 |
|---|---|---|---|
| `register_basemap.py` | 把整份全球底图与 DEM 登记为共享资产：身份清单（大小、sha256、planetiler 构建、OSM 快照、图层表、存放形态与来源；DEM 逐层索引） | D0-2、D0-5 | 已完成 2026-09-03，2026-09-04 按 D-023 改登记包内自持文件 |
| `fetch_tiles.py` | 从本地 planet.pmtiles 按观测区域裁切 zoom 0 至 15 的小切片，六项自检，写清单。切片只作测试夹具与便携底图 | D0-2（切片） | 已完成 2026-09-03 |
| `probe_buildings.py` | 只读探测：统计观测区域内 z15 `buildings` 要素数、id 稳定性与高度来源分布。矢量瓦片的 protobuf 解析写在这里，`decode_buildings` 可直接复用 | D0-3 前置 | 已完成 2026-09-04 |
| `decode_buildings` | 解码 zoom 15 瓦片的 `buildings` 图层，跨瓦片合并去重，估算缺失高度 | D0-3 | 未写 |
| `make_manifest.py` | 生成区域总清单，含所引用底图与 DEM 的 sha256 | D0-6 | 未写 |

步骤详情见 `06.首期实施备忘录_v1.0.md` §4。

## 运行方式

用 uv 管理环境。两个已有脚本只用 Python 标准库加 `pmtiles` 命令行（macOS `brew install pmtiles`）。

```
uv run python scene/register_basemap.py --planet data/basemap/planet.pmtiles --dem data/basemap/dem --sha256 <hex>
uv run python scene/fetch_tiles.py --aoi beijing-yayuncun --estimate
uv run python scene/fetch_tiles.py --aoi beijing-yayuncun [--force] [--source-sha256 <hex>]
```
