#!/usr/bin/env python3
"""只读探测：统计观测区域内 z15 `buildings` 图层的要素数、id 稳定性与高度来源分布。

用途一：为观测区域范围大小的取舍提供实测代价（决策 D-024 即由本脚本的输出定的）。
用途二：D0-3 建筑解码的前置验证与代码底座——矢量瓦片的 protobuf 解析在这里已经写好，
`decode_buildings` 可直接复用，不必重写。

用法
    uv run python scene/probe_buildings.py --aoi beijing-yayuncun
    uv run python scene/probe_buildings.py --bbox 116.345,39.945,116.465,40.035 --name small

只用 Python 标准库加 pmtiles 命令行，不联网，不写任何文件。

**高度来源的判读（重要，D0-3 必须照此处理）**：瓦片里的 `height` 字段把两种来源混在一起——
真实的 `height` 标注，和 planetiler 按 `building:levels x 3 + 2` 推导出来的值。本脚本用
「取值为不小于 5 的整数且模 3 余 2」作推导值的判据，这**只是启发式**：一栋真高 20 米的楼会被
误判成推导值。因此瓦片本身给不出干净的 `src` 标记，要干净的来源标注只能在建库阶段拉一次
Overpass 原始标签（铁律 6 允许建库联网）。
"""
import argparse
import collections
import gzip
import os
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_tiles import (ROOT, DEFAULT_PLANET, die, info, need_pmtiles, load_aoi,  # noqa: E402
                         tile_xy, extent_km)


# ---------------------------------------------------------------------------
# 矢量瓦片（protobuf）最小解析：只做 D0-3 需要的部分
# ---------------------------------------------------------------------------
def varint(b: bytes, i: int):
    r = s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << s
        if not x & 0x80:
            return r, i
        s += 7


def fields(b: bytes, i: int, end: int):
    """逐个产出 (字段号, (线型, 值))；线型 b 的值是 (起, 止) 字节区间。"""
    while i < end:
        k, i = varint(b, i)
        no, wt = k >> 3, k & 7
        if wt == 0:
            v, i = varint(b, i); yield no, ("v", v)
        elif wt == 1:
            yield no, ("f8", b[i:i + 8]); i += 8
        elif wt == 2:
            ln, i = varint(b, i); yield no, ("b", (i, i + ln)); i += ln
        elif wt == 5:
            yield no, ("f4", b[i:i + 4]); i += 4
        else:
            raise ValueError(f"未知线型 {wt}")


def value_of(d: bytes, span) -> object:
    """解 Value 消息：字符串 / 浮点 / 双精度 / 整数 / 有符号整数。"""
    vs, ve = span
    for no, (wt, val) in fields(d, vs, ve):
        if no == 1 and wt == "b":
            return d[val[0]:val[1]].decode("utf-8", "ignore")
        if no == 2 and wt == "f4":
            return struct.unpack("<f", val)[0]
        if no == 3 and wt == "f8":
            return struct.unpack("<d", val)[0]
        if no in (4, 5) and wt == "v":
            return val
        if no == 6 and wt == "v":
            return (val >> 1) ^ -(val & 1)
        if no == 7 and wt == "v":
            return bool(val)
    return None


def read_tile(exe: str, planet: str, z: int, x: int, y: int) -> bytes | None:
    r = subprocess.run([exe, "tile", planet, str(z), str(x), str(y)], capture_output=True)
    raw = r.stdout
    if not raw:
        return None
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def scan_buildings(d: bytes) -> dict:
    """解出一块瓦片里 buildings 图层的要素 id、height 取值与 kind 分布。"""
    out = {"ids": [], "no_id": 0, "n": 0, "heights": [], "kinds": collections.Counter()}
    for no, (wt, val) in fields(d, 0, len(d)):
        if no != 3 or wt != "b":            # 3 = layers
            continue
        ls, le = val
        name, feats, keys, vals = None, [], [], []
        for fno, (fwt, fval) in fields(d, ls, le):
            if fno == 1 and fwt == "b":
                name = d[fval[0]:fval[1]].decode("utf-8", "ignore")
            elif fno == 2 and fwt == "b":
                feats.append(fval)          # 2 = features
            elif fno == 3 and fwt == "b":
                keys.append(d[fval[0]:fval[1]].decode("utf-8", "ignore"))
            elif fno == 4 and fwt == "b":
                vals.append(fval)           # 4 = values
        if name != "buildings":
            continue
        ki = {k: i for i, k in enumerate(keys)}
        h_i, k_i = ki.get("height"), ki.get("kind")
        for fs, fe in feats:
            out["n"] += 1
            fid, tags = None, []
            for fno, (fwt, fval) in fields(d, fs, fe):
                if fno == 1 and fwt == "v":
                    fid = fval              # 1 = id
                elif fno == 2 and fwt == "b":
                    ts, te = fval
                    i = ts
                    while i < te:           # 2 = tags（打包的 key/value 下标对）
                        t, i = varint(d, i)
                        tags.append(t)
            if fid is None:
                out["no_id"] += 1
            else:
                out["ids"].append(fid)
            pairs = dict(zip(tags[0::2], tags[1::2]))
            if h_i is not None and h_i in pairs:
                out["heights"].append(value_of(d, vals[pairs[h_i]]))
            if k_i is not None and k_i in pairs:
                out["kinds"][value_of(d, vals[pairs[k_i]])] += 1
    return out


def classify_heights(hs: list) -> dict:
    """按判读规则把 height 取值分成三档。判据是启发式，见模块文档字符串。"""
    nums = [float(v) for v in hs if isinstance(v, (int, float))]
    derived, other_int, frac = [], [], []
    for v in nums:
        if abs(v - round(v)) < 1e-9:
            (derived if (round(v) >= 5 and round(v) % 3 == 2) else other_int).append(v)
        else:
            frac.append(v)
    return {"n": len(nums), "levels_derived": len(derived), "other_int": len(other_int),
            "non_int": len(frac), "top": collections.Counter(nums).most_common(8)}


def main() -> int:
    ap = argparse.ArgumentParser(description="统计观测区域内 z15 建筑要素、id 与高度来源（只读）")
    ap.add_argument("--aoi")
    ap.add_argument("--bbox")
    ap.add_argument("--name")
    ap.add_argument("--planet", default=DEFAULT_PLANET)
    ap.add_argument("--zoom", type=int, default=15)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()

    aoi = load_aoi(a)
    bbox = aoi["bbox"]
    if not os.path.isfile(a.planet):
        die(f"底图不存在：{a.planet}")
    exe = need_pmtiles()

    z = a.zoom
    x0, y1 = tile_xy(bbox[0], bbox[1], z)
    x1, y0 = tile_xy(bbox[2], bbox[3], z)
    tiles = [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    km = extent_km(bbox)
    info(f"区域 {aoi['id']}  bbox {bbox}  约 {km[0]} x {km[1]} km  z{z} 瓦片 {len(tiles)} 块")

    agg = {"ids": set(), "no_id": 0, "n": 0, "heights": [], "kinds": collections.Counter(), "empty": 0}
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for d in ex.map(lambda t: read_tile(exe, a.planet, *t), tiles):
            if d is None:
                agg["empty"] += 1
                continue
            r = scan_buildings(d)
            agg["ids"].update(r["ids"])
            agg["no_id"] += r["no_id"]
            agg["n"] += r["n"]
            agg["heights"].extend(r["heights"])
            agg["kinds"] += r["kinds"]

    n, uniq = agg["n"], len(agg["ids"])
    info(f"空瓦片 {agg['empty']} 块")
    info(f"buildings 要素（含跨瓦片重复）{n}，按 id 去重后 {uniq}，无 id 的要素 {agg['no_id']}")
    if agg["no_id"] == 0 and n:
        info("  → 要素带稳定 id，跨瓦片合并可直接按 id 做（D0-3 首个未知点已验证）")
    h = classify_heights(agg["heights"])
    if n:
        info(f"带 height 字段 {h['n']}（{h['n'] / n * 100:.1f}%），其中")
        info(f"  疑似由 building:levels 推导（不小于 5 的整数且模 3 余 2）{h['levels_derived']}"
             f"（占全部要素 {h['levels_derived'] / n * 100:.1f}%）")
        info(f"  其它整数 {h['other_int']}（{h['other_int'] / n * 100:.1f}%）"
             f"，非整数 {h['non_int']}（{h['non_int'] / n * 100:.1f}%）→ 后两档合起来是真实标注的上界")
        info(f"  无任何高度信息 {n - h['n']}（{(n - h['n']) / n * 100:.1f}%）")
        info(f"  height 最常见取值 {h['top']}")
        info(f"kind 分布 {agg['kinds'].most_common(6)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
