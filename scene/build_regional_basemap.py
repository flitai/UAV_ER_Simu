#!/usr/bin/env python3
"""从包内自持的全球底图与 DEM 抽出一份区域底图，供可安装软件随包（W-3，决策 D-084）。

全球底图 `data/basemap/planet.pmtiles`（137 GB）只留在开发机上；交付包只带区域那一片。
两份并存、互不覆盖，应用服务按环境变量 `CUAV_BASEMAP` 选用哪一份（缺省：全球底图在就用它）。

范围定义在 `scene/regions/<id>.json`。本脚本做两件事：
    （`"kind": "overview"` 的范围——如 `world-z6`——只抽矢量底图、写到 `data/basemap/overview/`、不带 DEM。）
    1. 矢量底图：调用 `scene/fetch_tiles.py --bbox ... --out data/basemap/regional/<id>.pmtiles`，
       沿用它的 dry-run 估算、六项自检与清单（`<id>.manifest.json`）；
    2. DEM：把 `data/basemap/dem/` 中与范围相交的 zoom 0 至 dem_maxzoom 瓦片原样拷到
       `data/basemap/regional/<id>-dem/{z}/{x}/{y}.png`，并写 `<id>-dem.manifest.json`（逐层计数、字节、索引哈希）。

不联网：两件事都只读本地文件（铁律 6）。产物大文件不入 git，清单入 git。

用法
    uv run python scene/build_regional_basemap.py --region beijing --estimate   只估算
    uv run python scene/build_regional_basemap.py --region beijing              正式抽取
    uv run python scene/build_regional_basemap.py --region beijing --force      覆盖已有产物
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from fetch_tiles import git_commit, repo_path, tile_xy  # noqa: E402

REGIONS = os.path.join(HERE, "regions")
BASEMAP = os.path.join(ROOT, "data", "basemap")
OUT_ROOT = os.path.join(BASEMAP, "regional")
# 概览底图（kind = overview，D-084 补充）单独放：它不是一份可被单独选用的区域底图，不能让服务端把它数进 regional/
OVERVIEW_ROOT = os.path.join(BASEMAP, "overview")


def die(msg: str) -> None:
    print(f"\n错误：{msg}", file=sys.stderr)
    sys.exit(1)


def load_region(rid: str) -> dict:
    p = os.path.join(REGIONS, f"{rid}.json")
    if not os.path.isfile(p):
        die(f"区域定义不存在：{repo_path(p)}")
    with open(p, encoding="utf-8") as f:
        r = json.load(f)
    if r.get("id") != rid:
        die(f"{repo_path(p)} 的 id 与文件名不一致")
    return r


def dem_tiles(bbox, zmax: int):
    """与范围相交的 DEM 瓦片（Web Mercator XYZ，y 自北向南）。"""
    w, s, e, n = bbox
    for z in range(0, zmax + 1):
        x0, y0 = tile_xy(w, n, z)
        x1, y1 = tile_xy(e, s, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                yield z, x, y


def build_dem(region: dict, force: bool, estimate: bool) -> None:
    rid, bbox, zmax = region["id"], region["bbox"], int(region["dem_maxzoom"])
    src_root = os.path.join(BASEMAP, "dem")
    out_root = os.path.join(OUT_ROOT, f"{rid}-dem")
    tiles = list(dem_tiles(bbox, zmax))
    missing = [t for t in tiles if not os.path.isfile(os.path.join(src_root, *map(str, t)) + ".png")]
    print(f"DEM：zoom 0-{zmax} 与范围相交 {len(tiles)} 块，源缺 {len(missing)} 块")
    if missing:
        die(f"源 DEM 缺瓦片（不拿空白顶替，铁律 15）：{missing[:5]}")
    if estimate:
        return
    if os.path.exists(out_root):
        if not force:
            die(f"产物已存在：{repo_path(out_root)}；确认要重做请加 --force（铁律 10）")
        shutil.rmtree(out_root)
    per_zoom: dict[str, dict] = {}
    index = hashlib.sha256()
    for z, x, y in tiles:
        src = os.path.join(src_root, str(z), str(x), f"{y}.png")
        dst = os.path.join(out_root, str(z), str(x), f"{y}.png")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        with open(dst, "rb") as f:
            h = hashlib.sha256(f.read()).hexdigest()
        index.update(f"{z}/{x}/{y} {h}\n".encode())
        pz = per_zoom.setdefault(str(z), {"files": 0, "bytes": 0})
        pz["files"] += 1
        pz["bytes"] += os.path.getsize(dst)
    src_man = os.path.join(BASEMAP, "dem.manifest.json")
    attribution = None
    if os.path.isfile(src_man):
        with open(src_man, encoding="utf-8") as f:
            attribution = json.load(f).get("attribution")
    manifest = {
        "schema": "cuav-dem-manifest/1",
        "role": f"区域 DEM（{region['name']}，D-084）：只作山体阴影视觉，不进视距计算（铁律 2）",
        "canonical_path": repo_path(out_root),
        "storage": "in_place",
        "region": {k: region[k] for k in ("id", "name", "bbox", "bbox_order")},
        "region_definition_file": repo_path(os.path.join(REGIONS, f"{rid}.json")),
        "source": {"canonical_path": "data/basemap/dem", "manifest": "data/basemap/dem.manifest.json"},
        "encoding": "terrarium: 高程 m = (R * 256 + G + B / 256) - 32768",
        "vertical_datum": "OPEN（CLAUDE.md 铁律 2：DEM 垂直基准未决）",
        "attribution": attribution,
        "per_zoom": per_zoom,
        "tiles": len(tiles),
        "bytes": sum(v["bytes"] for v in per_zoom.values()),
        "index_sha256": index.hexdigest(),
        "index_sha256_note": "按 zoom、x、y 顺序逐行 `z/x/y <文件 sha256>` 的 sha256",
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": {"script": repo_path(os.path.abspath(__file__)), "git_commit": git_commit()},
    }
    with open(os.path.join(OUT_ROOT, f"{rid}-dem.manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"DEM 完成：{len(tiles)} 块、{manifest['bytes']} 字节 → {repo_path(out_root)}")


def main() -> int:
    ap = argparse.ArgumentParser(description="抽取交付用区域底图与 DEM（W-3，D-084）")
    ap.add_argument("--region", required=True, help="scene/regions/<id>.json 里的 id")
    ap.add_argument("--estimate", action="store_true", help="只估算，不写任何文件")
    ap.add_argument("--force", action="store_true", help="覆盖已有产物")
    a = ap.parse_args()
    region = load_region(a.region)
    rid = region["id"]
    overview = region.get("kind") == "overview"
    out_root = OVERVIEW_ROOT if overview else OUT_ROOT
    planet = os.path.join(BASEMAP, "planet.pmtiles")
    if not os.path.isfile(planet):
        die("全球底图 data/basemap/planet.pmtiles 不在本机：区域底图只能在持有全球底图的开发机上生成")

    cmd = [sys.executable, os.path.join(HERE, "fetch_tiles.py"),
           # 写成 `--bbox=` 一个参数：西经范围以负号开头，分成两个参数会被 argparse 当成选项
           "--bbox=" + ",".join(str(v) for v in region["bbox"]), "--name", rid,
           "--minzoom", str(region["minzoom"]), "--maxzoom", str(region["maxzoom"]),
           "--out", os.path.join(out_root, f"{rid}.pmtiles")]
    if region.get("probe"):
        cmd += ["--probe=" + ",".join(str(v) for v in region["probe"])]
    # 全球底图的全文件哈希已记在它的登记清单里，直接带过去，不必再读一遍 137 GB
    pm = os.path.join(BASEMAP, "planet.manifest.json")
    if os.path.isfile(pm):
        with open(pm, encoding="utf-8") as f:
            sha = json.load(f).get("sha256")
        if sha:
            cmd += ["--source-sha256", sha]
    if a.estimate:
        cmd.append("--estimate")
    if a.force:
        cmd.append("--force")
    os.makedirs(out_root, exist_ok=True)
    r = subprocess.run(cmd)
    if r.returncode != 0:
        return r.returncode
    if overview:
        print("概览底图不带 DEM：山体阴影只在区域内画，全球 DEM 的 zoom 0–6 实测约 303 MB（按 dem.manifest.json 逐层字节），比概览底图本身大六倍多，不随包")
    else:
        build_dem(region, a.force, a.estimate)
    return 0


if __name__ == "__main__":
    sys.exit(main())
