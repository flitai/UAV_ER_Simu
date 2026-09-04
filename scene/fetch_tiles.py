#!/usr/bin/env python3
"""从本地全球底图 planet.pmtiles 按观测区域（AOI）裁切出一份小切片 basemap-slice.pmtiles。

角色（2026-09-03 决策 D-022）：正式底图是整份全球文件（登记见 scene/register_basemap.py 与
data/basemap/planet.manifest.json），**不按 AOI 裁切**。本脚本产出的切片只用作：测试夹具
（端到端测试、持续集成）、以及没有 128 GB 全球文件的机器上的便携底图。切片在 AOI 之外是空白。

对应 06 备忘录 §4 步骤 D0-2；产物规范见 docs/scene-package.md。
参考 Airports 工程的 `fetch_tiles.py`（本方自有代码，位置见 CLAUDE.md 资源清单）：那份脚本对远端 planet
做 HTTP Range 抓取；本脚本改为读本地文件，不联网，不做区域预设。

用法
    uv run python scene/fetch_tiles.py --aoi beijing-yayuncun --estimate     只估算，不写文件
    uv run python scene/fetch_tiles.py --aoi beijing-yayuncun                正式裁切并自检
    uv run python scene/fetch_tiles.py --aoi beijing-yayuncun --force        覆盖已有产物
    uv run python scene/fetch_tiles.py --bbox W,S,E,N --name <id>            不经 AOI 文件直接给范围
    uv run python scene/fetch_tiles.py --aoi <id> --source-sha256 <hex>      把事先算好的源文件哈希写进清单

产物
    data/scene/<id>/basemap-slice.pmtiles           裁切结果（不入 git）
    data/scene/<id>/basemap-slice.manifest.json     同构元数据：来源、参数、输入哈希、自检结果（入 git）

依赖：只用 Python 标准库；需要 pmtiles 命令行工具（macOS: brew install pmtiles；
Windows: https://github.com/protomaps/go-pmtiles/releases）。

自检六项（任一不过即退出，保留 .part 文件供检查）：
    1. 产物 bounds 覆盖请求的 bbox
    2. min zoom 等于请求值
    3. max zoom 等于请求值
    4. 瓦片条目数等于 dry-run 给出的数
    5. 元数据里有 buildings 图层且 zoom 范围为 11–15
    6. AOI 中心的最高层瓦片解压后含 "buildings" 图层名
"""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AOI_DIR = os.path.join(HERE, "aoi")
OUT_ROOT = os.path.join(ROOT, "data", "scene")
DEFAULT_PLANET = os.path.join(ROOT, "data", "basemap", "planet.pmtiles")
MANIFEST_SCHEMA = "cuav-scene-basemap-manifest/1"
HEADER_HASH_BYTES = 16 * 1024
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def die(msg: str, code: int = 1) -> None:
    print(f"\n错误：{msg}", file=sys.stderr)
    sys.exit(code)


def info(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# AOI
# ---------------------------------------------------------------------------
def parse_bbox(text: str):
    try:
        w, s, e, n = (float(v) for v in text.split(","))
    except ValueError:
        die(f"bbox 必须是 W,S,E,N 四个数：{text}")
    if not (-180 <= w < e <= 180 and -85.06 <= s < n <= 85.06):
        die(f"bbox 数值越界或顺序不对（应为 西,南,东,北）：{text}")
    return [w, s, e, n]


def load_aoi(args):
    if args.aoi:
        path = os.path.join(AOI_DIR, f"{args.aoi}.json")
        if not os.path.isfile(path):
            die(f"找不到 AOI 定义 {path}")
        with open(path, encoding="utf-8") as f:
            aoi = json.load(f)
        if aoi.get("id") != args.aoi:
            die(f"AOI 文件里的 id（{aoi.get('id')}）与文件名（{args.aoi}）不一致")
        bbox = aoi.get("bbox")
        if not (isinstance(bbox, list) and len(bbox) == 4):
            die("AOI 文件缺 bbox 或格式不对")
        aoi["bbox"] = parse_bbox(",".join(str(v) for v in bbox))
        aoi["_definition_file"] = os.path.relpath(path, ROOT)
        return aoi
    if not (args.bbox and args.name):
        die("要么给 --aoi <id>，要么同时给 --bbox W,S,E,N 与 --name <id>")
    return {
        "id": args.name,
        "status": {"extent": "ad_hoc", "note": "命令行直接给的范围，没有 AOI 定义文件"},
        "crs": "EPSG:4326",
        "bbox": parse_bbox(args.bbox),
        "_definition_file": None,
    }


def extent_km(bbox):
    w, s, e, n = bbox
    mid = math.radians((s + n) / 2)
    return [round((e - w) * 111.32 * math.cos(mid), 2), round((n - s) * 110.95, 2)]


def tile_xy(lon: float, lat: float, z: int):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


# ---------------------------------------------------------------------------
# pmtiles 命令行
# ---------------------------------------------------------------------------
def need_pmtiles() -> str:
    exe = shutil.which("pmtiles")
    if not exe:
        die("找不到 pmtiles 命令。macOS: brew install pmtiles；"
            "Windows: https://github.com/protomaps/go-pmtiles/releases 下载后放进 PATH")
    return exe


def run(cmd, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def pmtiles_version(exe: str) -> str:
    r = run([exe, "version"])
    return (r.stdout or r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr) else "unknown"


BOUNDS_RE = re.compile(r"\(long: ([-\d.]+), lat: ([-\d.]+)\) \(long: ([-\d.]+), lat: ([-\d.]+)\)")


def show_header(exe: str, path: str) -> dict:
    """解析 `pmtiles show` 的文本输出。头部行形如 `max zoom: 15`，元数据行形如
    `planetiler:version 0.10.2`（键与值之间是空格，键内可含冒号）。"""
    r = run([exe, "show", path])
    if r.returncode != 0:
        die(f"pmtiles show 失败：{r.stderr.strip()[-500:]}")
    out = {}
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if ": " in line and not line.split(": ", 1)[0].count(" ") > 3:
            k, v = line.split(": ", 1)
        elif " " in line:
            k, v = line.split(" ", 1)
        else:
            continue
        out[k.strip()] = v.strip()
    m = BOUNDS_RE.search(out.get("bounds", ""))
    if m:
        out["_bounds"] = [float(m.group(i)) for i in (1, 2, 3, 4)]
    for key in ("min zoom", "max zoom", "addressed tiles count", "tile entries count", "tile contents count"):
        if key in out:
            try:
                out["_" + key.replace(" ", "_")] = int(out[key])
            except ValueError:
                pass
    return out


def show_metadata(exe: str, path: str) -> dict:
    r = run([exe, "show", path, "--metadata"])
    if r.returncode != 0:
        die(f"pmtiles show --metadata 失败：{r.stderr.strip()[-500:]}")
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError as ex:
        die(f"pmtiles show --metadata 输出不是 JSON：{ex}")


TILES_RE = re.compile(r"Region tiles (\d+), result tile entries (\d+)")
SIZE_RE = re.compile(r"archive size of ([\d.]+)\s*([KMGT]?B)")
UNIT = {"B": 1, "KB": 10 ** 3, "MB": 10 ** 6, "GB": 10 ** 9, "TB": 10 ** 12}


def parse_extract_log(log: str) -> dict:
    res = {"region_tiles": None, "tile_entries": None, "archive_size_text": None, "archive_size_bytes_approx": None}
    m = TILES_RE.search(log)
    if m:
        res["region_tiles"], res["tile_entries"] = int(m.group(1)), int(m.group(2))
    m = SIZE_RE.search(log)
    if m:
        res["archive_size_text"] = f"{m.group(1)} {m.group(2)}"
        res["archive_size_bytes_approx"] = int(float(m.group(1)) * UNIT[m.group(2)])
    return res


def extract(exe: str, planet: str, out: str, bbox, minzoom: int, maxzoom: int, dry: bool) -> dict:
    cmd = [exe, "extract", planet, out,
           f"--bbox={','.join(f'{v:.6f}' for v in bbox)}",
           f"--minzoom={minzoom}", f"--maxzoom={maxzoom}"]
    if dry:
        cmd.append("--dry-run")
    r = run(cmd)
    log = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        die(f"pmtiles extract 失败（返回码 {r.returncode}）：\n{log.strip()[-1200:]}")
    parsed = parse_extract_log(log)
    if parsed["region_tiles"] is None:
        die(f"无法从 pmtiles extract 日志中解析瓦片数：\n{log.strip()[-1200:]}")
    parsed["command"] = cmd
    return parsed


def fetch_tile(exe: str, path: str, z: int, x: int, y: int) -> bytes:
    r = subprocess.run([exe, "tile", path, str(z), str(x), str(y)], capture_output=True)
    if r.returncode != 0:
        die(f"pmtiles tile {z}/{x}/{y} 失败：{r.stderr.decode('utf-8', 'ignore')[-500:]}")
    raw = r.stdout
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


# ---------------------------------------------------------------------------
# 哈希与溯源
# ---------------------------------------------------------------------------
def sha256_of(path: str, limit: int | None = None) -> str:
    h = hashlib.sha256()
    remaining = limit
    with open(path, "rb") as f:
        while True:
            chunk = f.read(16 * 1024 * 1024 if remaining is None else min(remaining, 16 * 1024 * 1024))
            if not chunk:
                break
            h.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
                if remaining <= 0:
                    break
    return h.hexdigest()


def git_commit() -> str | None:
    try:
        r = run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"])
        if r.returncode != 0:
            return None
        rev = r.stdout.strip()
        dirty = run(["git", "-C", ROOT, "status", "--porcelain"]).stdout.strip()
        return rev + ("-dirty" if dirty else "")
    except OSError:
        return None


def repo_path(path: str) -> str:
    """把路径写成**相对仓库根目录**的形式，供清单与日志使用。

    产物清单里不得出现机器相关的绝对路径：项目整体迁移或换平台后，那些路径全部失效，
    清单也就不再可核对。仓库之外的路径（例如外部参考工程）原样返回，并由调用方注明它是
    历史来源而不是可解析的位置。
    """
    ap = os.path.abspath(path)
    root = os.path.abspath(ROOT)
    if ap == root or ap.startswith(root + os.sep):
        return os.path.relpath(ap, root).replace(os.sep, "/")
    return ap


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def mtime_utc(path: str) -> str:
    return dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# 自检
# ---------------------------------------------------------------------------
def verify(exe: str, part: str, bbox, minzoom: int, maxzoom: int, expected_entries: int):
    hdr = show_header(exe, part)
    meta = show_metadata(exe, part)
    checks = []
    eps = 1e-6

    b = hdr.get("_bounds")
    ok = bool(b) and b[0] <= bbox[0] + eps and b[1] <= bbox[1] + eps and b[2] >= bbox[2] - eps and b[3] >= bbox[3] - eps
    checks.append({"check": "bounds_cover_bbox", "pass": ok, "got": b, "want": bbox})

    checks.append({"check": "minzoom", "pass": hdr.get("_min_zoom") == minzoom, "got": hdr.get("_min_zoom"), "want": minzoom})
    checks.append({"check": "maxzoom", "pass": hdr.get("_max_zoom") == maxzoom, "got": hdr.get("_max_zoom"), "want": maxzoom})

    entries = hdr.get("_tile_entries_count")
    checks.append({"check": "tile_entries_equal_dry_run", "pass": entries == expected_entries, "got": entries, "want": expected_entries})

    layers = {l.get("id"): l for l in meta.get("vector_layers", [])}
    bl = layers.get("buildings")
    ok = bl is not None and bl.get("minzoom") == 11 and bl.get("maxzoom") == 15
    checks.append({"check": "buildings_layer_z11_15", "pass": ok,
                   "got": None if bl is None else {"minzoom": bl.get("minzoom"), "maxzoom": bl.get("maxzoom")},
                   "want": {"minzoom": 11, "maxzoom": 15}})

    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    x, y = tile_xy(cx, cy, maxzoom)
    data = fetch_tile(exe, part, maxzoom, x, y)
    ok = len(data) > 0 and b"buildings" in data
    checks.append({"check": "center_tile_has_buildings_layer", "pass": ok,
                   "got": {"z": maxzoom, "x": x, "y": y, "bytes_uncompressed": len(data), "contains_buildings": b"buildings" in data},
                   "want": "bytes > 0 且含 buildings"})

    return hdr, meta, checks


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="从本地 planet.pmtiles 按 AOI 裁切 basemap-slice.pmtiles（D0-2）")
    ap.add_argument("--aoi", help="scene/aoi/<id>.json 里的 id")
    ap.add_argument("--bbox", help="W,S,E,N（与 --name 同用，不经 AOI 文件）")
    ap.add_argument("--name", help="与 --bbox 同用的区域 id（小写字母、数字、连字符）")
    ap.add_argument("--planet", default=DEFAULT_PLANET,
                    help="本地全球底图（默认包内自持的 data/basemap/planet.pmtiles，决策 D-023）")
    ap.add_argument("--minzoom", type=int, default=0)
    ap.add_argument("--maxzoom", type=int, default=15)
    ap.add_argument("--out", help="输出文件（默认 data/scene/<id>/basemap-slice.pmtiles）")
    ap.add_argument("--estimate", action="store_true", help="只做 dry-run 估算，不写任何文件")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的产物（否则拒绝，铁律 10）")
    ap.add_argument("--hash-source", action="store_true", help="计算源文件全文件 sha256（128 GB 约 5 分钟）")
    ap.add_argument("--source-sha256", help="事先算好的源文件 sha256，直接写入清单")
    a = ap.parse_args()

    aoi = load_aoi(a)
    aid = aoi["id"]
    if not ID_RE.match(aid):
        die(f"区域 id 必须是纯 ASCII 小写字母、数字与连字符：{aid}")
    bbox = aoi["bbox"]
    if a.minzoom < 0 or a.maxzoom < a.minzoom:
        die("zoom 范围不合法")
    if not os.path.isfile(a.planet):
        die(f"源文件不存在：{a.planet}")

    exe = need_pmtiles()
    ver = pmtiles_version(exe)
    out = a.out or os.path.join(OUT_ROOT, aid, "basemap-slice.pmtiles")
    out_dir = os.path.dirname(out)
    part = os.path.join(out_dir, "basemap-slice.part.pmtiles")
    manifest_path = os.path.join(out_dir, "basemap-slice.manifest.json")

    info(f"区域 {aid}  bbox {bbox}  约 {extent_km(bbox)[0]} x {extent_km(bbox)[1]} km  zoom {a.minzoom}-{a.maxzoom}")
    info(f"源文件 {a.planet}")
    src_hdr = show_header(exe, a.planet)
    info(f"  planetiler {src_hdr.get('planetiler:version')}  OSM 快照 {src_hdr.get('planetiler:osm:osmosisreplicationtime')}"
         f"  maxzoom {src_hdr.get('_max_zoom')}")
    if src_hdr.get("_max_zoom") is not None and a.maxzoom > src_hdr["_max_zoom"]:
        die(f"请求 maxzoom {a.maxzoom} 超过源文件 maxzoom {src_hdr['_max_zoom']}")

    info("dry-run 估算……")
    est = extract(exe, a.planet, "/dev/null" if os.name != "nt" else "NUL", bbox, a.minzoom, a.maxzoom, dry=True)
    info(f"  瓦片 {est['region_tiles']} 块，预计体积 {est['archive_size_text']}")
    if a.estimate:
        info("（--estimate 模式，未写任何文件）")
        return 0

    if os.path.exists(out) and not a.force:
        die(f"产物已存在：{out}\n  不静默覆盖既有产物（铁律 10）。确认要重做请加 --force。")
    os.makedirs(out_dir, exist_ok=True)
    if os.path.exists(part):
        os.remove(part)

    info("正式裁切……")
    real = extract(exe, a.planet, part, bbox, a.minzoom, a.maxzoom, dry=False)
    info(f"  写入 {part}  {os.path.getsize(part)} 字节")

    info("自检……")
    hdr, meta, checks = verify(exe, part, bbox, a.minzoom, a.maxzoom, est["tile_entries"])
    for c in checks:
        info(f"  [{'通过' if c['pass'] else '失败'}] {c['check']}  得到 {c['got']}")
    if not all(c["pass"] for c in checks):
        die(f"自检未通过，产物保留在 {part} 供检查，未写清单")

    if os.path.exists(out):
        os.remove(out)
    os.replace(part, out)

    info("计算哈希……")
    out_sha = sha256_of(out)
    src_head_sha = sha256_of(a.planet, HEADER_HASH_BYTES)
    if a.source_sha256:
        src_sha, src_sha_note = a.source_sha256.lower(), "由 --source-sha256 传入"
    elif a.hash_source:
        info(f"  源文件全文件 sha256（{os.path.getsize(a.planet)} 字节，需要几分钟）……")
        src_sha, src_sha_note = sha256_of(a.planet), "本次由脚本计算"
    else:
        src_sha, src_sha_note = None, "未计算：128 GB 全文件哈希约需 5 分钟，用 --hash-source 或 --source-sha256 补上；源身份以 header_sha256 + 大小 + planetiler 构建字段为准"

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "product": "basemap-slice.pmtiles",
        "aoi": {k: v for k, v in aoi.items() if not k.startswith("_")},
        "aoi_definition_file": aoi.get("_definition_file"),
        "crs": "EPSG:4326",
        "coord_version": "交换用 WGS-84 经纬度（度，EPSG:4326）；瓦片网格为 Web Mercator（EPSG:3857）XYZ 方案，"
                         "y 轴自北向南；CLAUDE.md 铁律 1",
        "source": {
            "path": repo_path(a.planet),
            "size_bytes": os.path.getsize(a.planet),
            "mtime_utc": mtime_utc(a.planet),
            "header_sha256_first_bytes": HEADER_HASH_BYTES,
            "header_sha256": src_head_sha,
            "sha256": src_sha,
            "sha256_note": src_sha_note,
            "pmtiles_spec_version": src_hdr.get("pmtiles spec version"),
            "tile_type": src_hdr.get("tile type"),
            "minzoom": src_hdr.get("_min_zoom"),
            "maxzoom": src_hdr.get("_max_zoom"),
            "planetiler_version": src_hdr.get("planetiler:version"),
            "planetiler_githash": src_hdr.get("planetiler:githash"),
            "planetiler_buildtime": src_hdr.get("planetiler:buildtime"),
            "osm_replication_time": src_hdr.get("planetiler:osm:osmosisreplicationtime"),
            "osm_replication_seq": src_hdr.get("planetiler:osm:osmosisreplicationseq"),
            "osm_replication_url": src_hdr.get("planetiler:osm:osmosisreplicationurl"),
            "basemap_name": src_hdr.get("name"),
            "basemap_version": src_hdr.get("version"),
            "attribution": src_hdr.get("attribution"),
        },
        "extract": {
            "tool": "pmtiles CLI (go-pmtiles)",
            "tool_version": ver,
            # 命令里只记工具名与仓库相对路径：绝对路径换台机器或换平台就失效，
            # 清单也就不再可复跑。工具的具体版本另记在 tool_version。
            "command": ["pmtiles" if i == 0 else (repo_path(c) if os.sep in c else c)
                        for i, c in enumerate(real["command"])],
            "bbox": bbox,
            "minzoom": a.minzoom,
            "maxzoom": a.maxzoom,
            "overfetch": 0.05,
            "dry_run_region_tiles": est["region_tiles"],
            "dry_run_tile_entries": est["tile_entries"],
            "dry_run_archive_size_text": est["archive_size_text"],
        },
        "output": {
            "file": os.path.basename(out),
            "size_bytes": os.path.getsize(out),
            "sha256": out_sha,
            "bounds": hdr.get("_bounds"),
            "minzoom": hdr.get("_min_zoom"),
            "maxzoom": hdr.get("_max_zoom"),
            "addressed_tiles": hdr.get("_addressed_tiles_count"),
            "tile_entries": hdr.get("_tile_entries_count"),
            "tile_contents": hdr.get("_tile_contents_count"),
            "tile_compression": hdr.get("tile compression"),
            "vector_layers": [{"id": l.get("id"), "minzoom": l.get("minzoom"), "maxzoom": l.get("maxzoom")}
                              for l in meta.get("vector_layers", [])],
            "checks": checks,
        },
        "generated_at_utc": utc_now(),
        "generator": {
            "script": os.path.relpath(os.path.abspath(__file__), ROOT),
            "git_commit": git_commit(),
            "python": platform.python_version(),
            "platform": platform.platform(),
            "note": "在 macOS 开发机生成；按 D-015 / D-016，macOS 结果不作验收依据，数据包本身与平台无关",
        },
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    info(f"\nD0-2 完成：{aid}  zoom {a.minzoom}-{a.maxzoom}  {hdr.get('_tile_entries_count')} 块瓦片  "
         f"{os.path.getsize(out)} 字节  sha256 {out_sha[:16]}…  OSM {src_hdr.get('planetiler:osm:osmosisreplicationtime')}")
    info(f"  产物 {os.path.relpath(out, ROOT)}\n  清单 {os.path.relpath(manifest_path, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
