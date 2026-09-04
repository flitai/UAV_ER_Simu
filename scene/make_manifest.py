#!/usr/bin/env python3
"""D0-6：生成观测区域的总清单 `data/scene/<aoi>/manifest.json`。

总清单是场景数据包的**入口文件**：它把区域定义、所引用的共享资产、区域内各产物用 sha256 串成
一条可核对的链，并记下每个产物是用哪条命令生成的。任何一环换了，哈希就对不上（铁律 8、10）。

用法
    uv run python scene/make_manifest.py --aoi beijing-yayuncun [--force]

只读各产物与它们各自的清单，不重算数据。共享的底图与数字高程模型不复制进区域目录，只按
sha256 引用（D-022：它们是全局唯一的一份）。
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_tiles import ROOT, die, info, load_aoi, sha256_of, utc_now, git_commit  # noqa: E402

SCHEMA = "cuav-scene-package-manifest/1"


def entry(path, role, in_git, note=None):
    if not os.path.isfile(path):
        return None
    e = {"file": os.path.basename(path), "role": role, "in_git": in_git,
         "size_bytes": os.path.getsize(path), "sha256": sha256_of(path)}
    if note:
        e["note"] = note
    return e


def main() -> int:
    ap = argparse.ArgumentParser(description="生成观测区域场景数据包总清单（D0-6）")
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    a.bbox = a.name = None
    aoi = load_aoi(a)
    base = os.path.join(ROOT, "data", "scene", aoi["id"])
    out = os.path.join(base, "manifest.json")
    if os.path.exists(out) and not a.force:
        die(f"总清单已存在：{out}。要重写请加 --force。")

    def load(name):
        p = os.path.join(base, name)
        return json.load(open(p, encoding="utf-8")) if os.path.isfile(p) else None

    bm = load("buildings.manifest.json")
    sm = load("basemap-slice.manifest.json")
    om = load("osm-buildings-raw.manifest.json")
    if bm is None:
        die("缺少 buildings.manifest.json，先跑 scene/decode_buildings.py")

    shared = {}
    for key, fn in (("basemap", "planet.manifest.json"), ("dem", "dem.manifest.json")):
        p = os.path.join(ROOT, "data", "basemap", fn)
        if os.path.isfile(p):
            m = json.load(open(p, encoding="utf-8"))
            shared[key] = {"canonical_path": m["canonical_path"], "manifest": f"data/basemap/{fn}",
                           "storage": m.get("storage"), "sha256": m.get("sha256"),
                           "size_bytes": m.get("size_bytes") or m.get("bytes_total"),
                           "index_sha256": m.get("index_sha256")}
            for k in ("planetiler_version", "osm_replication_time", "attribution", "vertical_datum"):
                if m.get(k):
                    shared[key][k] = m[k]

    products = [e for e in (
        entry(os.path.join(base, "buildings.geojson"),
              "建筑几何的单一来源，同时驱动三维拉伸渲染与遮挡桶网格（铁律 11）", False),
        entry(os.path.join(base, "buildings.manifest.json"), "建筑产物的同构元数据", True),
        entry(os.path.join(base, "basemap-slice.pmtiles"),
              "区域底图切片。**只作测试夹具与便携底图**，正式底图是共享的整份全球文件（D-022）", False),
        entry(os.path.join(base, "basemap-slice.manifest.json"), "切片的同构元数据", True),
        entry(os.path.join(base, "osm-buildings-raw.json"),
              "原始 OSM 快照：对拍基准，以及 src 分档与 base_m 的来源", False),
        entry(os.path.join(base, "osm-buildings-raw.manifest.json"), "原始快照的同构元数据", True),
        entry(os.path.join(base, "quality-report.md"), "质量报告（D0-4 对拍 + D0-7）", True),
    ) if e]

    bo = bm["output"]
    manifest = {
        "schema": SCHEMA,
        "role": "观测区域场景数据包的入口清单：区域定义、共享资产引用、各产物哈希与生成命令",
        "aoi": {k: v for k, v in aoi.items() if not k.startswith("_")},
        "aoi_definition_file": aoi.get("_definition_file"),
        "crs": "EPSG:4326",
        "coord_version": "交换与文件用 WGS-84 经纬度（度）；瓦片网格为 Web Mercator XYZ；"
                         "禁止 GCJ-02 混入（铁律 1）",
        "height_datum": "建筑的 base_m / height_m 是离地高差，不是海拔；禁止与数字高程模型的海拔"
                        "隐式相加（铁律 2）。首期视距采用显式平地假设",
        "coverage_bbox": bm["coverage_bbox"],
        "shared_assets": shared,
        "products": products,
        "provenance": {
            "osm_snapshot_of_tiles": bm["source"]["osm_replication_time"],
            "osm_snapshot_of_raw_tags": (om or {}).get("osm_timestamp"),
            "planetiler_version": bm["source"]["planetiler_version"],
            "attribution": bm["source"].get("attribution"),
            "license_note": "OpenStreetMap 数据按 ODbL 授权，署名必须随包保留（铁律 13）",
            "drift_note": "瓦片与原始标签取自不同时刻的 OSM，计数差异首先归因于此，见 quality-report.md 第 2 节",
        },
        "buildings_summary": {
            "features": bo["features"],
            "src_distribution": bo["src_distribution"],
            "src_distribution_pct": bo["src_distribution_pct"],
            "height_m": bo["height_m"],
            "base_m_nonzero": bo["base_m_nonzero"],
            "estimated_share_warning": "近八成建筑高度为估算值（src=est:area），不得用于验收指标（铁律 14）",
        },
        "reproduce": [
            "uv run python scene/register_basemap.py --planet data/basemap/planet.pmtiles --dem data/basemap/dem --sha256 <hex>",
            f"uv run python scene/fetch_tiles.py --aoi {aoi['id']} [--force]",
            f"uv run python scene/fetch_osm_buildings.py --aoi {aoi['id']} [--force]   # 唯一联网步骤",
            f"uv run --with shapely python scene/decode_buildings.py --aoi {aoi['id']} "
            f"--osm-tags data/scene/{aoi['id']}/osm-buildings-raw.json [--force]",
            f"uv run python scene/quality_report.py --aoi {aoi['id']} [--force]",
            f"uv run python scene/make_manifest.py --aoi {aoi['id']} [--force]",
            f"sh scripts/check-ascii.sh data/scene",
        ],
        "generated_at_utc": utc_now(),
        "generator": {"script": "scene/make_manifest.py", "git_commit": git_commit()},
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    info(f"总清单已写入 {os.path.relpath(out, ROOT)}")
    info(f"  引用共享资产 {list(shared)}；区域产物 {len(products)} 项")
    for p in products:
        info(f"    {p['file']:34s} {p['size_bytes']:>10d} 字节  {p['sha256'][:16]}  {'入 git' if p['in_git'] else '不入 git'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
