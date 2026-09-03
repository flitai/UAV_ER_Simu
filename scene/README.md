# scene 目录

场景数据包的**生产脚本**。产物写入 `data/scene/<aoi>/`，规范见 `docs/scene-package.md`。

## 离线边界（铁律 6）

建库阶段**可以联网**，运行阶段**不联网**。因此 Overpass 查询、planet 抽取、依赖安装这类
联网动作**只允许出现在本目录**。交付环境不得依赖内容分发网络、在线字体、在线地图或
外部身份服务。

## 输入

| 输入 | 路径 | 说明 |
|---|---|---|
| 全球底图 | `/Users/zhiyu/CC/Airports/tiles/planet.pmtiles` | 128 GB，zoom 0 至 15，planetiler 0.10.2，OSM 快照 2026-08-17。只读 |
| 数字高程 | `/Users/zhiyu/CC/Airports/tiles/dem/{z}/{x}/{y}.png` | AWS terrarium，zoom 0 至 8，7.1 GB。只读 |
| 观测区域范围 | 待定 | 临时用 em-demo 的西安范围 `108.8805,34.2956,109.0005,34.4056` |

## 计划中的脚本（尚未编写）

| 脚本 | 作用 | 对应步骤 |
|---|---|---|
| `fetch_tiles.py` | 从本地 `planet.pmtiles` 按范围裁切底图 | D0-2 |
| `decode_buildings` | 解码 zoom 15 瓦片的 `buildings` 图层，跨瓦片合并去重，估算缺失高度 | D0-3 |
| `dem_subset.py` | 按范围拷贝数字高程瓦片 | D0-5 |
| `make_manifest.py` | 生成数据包清单，含各文件的 SHA-256 | D0-6 |

步骤详情见 `06.首期实施备忘录_v1.0.md` §4。

## 运行方式

用 uv 管理环境。建库阶段允许联网安装依赖（例如矢量瓦片解码库）。

```
uv run python scene/fetch_tiles.py --bbox W,S,E,N --maxzoom 15 --estimate
```
