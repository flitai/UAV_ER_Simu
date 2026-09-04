#!/usr/bin/env python3
"""把整份全球底图 planet.pmtiles 与全球 DEM 瓦片登记为场景数据的共享资产（data/basemap/）。

依据：用户 2026-09-03 决定底图直接用 128 GB 的全球文件，不以裁切件作正式底图（CLAUDE.md
决策 D-022）。因此底图与 DEM 不按观测区域（AOI）拆分，只登记一次身份（大小、哈希、
planetiler 构建字段、图层表），供各 AOI 的清单按 sha256 引用。

用法
    uv run python scene/register_basemap.py --planet <planet.pmtiles> --dem <dem 目录> \
        [--sha256 <hex> | --hash] [--link]

    --sha256   事先算好的全文件 sha256（128 GB 约 5 分钟，建议后台算好再传入）
    --hash     由本脚本计算全文件 sha256
    --link     在 data/basemap/ 下建软链指向包外源文件（仅在资源尚未拷入包内时使用）
    --origin / --dem-origin   副本的来源路径，写入清单备查

2026-09-04 起（决策 D-023）底图与 DEM 是**包内自持的真实文件**，直接登记包内路径即可：
    uv run python scene/register_basemap.py --planet data/basemap/planet.pmtiles \
        --dem data/basemap/dem --sha256 <hex> --origin <来源路径> --dem-origin <来源路径>
清单里的 `storage` 字段记录形态：in_place（包内自持）/ symlink（软链）/ external（在包外）。

产物（入 git 的只有两个清单）
    data/basemap/planet.pmtiles         软链或真实文件（不入 git）
    data/basemap/dem/                   软链或真实目录（不入 git）
    data/basemap/planet.manifest.json   全球底图身份
    data/basemap/dem.manifest.json      DEM 目录索引（按层的文件数与字节数，以及索引哈希）

DEM 只做"索引哈希"（对"相对路径 + 字节数"的有序列表做 sha256），不逐文件读内容：
7.1 GB、约 8 万个 PNG，内容哈希对当前用途（视觉山体阴影）没有必要。
"""
import argparse
import hashlib
import json
import os
import platform
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_tiles import (ROOT, HEADER_HASH_BYTES, die, info, need_pmtiles, pmtiles_version,  # noqa: E402
                         show_header, show_metadata, sha256_of, git_commit, utc_now, mtime_utc,
                         repo_path)

BASEMAP_DIR = os.path.join(ROOT, "data", "basemap")


def place(target: str, canonical: str, do_link: bool) -> tuple[str, str | None]:
    """判定资源在包内的存放形态，必要时建软链。返回 (形态, 软链指向)。

    in_place  被登记的就是包内规范路径上的真实文件或目录（D-023 之后的形态）
    symlink   包内规范路径是指向包外的软链（开发机权宜）
    external  资源在包外，包内规范路径上什么都没有
    """
    if os.path.exists(canonical) and not os.path.islink(canonical) and os.path.samefile(target, canonical):
        return "in_place", None
    if os.path.islink(canonical):
        return "symlink", os.readlink(canonical)
    if not do_link:
        return "external", None
    if os.path.exists(canonical):
        die(f"{canonical} 已存在且不是软链，不覆盖")
    os.symlink(target, canonical)
    return "symlink", target


def dem_index(dem_dir: str) -> dict:
    per_zoom = {}
    entries = []
    for z in sorted(d for d in os.listdir(dem_dir) if d.isdigit()):
        zdir = os.path.join(dem_dir, z)
        n = 0
        nbytes = 0
        for xdir in sorted(os.listdir(zdir)):
            xp = os.path.join(zdir, xdir)
            if not os.path.isdir(xp):
                continue
            for name in sorted(os.listdir(xp)):
                if not name.endswith(".png"):
                    continue
                size = os.path.getsize(os.path.join(xp, name))
                entries.append(f"{z}/{xdir}/{name} {size}")
                n += 1
                nbytes += size
        per_zoom[z] = {"files": n, "bytes": nbytes, "complete": n == 4 ** int(z)}
    h = hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()
    return {"per_zoom": per_zoom, "files_total": len(entries),
            "bytes_total": sum(v["bytes"] for v in per_zoom.values()), "index_sha256": h}


def main() -> int:
    ap = argparse.ArgumentParser(description="登记全球底图与 DEM 为共享资产")
    ap.add_argument("--planet", required=True)
    ap.add_argument("--dem", help="terrarium DEM 目录 {z}/{x}/{y}.png")
    ap.add_argument("--sha256", help="事先算好的 planet 全文件 sha256")
    ap.add_argument("--hash", action="store_true", help="由脚本计算 planet 全文件 sha256")
    ap.add_argument("--link", action="store_true", help="在 data/basemap/ 下建软链（资源不在包内时的开发机权宜）")
    ap.add_argument("--origin", help="底图副本的来源路径，写入清单备查")
    ap.add_argument("--dem-origin", help="DEM 副本的来源路径，写入清单备查")
    a = ap.parse_args()

    planet = os.path.abspath(a.planet)
    if not os.path.isfile(planet):
        die(f"源文件不存在：{planet}")
    exe = need_pmtiles()
    os.makedirs(BASEMAP_DIR, exist_ok=True)

    hdr = show_header(exe, planet)
    meta = show_metadata(exe, planet)
    if a.sha256:
        sha, note = a.sha256.lower(), "由 --sha256 传入（事先用 shasum -a 256 计算）"
    elif a.hash:
        info("计算全文件 sha256（几分钟）……")
        sha, note = sha256_of(planet), "本次由脚本计算"
    else:
        sha, note = None, "未计算"

    storage, link_target = place(planet, os.path.join(BASEMAP_DIR, "planet.pmtiles"), a.link)
    manifest = {
        "schema": "cuav-basemap-manifest/1",
        "role": "全球底图，共享资产，不按 AOI 裁切；各 AOI 清单按本文件的 sha256 引用（决策 D-022）",
        "canonical_path": "data/basemap/planet.pmtiles",
        "storage": storage,
        "dev_link_target": repo_path(link_target) if link_target else None,
        "origin": a.origin,
        "origin_note": ("**历史来源，不是可解析的路径**：本项目自持的副本与它逐字节相同（sha256 一致即为证）。"
                        "换机器后该路径失效，但副本与哈希仍然有效，因此它只作留档，任何代码都不得去解析它")
                       if a.origin else None,
        "size_bytes": os.path.getsize(planet),
        "mtime_utc": mtime_utc(planet),
        "header_sha256_first_bytes": HEADER_HASH_BYTES,
        "header_sha256": sha256_of(planet, HEADER_HASH_BYTES),
        "sha256": sha,
        "sha256_note": note,
        "pmtiles_spec_version": hdr.get("pmtiles spec version"),
        "tile_type": hdr.get("tile type"),
        "bounds": hdr.get("_bounds"),
        "minzoom": hdr.get("_min_zoom"),
        "maxzoom": hdr.get("_max_zoom"),
        "addressed_tiles": hdr.get("_addressed_tiles_count"),
        "tile_entries": hdr.get("_tile_entries_count"),
        "tile_contents": hdr.get("_tile_contents_count"),
        "tile_compression": hdr.get("tile compression"),
        "planetiler_version": hdr.get("planetiler:version"),
        "planetiler_githash": hdr.get("planetiler:githash"),
        "planetiler_buildtime": hdr.get("planetiler:buildtime"),
        "osm_replication_time": hdr.get("planetiler:osm:osmosisreplicationtime"),
        "osm_replication_seq": hdr.get("planetiler:osm:osmosisreplicationseq"),
        "osm_replication_url": hdr.get("planetiler:osm:osmosisreplicationurl"),
        "basemap_name": hdr.get("name"),
        "basemap_version": hdr.get("version"),
        "attribution": hdr.get("attribution"),
        "license_note": "OpenStreetMap 数据 ODbL，署名必须保留（CLAUDE.md 铁律 13）",
        "vector_layers": [{"id": l.get("id"), "minzoom": l.get("minzoom"), "maxzoom": l.get("maxzoom"),
                           "fields": sorted((l.get("fields") or {}).keys())} for l in meta.get("vector_layers", [])],
        "serving_note": "必须经支持 HTTP Range 的服务提供；Python http.server 对 Range 返回整文件，128 GB 时不可用",
        "generated_at_utc": utc_now(),
        "generator": {"script": "scene/register_basemap.py", "pmtiles_cli": pmtiles_version(exe),
                      "git_commit": git_commit(), "python": platform.python_version(), "platform": platform.platform()},
    }
    p = os.path.join(BASEMAP_DIR, "planet.manifest.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    info(f"底图登记：{storage}  {manifest['size_bytes']} 字节  sha256 {(sha or '未算')[:16]}  planetiler {manifest['planetiler_version']}"
         f"  OSM {manifest['osm_replication_time']}  层 {len(manifest['vector_layers'])}  → {os.path.relpath(p, ROOT)}")

    if a.dem:
        dem = os.path.abspath(a.dem)
        if not os.path.isdir(dem):
            die(f"DEM 目录不存在：{dem}")
        dstorage, dlink = place(dem, os.path.join(BASEMAP_DIR, "dem"), a.link)
        idx = dem_index(dem)
        dm = {
            "schema": "cuav-dem-manifest/1",
            "role": "全球 DEM 瓦片（AWS terrarium 编码，zoom 0 至 8），共享资产，只作山体阴影视觉；不进 LOS 计算（CLAUDE.md 铁律 2）",
            "canonical_path": "data/basemap/dem",
            "storage": dstorage,
            "dev_link_target": repo_path(dlink) if dlink else None,
            "origin": a.dem_origin,
            "origin_note": "同上，历史来源留档，不作解析",
            "encoding": "terrarium: 高程 m = (R * 256 + G + B / 256) - 32768",
            "vertical_datum": "OPEN（CLAUDE.md 铁律 2：DEM 垂直基准未决）",
            "attribution": "AWS Terrain Tiles (Mapzen terrarium), https://registry.opendata.aws/terrain-tiles/",
            **idx,
            "generated_at_utc": utc_now(),
            "generator": {"script": "scene/register_basemap.py", "git_commit": git_commit()},
        }
        p = os.path.join(BASEMAP_DIR, "dem.manifest.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(dm, f, ensure_ascii=False, indent=2)
            f.write("\n")
        info(f"DEM 登记：{dstorage}  {idx['files_total']} 个文件  {idx['bytes_total']} 字节  层 {list(idx['per_zoom'])}  "
             f"完整层 {[z for z, v in idx['per_zoom'].items() if v['complete']]}  → {os.path.relpath(p, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
