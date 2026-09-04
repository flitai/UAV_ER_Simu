#!/usr/bin/env python3
"""D0-3：从本地全球底图的 z15 瓦片解码 `buildings` 图层，跨瓦片按 id 合并，产出 buildings.geojson。

产物 `data/scene/<aoi>/buildings.geojson` 是建筑几何的**单一来源**，同时驱动三维拉伸渲染与
遮挡计算的桶网格（铁律 11）。字段规范见 `docs/scene-package.md` 第 2 节，五个字段
`{id, base_m, height_m, src, footprint}` 已冻结。

用法
    uv run --with shapely python scene/decode_buildings.py --aoi beijing-yayuncun [--force]

依赖：Python 标准库 + `pmtiles` 命令行 + `shapely`。shapely 只在建库阶段用（铁律 6 允许），
运行时不依赖。矢量瓦片的 protobuf 解析复用 `scene/probe_buildings.py`。

## 四条已实测的处理规则

1. **跨瓦片合并按 id 做**（D-025）。z15 建筑要素带稳定 id，实测 5.9 万要素无一缺 id。跨瓦片
   的建筑在每块瓦片里都被裁剪过，因此把同 id 的各片做并集还原，而不是任选一片——任选会留下
   沿瓦片边界的直边，那是假的墙。
2. **只保留 `kind=building`**。`building_part` 是同一栋楼的子体量，保留会重复计入；`address`
   是点要素不是轮廓。实测抽样：building 与 building_part 是面（几何类型 3），address 是点。
3. **高度来源不得标 `osm:height`**（D-025）。瓦片的 `height` 字段把真实标注与 planetiler 按
   `building:levels x 3 + 2` 推导的值混在一起，二者在瓦片里分不开，所以一律标 `tile:height`，
   真实来源等 D0-4 拉 Overpass 原始标签后再升级（只改 `src` 与高度，不改 id 与几何）。
4. **无高度的按占地面积确定性估高**，标 `est:area`（铁律 14：估算值必须可识别）。分档沿用
   em-demo `scripts/fetch-buildings.mjs` 的 `building=yes` 面积档；瓦片没有用途标签
   （实测 `kind_detail` 对 building 全为空），所以用不上它的用途档。

与 em-demo 参考实现的**两处有意偏离**，都记在这里以免被当成 bug：
  - em-demo 的伪随机种子取轮廓首个顶点，本脚本取质心（四舍五入到 6 位小数）。原因是并集后
    顶点顺序可能随几何库版本变化，质心不会，产物因此可复现。
  - em-demo 无 id，本脚本的 id 来自瓦片且稳定，这是后续只升级高度、不动几何的前提。
"""
import argparse
import collections
import hashlib
import json
import math
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_tiles import (ROOT, DEFAULT_PLANET, HEADER_HASH_BYTES, die, info, need_pmtiles,  # noqa: E402
                         load_aoi, tile_xy, extent_km, show_header, sha256_of, git_commit,
                         utc_now, pmtiles_version)
from probe_buildings import read_tile, fields, value_of, varint  # noqa: E402

try:
    from shapely.geometry import Polygon, MultiPolygon, shape, mapping
    from shapely.ops import unary_union
except ImportError:
    die("需要 shapely：uv run --with shapely python scene/decode_buildings.py ...")

SCHEMA = "cuav-scene-buildings-manifest/1"
COORD_DECIMALS = 6          # 约 0.1 m，够建筑轮廓，且显著缩小产物
LEVEL_HEIGHT_M = 3.0
MVT_EXTENT_DEFAULT = 4096


# ---------------------------------------------------------------------------
# 瓦片几何
# ---------------------------------------------------------------------------
def decode_geometry(d: bytes, span, extent: int, z: int, tx: int, ty: int):
    """解 MVT 几何命令流，返回环列表 [(ring, 有向面积), ...]，坐标已转 WGS-84 经纬度。

    命令整数 = (命令号 & 0x7) | (重复次数 << 3)；1=MoveTo 2=LineTo 7=ClosePath。
    坐标是 zigzag 编码的增量。多边形按 v2 规范：外环在瓦片坐标系（y 向下）中有向面积为正。
    """
    gs, ge = span
    i = gs
    x = y = 0
    rings = []
    cur = []
    n = 2 ** z
    while i < ge:
        cmd, i = varint(d, i)
        op, count = cmd & 0x7, cmd >> 3
        if op == 1:                                     # MoveTo：起一个新环
            for _ in range(count):
                dx, i = varint(d, i); dy, i = varint(d, i)
                x += (dx >> 1) ^ -(dx & 1)
                y += (dy >> 1) ^ -(dy & 1)
                if cur:
                    rings.append(cur)
                cur = [(x, y)]
        elif op == 2:                                   # LineTo
            for _ in range(count):
                dx, i = varint(d, i); dy, i = varint(d, i)
                x += (dx >> 1) ^ -(dx & 1)
                y += (dy >> 1) ^ -(dy & 1)
                cur.append((x, y))
        elif op == 7:                                   # ClosePath
            if cur:
                rings.append(cur)
                cur = []
        else:
            raise ValueError(f"未知几何命令 {op}")
    if cur:
        rings.append(cur)

    out = []
    for r in rings:
        if len(r) < 3:
            continue
        a2 = 0.0                                        # 瓦片坐标系下的有向面积（判内外环用）
        for j in range(len(r)):
            x0, y0 = r[j]
            x1, y1 = r[(j + 1) % len(r)]
            a2 += x0 * y1 - x1 * y0
        lonlat = []
        for px, py in r:
            wx = (tx + px / extent) / n
            wy = (ty + py / extent) / n
            lon = wx * 360.0 - 180.0
            lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * wy))))
            lonlat.append((lon, lat))
        out.append((lonlat, a2 / 2.0))
    return out


def rings_to_polygons(rings):
    """按 MVT v2 的环序规则拼多边形：有向面积为正的是外环，负的是紧随其后的洞。"""
    polys = []
    shell = None
    holes = []
    for ring, area in rings:
        if area > 0:
            if shell is not None:
                polys.append((shell, holes))
            shell, holes = ring, []
        else:
            if shell is not None:
                holes.append(ring)
    if shell is not None:
        polys.append((shell, holes))
    geoms = []
    for shell, holes in polys:
        try:
            p = Polygon(shell, holes)
            if not p.is_valid:
                p = p.buffer(0)
            if not p.is_empty and p.area > 0:
                geoms.append(p)
        except Exception:
            continue
    return geoms


# ---------------------------------------------------------------------------
# 单块瓦片
# ---------------------------------------------------------------------------
def scan_tile(d: bytes, z: int, tx: int, ty: int):
    """产出 {id: {"geoms": [...], "height": v, "min_height": v}}，只取 kind=building 的面要素。"""
    found = {}
    for no, (wt, val) in fields(d, 0, len(d)):
        if no != 3 or wt != "b":
            continue
        ls, le = val
        name, feats, keys, vals, extent = None, [], [], [], MVT_EXTENT_DEFAULT
        for fno, (fwt, fval) in fields(d, ls, le):
            if fno == 1 and fwt == "b":
                name = d[fval[0]:fval[1]].decode("utf-8", "ignore")
            elif fno == 2 and fwt == "b":
                feats.append(fval)
            elif fno == 3 and fwt == "b":
                keys.append(d[fval[0]:fval[1]].decode("utf-8", "ignore"))
            elif fno == 4 and fwt == "b":
                vals.append(fval)
            elif fno == 5 and fwt == "v":
                extent = fval
        if name != "buildings":
            continue
        ki = {k: i for i, k in enumerate(keys)}
        for fs, fe in feats:
            fid, tags, gtype, gspan = None, [], None, None
            for fno, (fwt, fval) in fields(d, fs, fe):
                if fno == 1 and fwt == "v":
                    fid = fval
                elif fno == 2 and fwt == "b":
                    ts, te = fval
                    i = ts
                    while i < te:
                        t, i = varint(d, i)
                        tags.append(t)
                elif fno == 3 and fwt == "v":
                    gtype = fval
                elif fno == 4 and fwt == "b":
                    gspan = fval
            if fid is None or gtype != 3 or gspan is None:      # 只要面要素
                continue
            pairs = dict(zip(tags[0::2], tags[1::2]))

            def attr(key):
                idx = ki.get(key)
                return value_of(d, vals[pairs[idx]]) if idx is not None and idx in pairs else None

            if attr("kind") != "building":                      # 剔除 building_part 与 address
                continue
            geoms = rings_to_polygons(decode_geometry(d, gspan, extent, z, tx, ty))
            if not geoms:
                continue
            rec = found.setdefault(fid, {"geoms": [], "height": None, "min_height": None})
            rec["geoms"].extend(geoms)
            for k in ("height", "min_height"):
                v = attr(k)
                if isinstance(v, (int, float)) and rec[k] is None:
                    rec[k] = float(v)
    return found


# ---------------------------------------------------------------------------
# 高度
# ---------------------------------------------------------------------------
def hash01(lon: float, lat: float) -> float:
    """确定性伪随机 [0,1)，与 em-demo fetch-buildings.mjs 同式；同一坐标每次结果一致。"""
    x = math.sin(lon * 12.9898 + lat * 78.233) * 43758.5453
    return x - math.floor(x)


def estimate_height(area_m2: float, lon: float, lat: float) -> float:
    """按占地面积分档估高。档位沿用 em-demo 的 building=yes 面积档。"""
    r = hash01(lon, lat)
    if area_m2 < 50:        lo, hi = 3, 5        # 附属、棚屋
    elif area_m2 < 200:     lo, hi = 6, 12       # 低层
    elif area_m2 < 800:     lo, hi = 12, 30      # 城市中高层住宅主流档
    elif area_m2 < 3000:    lo, hi = 18, 45      # 板楼、办公
    else:                   lo, hi = 12, 28      # 大底盘裙房、商业综合体，控制不过高
    return float(round(lo + r * (hi - lo)))


def area_m2(geom, lat0: float) -> float:
    """度²面积换算成平方米，用区域中心纬度的局地尺度。"""
    return geom.area * 111320.0 * (111320.0 * math.cos(math.radians(lat0)))


def round_geom(geom, nd: int):
    return shape(json.loads(json.dumps(mapping(geom)), parse_float=lambda s: round(float(s), nd)))


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="解码 z15 建筑图层并按 id 跨瓦片合并（D0-3）")
    ap.add_argument("--aoi")
    ap.add_argument("--bbox")
    ap.add_argument("--name")
    ap.add_argument("--planet", default=DEFAULT_PLANET)
    ap.add_argument("--zoom", type=int, default=15)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--out")
    ap.add_argument("--force", action="store_true", help="覆盖已有产物（否则拒绝，铁律 10）")
    a = ap.parse_args()

    aoi = load_aoi(a)
    bbox = aoi["bbox"]
    if not os.path.isfile(a.planet):
        die(f"底图不存在：{a.planet}")
    exe = need_pmtiles()
    out = a.out or os.path.join(ROOT, "data", "scene", aoi["id"], "buildings.geojson")
    man = os.path.join(os.path.dirname(out), "buildings.manifest.json")
    if os.path.exists(out) and not a.force:
        die(f"产物已存在：{out}\n  不静默覆盖既有产物（铁律 10）。确认要重做请加 --force。")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    z = a.zoom
    x0, y1 = tile_xy(bbox[0], bbox[1], z)
    x1, y0 = tile_xy(bbox[2], bbox[3], z)
    tiles = [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    n = 2 ** z
    cover = [x0 / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y1 + 1) / n)))),
             (x1 + 1) / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y0 / n))))]
    km = extent_km(bbox)
    info(f"区域 {aoi['id']}  bbox {bbox}  约 {km[0]} x {km[1]} km")
    info(f"z{z} 瓦片 {len(tiles)} 块，瓦片对齐后的实际覆盖 {[round(v, 6) for v in cover]}")

    info("解码瓦片……")
    merged, empty = {}, 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for (tz, tx, ty), d in zip(tiles, ex.map(lambda t: read_tile(exe, a.planet, *t), tiles)):
            if d is None:
                empty += 1
                continue
            for fid, rec in scan_tile(d, tz, tx, ty).items():
                m = merged.setdefault(fid, {"geoms": [], "height": None, "min_height": None, "tiles": 0})
                m["geoms"].extend(rec["geoms"])
                m["tiles"] += 1
                for k in ("height", "min_height"):
                    if m[k] is None:
                        m[k] = rec[k]

    pieces = sum(len(v["geoms"]) for v in merged.values())
    multi = sum(1 for v in merged.values() if v["tiles"] > 1)
    info(f"要素 {pieces} 片（含跨瓦片重复），唯一 id {len(merged)}，其中 {multi} 个跨瓦片需合并")

    info("合并与估高……")
    lat0 = (bbox[1] + bbox[3]) / 2
    feats, stats = [], collections.Counter()
    heights, areas, unioned_multi = [], [], 0
    for fid in sorted(merged):
        rec = merged[fid]
        g = rec["geoms"][0] if len(rec["geoms"]) == 1 else unary_union(rec["geoms"])
        if g.is_empty:
            stats["dropped_empty"] += 1
            continue
        if not g.is_valid:
            g = g.buffer(0)
        if isinstance(g, MultiPolygon):
            unioned_multi += 1
        elif not isinstance(g, Polygon):
            stats["dropped_bad_geom"] += 1
            continue
        g = round_geom(g, COORD_DECIMALS)
        if g.is_empty or g.area <= 0:
            stats["dropped_empty"] += 1
            continue
        am2 = area_m2(g, lat0)
        c = g.centroid
        clon, clat = round(c.x, COORD_DECIMALS), round(c.y, COORD_DECIMALS)
        h = rec["height"]
        if isinstance(h, (int, float)) and h > 0:
            height_m, src = float(h), "tile:height"
        else:
            height_m, src = estimate_height(am2, clon, clat), "est:area"
        base = rec["min_height"]
        base_m = float(base) if isinstance(base, (int, float)) and base > 0 else 0.0
        if base_m >= height_m:                      # 数据自相矛盾，不静默修正
            stats["base_ge_height"] += 1
        stats[src] += 1
        if base_m > 0:
            stats["base_nonzero"] += 1
        gj = mapping(g)
        polys = [gj["coordinates"]] if gj["type"] == "Polygon" else gj["coordinates"]
        if any(len(pp) > 1 for pp in polys):
            stats["with_holes"] += 1
        stats["vertices"] += sum(len(r) for pp in polys for r in pp)
        heights.append(height_m)
        areas.append(am2)
        feats.append({"type": "Feature", "id": fid,
                      "properties": {"id": fid, "base_m": base_m, "height_m": height_m, "src": src},
                      "geometry": gj})

    fc = {"type": "FeatureCollection", "bbox": [round(v, 6) for v in cover],
          "name": f"{aoi['id']}-buildings", "features": feats}
    tmp = out + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, out)

    def q(v, p):
        v = sorted(v)
        return round(v[min(len(v) - 1, int(len(v) * p))], 2) if v else None

    src_dist = {k: stats[k] for k in ("tile:height", "est:area") if stats[k]}
    hdr = show_header(exe, a.planet)
    manifest = {
        "schema": SCHEMA, "product": "buildings.geojson",
        "role": "建筑几何的单一来源，同时驱动三维拉伸渲染与遮挡桶网格（铁律 11）",
        "aoi": {k: v for k, v in aoi.items() if not k.startswith("_")},
        "aoi_definition_file": aoi.get("_definition_file"),
        "crs": "EPSG:4326", "coord_decimals": COORD_DECIMALS,
        "coord_version": "WGS-84 经纬度（度）；由 Web Mercator 瓦片坐标反投影而来，铁律 1",
        "coverage_bbox": [round(v, 6) for v in cover],
        "coverage_note": "瓦片对齐后的实际覆盖范围，略大于 AOI；边界外的建筑保留，供边缘站点的视距计算使用",
        "source": {"path": os.path.abspath(a.planet), "zoom": z, "tiles": len(tiles), "empty_tiles": empty,
                   "layer": "buildings", "header_sha256": sha256_of(a.planet, HEADER_HASH_BYTES),
                   "planetiler_version": hdr.get("planetiler:version"),
                   "osm_replication_time": hdr.get("planetiler:osm:osmosisreplicationtime"),
                   "osm_replication_seq": hdr.get("planetiler:osm:osmosisreplicationseq"),
                   "attribution": hdr.get("attribution")},
        "rules": {
            "kept_kind": "building",
            "dropped_kinds": ["building_part", "address"],
            "merge": "同 id 的各瓦片碎片做并集还原（D-025：z15 要素带稳定 id）",
            "height_from_tile": "src=tile:height。瓦片 height 字段混合了真实标注与 planetiler 按 building:levels x 3 + 2 推导的值，二者在瓦片里分不开，故不得标 osm:height（D-025）",
            "height_estimated": "src=est:area。无高度者按占地面积确定性估高，分档沿用 em-demo fetch-buildings.mjs 的 building=yes 面积档；瓦片无用途标签（实测 kind_detail 对 building 全为空）",
            "estimate_seed": "hash01(质心经纬度)，与 em-demo 同式但种子取质心而非首顶点，使产物不随几何库的顶点顺序变化",
            "upgrade_path": "D0-4 拉 Overpass 原始标签后只升级 height_m 与 src，不改 id 与几何",
        },
        "output": {"file": os.path.basename(out), "size_bytes": os.path.getsize(out),
                   "sha256": sha256_of(out), "features": len(feats),
                   "pieces_before_merge": pieces, "ids_spanning_tiles": multi,
                   "multipolygon_results": unioned_multi,
                   "polygons_with_holes": stats["with_holes"],
                   "base_m_nonzero": stats["base_nonzero"],
                   "vertices_total": stats["vertices"],
                   "src_distribution": src_dist,
                   "src_distribution_pct": {k: round(v / max(len(feats), 1) * 100, 1) for k, v in src_dist.items()},
                   "height_m": {"min": round(min(heights), 2) if heights else None,
                                "q10": q(heights, 0.10), "q50": q(heights, 0.50),
                                "q90": q(heights, 0.90), "p99_9": q(heights, 0.999),
                                "max": round(max(heights), 2) if heights else None,
                                "over_100m": sum(1 for v in heights if v > 100),
                                "over_200m": sum(1 for v in heights if v > 200)},
                   "area_m2": {"q10": q(areas, 0.10), "q50": q(areas, 0.50), "q90": q(areas, 0.90),
                               "total": round(sum(areas))},
                   "anomalies": {k: stats[k] for k in ("dropped_empty", "dropped_bad_geom", "base_ge_height") if stats[k]}},
        "generated_at_utc": utc_now(),
        "generator": {"script": "scene/decode_buildings.py", "pmtiles_cli": pmtiles_version(exe),
                      "git_commit": git_commit(), "shapely": __import__("shapely").__version__},
    }
    with open(man, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    o = manifest["output"]
    info(f"\nD0-3 完成：{len(feats)} 栋建筑  {o['size_bytes']} 字节  sha256 {o['sha256'][:16]}…")
    info(f"  高度来源 {o['src_distribution_pct']}")
    info(f"  高度分位 q10 {o['height_m']['q10']}  q50 {o['height_m']['q50']}  q90 {o['height_m']['q90']}"
         f"  p99.9 {o['height_m']['p99_9']}  最高 {o['height_m']['max']} m（超 100 m 的 {o['height_m']['over_100m']} 栋）")
    info(f"  占地面积 q50 {o['area_m2']['q50']} m2，总占地 {o['area_m2']['total']} m2")
    if o["anomalies"]:
        info(f"  异常计数 {o['anomalies']}")
    info(f"  产物 {os.path.relpath(out, ROOT)}\n  清单 {os.path.relpath(man, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
