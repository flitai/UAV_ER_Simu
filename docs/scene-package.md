# 场景数据包规范

**状态**：目录布局、建筑字段、底图与数字高程模型（DEM）的共享资产形态、三份清单的字段已冻结
（2026-09-03）。建筑解码、区域总清单、质量报告的规则待 D0-3 至 D0-7 实现时补写。对应里程碑 D0。

**依据**：`CLAUDE.md` 铁律第 1、2、6、7、8、11、13、14 条；决策 D-002、D-010、D-021、D-022；
06 备忘录 §4。

---

## 1. 目录布局（已冻结，2026-09-03 修订）

底图与 DEM 是**全球性的共享资产**，只有一份，不按观测区域（AOI，Area of Interest）拆分。
这是决策 D-022：用户明确"128 GB 没有问题"，直接使用整份全球底图，存储不是约束。观测区域
目录只放该区域专属的数据。2026-09-04 按决策 D-023，这两份资源已拷入本项目自持，不再是指向
`/Users/zhiyu/CC/Airports/` 的软链，本项目因此不依赖外部工程的路径。

```
data/basemap/                    共享资产，一份供所有观测区域；本项目自持的真实文件（D-023）
  planet.pmtiles                 全球矢量底图，zoom 0 至 15，137370745450 字节（约 137.4 GB）。不入 git
  planet.manifest.json           底图身份：大小、全文件 sha256、planetiler 构建、OSM 快照、图层表、来源与形态。入 git
  dem/{z}/{x}/{y}.png            全球 DEM 瓦片，terrarium 编码，zoom 0 至 8，87381 个文件、7442617745 字节。不入 git
  dem.manifest.json              DEM 索引：逐层文件数、字节数、是否完整、索引哈希。入 git
data/scene/<aoi>/                每个观测区域一个目录
  manifest.json                  **数据包入口**：区域定义、共享资产引用、各产物哈希、溯源链、复跑命令。入 git
  buildings.geojson              建筑几何，同时驱动三维渲染与遮挡计算（D0-3）
  buildings.manifest.json        建筑产物的同构元数据。入 git
  osm-buildings-raw.json         原始 OSM 快照：对拍基准，以及 src 分档与 base_m 的来源。不入 git
  osm-buildings-raw.manifest.json  原始快照的同构元数据。入 git
  quality-report.md              质量报告，由脚本现算生成。入 git
  basemap-slice.pmtiles          可选。该区域 zoom 0 至 15 的底图小切片，只作测试夹具与没有全球
                                 文件的机器上的便携底图；区域之外是空白。不入 git
  basemap-slice.manifest.json    切片清单。入 git
scene/aoi/<aoi>.json             观测区域定义，是上述目录的输入。入 git
```

目录名与文件名必须是纯 ASCII，不含空格。`<aoi>` 只允许小写字母、数字与连字符。

### 1.1 观测区域定义 `scene/aoi/<aoi>.json`

| 字段 | 含义 |
|---|---|
| `id` | 与文件名一致，纯 ASCII |
| `name` | 可读名称 |
| `status` | `center` 谁定的、`extent` 是否为暂定（`PROVISIONAL`），以及说明 |
| `crs`、`coord_version` | 固定 `EPSG:4326`，WGS-84 经纬度；禁止 GCJ-02（铁律 1） |
| `bbox` | `[西, 南, 东, 北]`，单位度 |
| `center`、`extent_km` | 中心与近似尺寸，只供人读 |
| `evidence` | 位置核实依据（例如从底图瓦片解出的地名） |
| `replaces`、`replace_when` | 替代了什么、何时该重定 |

当前唯一的观测区域是 `beijing-yayuncun`（北京亚运村周围）：中心由用户 2026-09-03 指定
（D-021），范围由用户 2026-09-04 定为 20 × 20 km（D-024，实测 19.96 × 19.97 km）。取这个
尺寸的理由是单站置于中心时轴向到边界 10 公里、角向 14 公里，覆盖包络由传播条件截断而不是
由框子截断。

## 2. 建筑数据字段（已冻结）

`buildings.geojson` 的每个要素包含五个字段：

| 字段 | 含义 | 说明 |
|---|---|---|
| `id` | 建筑标识 | 后续用真实高度升级数据时，只改高度与 `src`，**不改 `id` 与几何** |
| `base_m` | 底面离地高差，单位米 | 不是海拔。禁止与 DEM 的海拔隐式相加（铁律 2） |
| `height_m` | 建筑高度，单位米 | 同上，离地高差 |
| `src` | 高度来源标记 | 真实标注与估算值必须区分。估算值标为 `est:*`，该标记必须随字段传到每一个下游产物（铁律 14）。当前取值见下表 |
| `footprint` | 底面轮廓多边形 | WGS-84 经纬度，坐标参考系 EPSG:4326 |

### 2.1 `src` 的当前取值（2026-09-04）

| 取值 | 含义 | 北京亚运村实测占比 |
|---|---|---|
| `osm:height` | OSM `height` 标签，真实标注 | 1.74% |
| `osm:levels` | OSM `building:levels` 折算，**层数 × 3 + 2 米**（+2 计入女儿墙与屋面构筑物，与 planetiler 一致；**与 em-demo 的 × 3.0 有意差 2 米**）。层数标注为 0 或负视为无效，退回面积估算 | 19.59% |
| `tile:height` | 瓦片 `height` 字段，且对不上原始标签。**它混合了真实标注与推导值**，两者在瓦片里分不开，所以不叫 `osm:height`（D-025）。只在数据漂移时出现 | 0.12% |
| `est:area` | 无高度，按占地面积确定性估高，分档沿用 em-demo `fetch-buildings.mjs` 的 `building=yes` 面积档 | 78.55% |

分档依据是 `scene/fetch_osm_buildings.py` 拉来的原始 OSM 标签，与瓦片按 `(类型, 编号)` 精确
对齐（瓦片 id 编码经实测为 `(类型 << 44) | OSM 编号`，类型 2 = way、3 = relation）。

升级路径：拿到更新的标签或人工数据后，只改 `height_m`、`base_m` 与 `src`，
**不改 `id` 与几何**。

`base_m` 几乎恒为 0（实测只有 9 栋非零），这不是缺陷而是数据源本身的空缺：瓦片里带
`min_height` 的 824 个要素**全部**是被剔除的 `building_part`；原始 OSM 在该区域也只有 7 个
要素带 `min_height`、4 个带 `building:min_level`。架空层信息在数据源里就没有。

## 3. 渲染与物理同源（已冻结）

`buildings.geojson` 是建筑几何的**单一来源**，同时驱动三维拉伸渲染和遮挡计算的桶网格。

瓦片里的 `buildings` 图层只作为观测区域**之外**的渲染回退，**永远不进入遮挡计算**。原因是
瓦片建筑经过切割简化，且缺失高度时被填了默认值，不适合用于计算（决策 D-002）。

## 4. 底图与 DEM 的提供方式（已冻结）

- 底图与 DEM 是本项目自持的真实文件，`scene/fetch_tiles.py` 的默认源即包内 `data/basemap/planet.pmtiles`；
  引用外部工程路径的写法一律视为错误（D-023）。
- 底图**必须经支持 HTTP Range 的服务**提供（铁律 7；继承的坑：Python 标准库的 `http.server`
  对 Range 返回整个文件，137 GB 文件下等于不可用）。Airports 的 `serve.py` 已在本机实测可用，
  本项目 `server/src/range.ts` 待实现（D1-1）。2026-09-03 实测：对整份全球文件请求
  `Range: bytes=0-15` 返回 206 与 `Content-Range: bytes 0-15/137370745450`。
- 切片与全球文件出自同一份档案、同一 OSM 快照，观测区域之内渲染结果应一致，差别只在区域之外。
  2026-09-03 实测切片可复现：同参数两次裁切的 sha256 相同。
- DEM 只作山体阴影的视觉效果，不进视距计算（铁律 2）。垂直基准仍是未决事项。

## 5. 三份清单的字段（已冻结）

`data/basemap/planet.manifest.json`（`schema = cuav-basemap-manifest/1`）：

| 字段 | 含义 |
|---|---|
| `role`、`canonical_path` | 角色说明；包内规范路径 |
| `storage` | 存放形态：`in_place` 包内自持真实文件 / `symlink` 包内路径是软链 / `external` 资源在包外 |
| `dev_link_target`、`origin`、`origin_note` | 软链指向（`in_place` 时为空）；副本的来源路径与说明 |
| `size_bytes`、`mtime_utc` | 文件大小与修改时间 |
| `header_sha256`、`header_sha256_first_bytes` | 文件前 16 KiB 的 sha256，秒级可算的身份 |
| `sha256`、`sha256_note` | 全文件 sha256 及其来源说明；137 GB 约需 5 分钟 |
| `pmtiles_spec_version`、`tile_type`、`bounds`、`minzoom`、`maxzoom`、`addressed_tiles`、`tile_entries`、`tile_contents`、`tile_compression` | 档案头 |
| `planetiler_version`、`planetiler_githash`、`planetiler_buildtime`、`osm_replication_time`、`osm_replication_seq`、`osm_replication_url` | 构建与数据快照身份 |
| `basemap_name`、`basemap_version`、`attribution`、`license_note` | 署名，ODbL 要求保留（铁律 13） |
| `vector_layers[]` | 每层 `id`、`minzoom`、`maxzoom`、`fields` |
| `serving_note`、`generated_at_utc`、`generator` | 提供方式提醒；生成时间；脚本、pmtiles 命令行版本、git 提交、平台 |

`data/basemap/dem.manifest.json`（`schema = cuav-dem-manifest/1`）：`role`、`canonical_path`、
`storage`、`dev_link_target`、`origin`、`encoding`、`vertical_datum`（OPEN）、`attribution`、`per_zoom{files, bytes, complete}`、
`files_total`、`bytes_total`、`index_sha256`（对"相对路径 + 字节数"有序列表的 sha256，不是内容哈希）、
`generated_at_utc`、`generator`。

`data/scene/<aoi>/basemap-slice.manifest.json`（`schema = cuav-scene-basemap-manifest/1`）：

| 字段 | 含义 |
|---|---|
| `aoi`、`aoi_definition_file` | 整份观测区域定义及其文件 |
| `crs`、`coord_version` | 交换用 WGS-84；瓦片网格为 Web Mercator XYZ |
| `source{...}` | 源档案身份，字段与 `planet.manifest.json` 同名；`sha256` 可由 `--source-sha256` 传入 |
| `extract{tool, tool_version, command, bbox, minzoom, maxzoom, overfetch, dry_run_*}` | 裁切参数与预估 |
| `output{file, size_bytes, sha256, bounds, minzoom, maxzoom, *_tiles, vector_layers, checks[]}` | 产物身份与六项自检结果 |
| `generated_at_utc`、`generator` | 同上 |

## 6. 建库脚本（已冻结的调用方式）

建库阶段可以联网，运行阶段不联网（铁律 6）。除 `shapely` 外只用 Python 标准库加 `pmtiles`
命令行；`shapely` 只在建库阶段用于多边形并集，运行时不依赖。完整复跑顺序也记在每个数据包的
`manifest.json` 的 `reproduce` 字段里。

```
# 一次性：登记全球底图与 DEM（--sha256 传入事先用 shasum -a 256 算好的值）
uv run python scene/register_basemap.py --planet data/basemap/planet.pmtiles --dem data/basemap/dem \
    --sha256 <hex> --origin <来源路径> --dem-origin <来源路径>

# 每个观测区域，按顺序
uv run python scene/fetch_tiles.py --aoi <id> --estimate              # 只估算切片体积
uv run python scene/fetch_tiles.py --aoi <id> [--force]               # 切片，只作测试夹具
uv run python scene/fetch_osm_buildings.py --aoi <id> [--force]       # 唯一联网步骤
uv run --with shapely python scene/decode_buildings.py --aoi <id> \
    --osm-tags data/scene/<id>/osm-buildings-raw.json [--force]       # 建筑几何与高度
uv run python scene/quality_report.py --aoi <id> [--force]            # 对拍与质量报告
uv run python scene/make_manifest.py --aoi <id> [--force]             # 数据包入口清单
sh scripts/check-ascii.sh data/scene data/basemap scene

# 只读探测，不写任何文件
uv run python scene/probe_buildings.py --aoi <id>
```

**联网边界**：上面只有 `fetch_osm_buildings.py` 联网，且只允许在建库阶段跑。运行阶段与交付
环境不联网。

各脚本对已存在的产物默认拒绝覆盖（铁律 10），要重做须显式加 `--force`；`fetch_tiles.py` 的
六项自检任一不过即退出并保留 `.part` 文件。

## 7. 已知的数据欠项

国内城市的开放街道地图（OSM）建筑高度覆盖率极低。西安 12 公里见方样本共 13593 栋建筑，
其中带 `height` 标签的占 1.0%，带 `levels` 标签的占 1.3%，96.1% 只有 `building=yes`。

北京亚运村 20 × 20 km 范围的最终结果见第 2.1 节：47582 栋建筑里真实 `height` 标注只有
1.74%，层数折算 19.59%，其余 78.55% 是按面积估算的。**近八成高度是估算值，不得用于验收指标。**

这个结论经过两步：先用瓦片的启发式判据估出「推导值约 19.4%、真实标注上界 3.7%」（D-025），
再用原始 OSM 标签验证（D-027），实际是 19.59% 与 1.74%。启发式的方向正确、上界成立，但
**只有原始标签能给出可用于标注 `src` 的定论**。

这意味着首批场景包里绝大多数建筑高度是估算值，必须带 `est:*` 标记。

## 8. 待写

- [x] 区域总清单 `manifest.json`（D0-6，2026-09-04），脚本 `scene/make_manifest.py`
- [x] 高度估算的分档规则（D0-3）：面积档，见 `scene/decode_buildings.py` 的 `estimate_height`
- [x] 跨瓦片去重的判定规则（D0-3）：按 id 合并，同 id 碎片做并集还原
- [x] 数据包的版本与校验方式（D0-6）：各产物 sha256 进总清单，共享资产按 sha256 引用
- [ ] DEM 的垂直基准（未决事项）
