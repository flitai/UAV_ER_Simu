#!/usr/bin/env python3
"""D0-4 第一步：从 Overpass 拉取观测区域内建筑的**原始 OSM 标签与几何**。

**这是本项目唯一的联网步骤，只允许在建库阶段跑**（铁律 6：建库可联网，运行不联网）。
产物是只读的原始快照，落在 `data/scene/<aoi>/osm-buildings-raw.json`，不入 git。

两个用途（缺一不可，D-025）：
  1. **对拍基准**：本项目的 `buildings.geojson` 是从矢量瓦片解出来的，瓦片经过切割与简化；
     用同一区域的原始 OSM 数据独立算一遍要素数、总面积、高度分位，才能知道瓦片管线丢了什么。
  2. **把 `src` 拆开**：瓦片的 `height` 字段混合了真实标注与 planetiler 按层数推导的值，
     只有原始标签能把 `osm:height`、`osm:levels` 分开，并补上 `base_m`。

用法
    uv run python scene/fetch_osm_buildings.py --aoi beijing-yayuncun [--force]

按 id 对齐：瓦片要素 id 的编码经实测为 `(类型 << 44) | OSM 编号`，类型 2 = way、3 = relation
（实测 47231 个 way、351 个 relation，去掉类型位后的取值落在 OSM 编号的合理区间）。因此本产物
与 `buildings.geojson` 可按 `(类型, 编号)` 精确对上，不需要几何近邻匹配。

对公共服务的礼貌：单次查询、显式 User-Agent、镜像间只在失败时轮换、不做并发。
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_tiles import ROOT, die, info, load_aoi, sha256_of, utc_now, git_commit  # noqa: E402

ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
UA = "804-C-UAV-scene-builder/0.1 (electronic reconnaissance simulation; build-time only)"
TYPE_SHIFT = 44
TYPE_WAY, TYPE_RELATION = 2, 3


def coverage_bbox(aoi_id: str, fallback):
    """优先用建筑产物清单里记录的瓦片对齐覆盖范围，保证拉取范围不小于已解码范围。"""
    p = os.path.join(ROOT, "data", "scene", aoi_id, "buildings.manifest.json")
    if os.path.isfile(p):
        with open(p, encoding="utf-8") as f:
            m = json.load(f)
        cb = m.get("coverage_bbox")
        if cb and len(cb) == 4:
            return cb, "buildings.manifest.json 的 coverage_bbox（瓦片对齐）"
    return fallback, "AOI 定义的 bbox（未找到建筑清单）"


def build_query(bbox, timeout_s: int) -> str:
    w, s, e, n = bbox
    return (f"[out:json][timeout:{timeout_s}];\n"
            f"(\n"
            f'  way["building"]({s},{w},{n},{e});\n'
            f'  relation["building"]({s},{w},{n},{e});\n'
            f");\n"
            f"out geom;")


def fetch(query: str, out_path: str):
    last = None
    for i, url in enumerate(ENDPOINTS):
        info(f"  镜像 {i + 1}/{len(ENDPOINTS)}: {url}")
        req = urllib.request.Request(url, data=query.encode("utf-8"),
                                     headers={"User-Agent": UA,
                                              "Content-Type": "application/x-www-form-urlencoded"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=600) as r, open(out_path, "wb") as f:
                total = 0
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    total += len(chunk)
            info(f"  成功：{total} 字节，用时 {time.time() - t0:.1f} 秒")
            return url, total, round(time.time() - t0, 1)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as ex:
            last = f"{type(ex).__name__}: {ex}"
            info(f"  失败（{last}），换下一个镜像")
            if os.path.exists(out_path):
                os.remove(out_path)
            time.sleep(3)
    die(f"所有镜像都失败，最后一次：{last}")


def main() -> int:
    ap = argparse.ArgumentParser(description="拉取观测区域内建筑的原始 OSM 标签与几何（D0-4，联网）")
    ap.add_argument("--aoi")
    ap.add_argument("--bbox")
    ap.add_argument("--name")
    ap.add_argument("--timeout", type=int, default=300, help="Overpass 服务端查询超时（秒）")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    aoi = load_aoi(a)
    bbox, src = coverage_bbox(aoi["id"], aoi["bbox"])
    out = os.path.join(ROOT, "data", "scene", aoi["id"], "osm-buildings-raw.json")
    man = os.path.join(os.path.dirname(out), "osm-buildings-raw.manifest.json")
    if os.path.exists(out) and not a.force:
        die(f"产物已存在：{out}\n  不静默覆盖（铁律 10）。要重拉请加 --force。")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    q = build_query(bbox, a.timeout)
    info(f"区域 {aoi['id']}  拉取范围 {bbox}（来自 {src}）")
    info("查询语句：\n" + "\n".join("    " + l for l in q.splitlines()))
    info("开始拉取（这是建库阶段的联网动作，运行阶段不联网）……")
    endpoint, nbytes, secs = fetch(q, out)

    with open(out, encoding="utf-8") as f:
        data = json.load(f)
    els = data.get("elements", [])
    ways = [e for e in els if e.get("type") == "way"]
    rels = [e for e in els if e.get("type") == "relation"]
    tagged = lambda key: sum(1 for e in els if key in (e.get("tags") or {}))
    manifest = {
        "schema": "cuav-scene-osm-raw-manifest/1",
        "product": "osm-buildings-raw.json",
        "role": "D0-4 的原始 OSM 快照：既作对拍基准，也是把 src 拆成 osm:height / osm:levels 并补 base_m 的唯一来源",
        "aoi": {k: v for k, v in aoi.items() if not k.startswith("_")},
        "query_bbox": bbox, "query_bbox_source": src,
        "query": q,
        "endpoint": endpoint, "user_agent": UA,
        "fetched_at_utc": utc_now(), "elapsed_s": secs,
        "osm_api_version": data.get("version"), "osm_generator": data.get("generator"),
        "osm_timestamp": (data.get("osm3s") or {}).get("timestamp_osm_base"),
        "id_join": {"encoding": "瓦片要素 id = (类型 << 44) | OSM 编号",
                    "type_way": TYPE_WAY, "type_relation": TYPE_RELATION,
                    "note": "与 buildings.geojson 按 (类型, 编号) 精确对齐，不用几何近邻匹配"},
        "counts": {"elements": len(els), "ways": len(ways), "relations": len(rels),
                   "with_height": tagged("height"), "with_building_levels": tagged("building:levels"),
                   "with_min_height": tagged("min_height"),
                   "with_building_min_level": tagged("building:min_level")},
        "output": {"file": os.path.basename(out), "size_bytes": nbytes, "sha256": sha256_of(out)},
        "generator": {"script": "scene/fetch_osm_buildings.py", "git_commit": git_commit()},
        "license": "OpenStreetMap contributors, ODbL。署名必须随包保留（铁律 13）",
    }
    with open(man, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    c = manifest["counts"]
    info(f"\nD0-4 拉取完成：{c['elements']} 个要素（way {c['ways']}，relation {c['relations']}）")
    info(f"  带 height 标签 {c['with_height']}，带 building:levels {c['with_building_levels']}，"
         f"带 min_height {c['with_min_height']}，带 building:min_level {c['with_building_min_level']}")
    info(f"  OSM 数据时间戳 {manifest['osm_timestamp']}")
    info(f"  产物 {os.path.relpath(out, ROOT)}（{nbytes} 字节）\n  清单 {os.path.relpath(man, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
