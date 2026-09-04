# data/scene 目录

观测区域专属的场景数据，每个观测区域一个子目录。规范见 `docs/scene-package.md`，
生产脚本与区域定义见 `scene/`。底图与数字高程模型不在这里，它们是共享资产，见 `data/basemap/`。

目录名与文件名必须是纯 ASCII，不含空格。出包前跑 `scripts/check-ascii.sh data/scene`。

## 现状（2026-09-03）

| 目录 | 内容 | 状态 |
|---|---|---|
| `beijing-yayuncun/` | 北京亚运村周围，`116.288,39.900,116.522,40.080`，约 19.96 × 19.97 km（D-024） | **D0 已完成**。入口是 `manifest.json`；`buildings.geojson` 47582 栋、15909168 字节；`quality-report.md` 记对拍结果；大文件（建筑、切片、原始 OSM 快照）不入 git，各自的 `*.manifest.json` 入 git |

切片只是测试夹具与便携底图，正式底图是 `data/basemap/planet.pmtiles`（决策 D-022）。
