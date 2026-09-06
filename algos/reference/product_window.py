#!/usr/bin/env python3
"""显示产品视窗抽取的参考实现（06 备忘录 §9A B-7；docs/display-products.md §3；决策 D-046）。

服务端 `server/src/products/` 用 TypeScript 做同样的归约，两侧对**同一产品文件、同一查询**
必须逐值一致，这是 B-7 的验收条件。本文件是那一侧的独立第二实现（D-036 的做法）。

三条实现纪律：

1. **只用标准库**。归约是整数选择加顺序累加，不需要 numpy；引入 numpy 反而会破坏第 2 条。
2. **顺序累加，不用 `sum()`、不用 numpy**。CPython 3.12 起内置 `sum()` 对 float 采用 Neumaier
   补偿求和，numpy 的 `sum` 用成对求和，两者都不是「acc = acc + x」的顺序累加，与 JavaScript
   的累加逐位不同。这里一律写显式 for 循环。
3. **float32 边界显式化**。产品文件里的值是 float32，读出来在 float64 里是精确的；累加在
   float64；写回结果时用 `to_f32()` 显式舍入一次，与 TypeScript 的 `Float32Array` 赋值等价。

两种用法：

    # 对真实产品目录抽取，写 float32 小端的二维结果
    uv run --quiet python algos/reference/product_window.py data/runs/<task>/<op> \\
        --kind spectrum --t0 0.3 --t1 1.2 --px 800 --py 400 --stat mean --out win.f32

    # 生成黄金基准（合成产品 + 用例表），供 server 侧单元测试比对
    uv run --quiet python algos/reference/product_window.py --golden tests/golden/product-window.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys

# ---------------------------------------------------------------- 常量（与 window.ts 同值）

MAX_BYTES = 16 * 1024 * 1024
CAP_PY = 2048
CAP_PX = 4096
ENVELOPE_ROW_LEN = 3

GOLDEN_SCHEMA = "cuav-server-golden/1"


def to_f32(x: float) -> float:
    """把 float64 舍入到 float32 再回到 float64，与 TypeScript 写 Float32Array 等价。"""
    return struct.unpack("<f", struct.pack("<f", x))[0]


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


# ---------------------------------------------------------------- 选择与分组（对译 window.ts）


def select_rows(t0, t1, dt: float, rows_avail: int):
    n = max(0, int(rows_avail))
    if not dt > 0:
        return (0, n)
    lo = 0 if t0 is None else int(clamp(math.floor(t0 / dt), 0, n))
    hi = n if t1 is None else int(clamp(math.ceil(t1 / dt), 0, n))
    return (lo, max(lo, hi))


def select_cols(f0, f1, bw: float, nfft: int):
    n = max(0, int(nfft))
    if not bw > 0:
        return (0, n)
    half = n // 2

    def u(f):
        return f / bw + half + 0.5

    lo = 0 if f0 is None else int(clamp(math.floor(u(f0)), 0, n))
    hi = n if f1 is None else int(clamp(math.ceil(u(f1)), 0, n))
    return (lo, max(lo, hi))


def col_edge_hz(c: int, bw: float, nfft: int) -> float:
    return (c - (nfft // 2) - 0.5) * bw


def group_bounds(n: int, m: int):
    if m <= 0:
        return [0]
    return [(g * n) // m for g in range(m + 1)]


def group_count(n: int, target, cap: int) -> int:
    if n <= 0:
        return 0
    want = min(n, max(1, cap)) if target is None else min(int(target), n)
    return max(1, want)


# ---------------------------------------------------------------- 归约（对译 spectrum.ts / envelope.ts）


def plan_spectrum(geom: dict, q: dict) -> dict:
    row_span = select_rows(q["t0"], q["t1"], geom["dt"], geom["rows_avail"])
    col_span = select_cols(q["f0"], q["f1"], geom["bw"], geom["nfft"])
    n_rows = row_span[1] - row_span[0]
    n_cols = col_span[1] - col_span[0]
    cols = group_count(n_cols, q["px"], CAP_PX)
    cap_py = max(1, min(CAP_PY, MAX_BYTES // (cols * 4))) if cols > 0 else CAP_PY
    rows = group_count(n_rows, q["py"], cap_py)
    return {
        "row_span": row_span,
        "col_span": col_span,
        "rb": group_bounds(n_rows, rows),
        "cb": group_bounds(n_cols, cols),
        "rows": rows,
        "cols": cols,
        "bytes": rows * cols * 4,
        "t0": row_span[0] * geom["dt"],
        "t1": row_span[1] * geom["dt"],
        "f0": col_edge_hz(col_span[0], geom["bw"], geom["nfft"]),
        "f1": col_edge_hz(col_span[1], geom["bw"], geom["nfft"]),
    }


def reduce_spectrum(read_row, geom: dict, q: dict):
    """read_row(i) -> 长度 nfft 的 float 列表。返回 (out: list[float], plan)。"""
    p = plan_spectrum(geom, q)
    out = [0.0] * (p["rows"] * p["cols"])
    if p["rows"] == 0 or p["cols"] == 0:
        return ([], p)
    stat = q["stat"]
    for gi in range(p["rows"]):
        ra = p["row_span"][0] + p["rb"][gi]
        rb_end = p["row_span"][0] + p["rb"][gi + 1]
        if stat == "max":
            state = [-math.inf] * p["cols"]
        elif stat == "min":
            state = [math.inf] * p["cols"]
        else:
            state = [0.0] * p["cols"]
        for i in range(ra, rb_end):
            row = read_row(i)
            for h in range(p["cols"]):
                k0 = p["col_span"][0] + p["cb"][h]
                k1 = p["col_span"][0] + p["cb"][h + 1]
                acc = state[h]
                if stat == "max":
                    for k in range(k0, k1):
                        v = row[k]
                        if v > acc:
                            acc = v
                elif stat == "min":
                    for k in range(k0, k1):
                        v = row[k]
                        if v < acc:
                            acc = v
                else:
                    for k in range(k0, k1):
                        acc = acc + 10.0 ** (row[k] / 10.0)
                state[h] = acc
        nr = rb_end - ra
        off = gi * p["cols"]
        for h in range(p["cols"]):
            if stat in ("max", "min"):
                out[off + h] = to_f32(state[h])
            else:
                cnt = nr * (p["cb"][h + 1] - p["cb"][h])
                out[off + h] = to_f32(10.0 * math.log10(state[h] / cnt))
    return (out, p)


def plan_envelope(geom: dict, q: dict) -> dict:
    row_span = select_rows(q["t0"], q["t1"], geom["dt"], geom["rows_avail"])
    n_rows = row_span[1] - row_span[0]
    cap = max(1, min(CAP_PX, MAX_BYTES // (ENVELOPE_ROW_LEN * 4)))
    rows = group_count(n_rows, q["px"], cap)
    return {
        "row_span": row_span,
        "rb": group_bounds(n_rows, rows),
        "rows": rows,
        "cols": ENVELOPE_ROW_LEN,
        "bytes": rows * ENVELOPE_ROW_LEN * 4,
        "t0": row_span[0] * geom["dt"],
        "t1": row_span[1] * geom["dt"],
    }


def bucket_weight(geom: dict, j: int) -> int:
    if geom["index_final"] and j == geom["rows_avail"] - 1 and geom["last_bucket_samples"] > 0:
        return geom["last_bucket_samples"]
    return geom["bucket_samples"]


def reduce_envelope(read_row, geom: dict, q: dict):
    p = plan_envelope(geom, q)
    if p["rows"] == 0:
        return ([], p)
    out = [0.0] * (p["rows"] * ENVELOPE_ROW_LEN)
    for gi in range(p["rows"]):
        ra = p["row_span"][0] + p["rb"][gi]
        rb_end = p["row_span"][0] + p["rb"][gi + 1]
        mn = math.inf
        mx = -math.inf
        acc = 0.0
        ntot = 0
        for j in range(ra, rb_end):
            row = read_row(j)
            a, b, rms = row[0], row[1], row[2]
            if a < mn:
                mn = a
            if b > mx:
                mx = b
            n = bucket_weight(geom, j)
            acc = acc + n * (rms * rms)
            ntot += n
        off = gi * ENVELOPE_ROW_LEN
        out[off] = to_f32(mn)
        out[off + 1] = to_f32(mx)
        out[off + 2] = to_f32(math.sqrt(acc / ntot))
    return (out, p)


# ---------------------------------------------------------------- 真实产品目录

def read_index(product_dir: str, kind: str) -> dict:
    with open(os.path.join(product_dir, f"{kind}.index.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def rows_available(path: str, row_len: int) -> int:
    """读端一律以文件长度定行数，不信索引里的 rows（docs/display-products.md §1.1）。"""
    return os.path.getsize(path) // (row_len * 4)


def make_file_reader(path: str, row_len: int):
    fh = open(path, "rb")

    def read_row(i: int):
        fh.seek(i * row_len * 4)
        raw = fh.read(row_len * 4)
        if len(raw) != row_len * 4:
            raise SystemExit(f"第 {i} 行短读：{len(raw)} / {row_len * 4} 字节")
        return list(struct.unpack(f"<{row_len}f", raw))

    return read_row, fh


def geom_from_index(idx: dict, rows_avail: int) -> dict:
    fs = float(idx["sample_rate_Hz"])
    if idx["kind"] == "spectrum":
        return {
            "dt": float(idx["frame_hop_samples"]) / fs,
            "bw": float(idx["bin_width_Hz"]),
            "nfft": int(idx["nfft"]),
            "rows_avail": rows_avail,
        }
    return {
        "dt": float(idx["bucket_samples"]) / fs,
        "rows_avail": rows_avail,
        "bucket_samples": int(idx["bucket_samples"]),
        "last_bucket_samples": int(idx.get("last_bucket_samples", 0)),
        "index_final": int(idx["rows"]) == rows_avail,
    }


# ---------------------------------------------------------------- 合成产品（黄金基准的输入）
#
# 只用整数与 1/16 的倍数，两种语言写出的 float32 逐位相同，黄金基准里因此只存公式与哈希。

SPEC_FIXTURE = {
    "rows": 37,
    "nfft": 64,
    "sample_rate_Hz": 64000.0,
    "frame_hop_samples": 64,
    "bin_width_Hz": 1000.0,
    "center_Hz": 2.44e9,
    "t0_s": 0.5,
    "formula": "v[i][k] = -100 + ((i*37 + k*11) % 60) - ((i*k) % 7)*0.5；(i*7 + k) % 13 == 0 处取 -300",
}

ENV_FIXTURE = {
    "rows": 23,
    "sample_rate_Hz": 10000.0,
    "bucket_samples": 100,
    "last_bucket_samples": 37,
    "center_Hz": 0.0,
    "t0_s": 0.0,
    "formula": "mn = ((j*3)%11)/16；mx = mn + (((j*5)%7)+1)/8；rms = (mn+mx)/2",
}


def build_spectrum_fixture():
    rows, nfft = SPEC_FIXTURE["rows"], SPEC_FIXTURE["nfft"]
    data = []
    for i in range(rows):
        for k in range(nfft):
            if (i * 7 + k) % 13 == 0:
                data.append(-300.0)
            else:
                data.append(-100.0 + ((i * 37 + k * 11) % 60) - ((i * k) % 7) * 0.5)
    return data


def build_envelope_fixture():
    data = []
    for j in range(ENV_FIXTURE["rows"]):
        mn = ((j * 3) % 11) / 16.0
        mx = mn + ((((j * 5) % 7) + 1) / 8.0)
        data.append(mn)
        data.append(mx)
        data.append((mn + mx) / 2.0)
    return data


def pack_f32(values) -> bytes:
    return struct.pack(f"<{len(values)}f", *values)


def memory_reader(data, row_len: int):
    def read_row(i: int):
        return data[i * row_len : (i + 1) * row_len]

    return read_row


# ---------------------------------------------------------------- 用例表

def spec_query(t0=None, t1=None, f0=None, f1=None, px=None, py=None, stat="max"):
    return {"t0": t0, "t1": t1, "f0": f0, "f1": f1, "px": px, "py": py, "stat": stat}


def env_query(t0=None, t1=None, px=None):
    return {"t0": t0, "t1": t1, "px": px}


GOLDEN_CASES = [
    ("spec-full-default", "spectrum", None, spec_query()),
    ("spec-5x7-max", "spectrum", None, spec_query(px=7, py=5, stat="max")),
    ("spec-5x7-min", "spectrum", None, spec_query(px=7, py=5, stat="min")),
    ("spec-5x7-mean", "spectrum", None, spec_query(px=7, py=5, stat="mean")),
    ("spec-window-max", "spectrum", None, spec_query(t0=0.0035, t1=0.0121, f0=-12500, f1=7300, px=6, py=4, stat="max")),
    ("spec-no-interp", "spectrum", None, spec_query(px=1000, py=1000, stat="max")),
    ("spec-outside", "spectrum", None, spec_query(t0=1.0, t1=2.0)),
    ("spec-clamp", "spectrum", None, spec_query(t0=-5.0, t1=100.0, f0=-1e9, f1=1e9, px=8, py=3, stat="mean")),
    ("spec-1x1-mean", "spectrum", None, spec_query(px=1, py=1, stat="mean")),
    ("env-full-final", "envelope", 23, env_query(px=5)),
    ("env-full-unfinished", "envelope", 16, env_query(px=5)),
    ("env-window", "envelope", 23, env_query(t0=0.05, t1=0.155, px=3)),
]


def run_case(kind: str, index_rows, query: dict, spec_data, env_data):
    if kind == "spectrum":
        geom = {
            "dt": SPEC_FIXTURE["frame_hop_samples"] / SPEC_FIXTURE["sample_rate_Hz"],
            "bw": SPEC_FIXTURE["bin_width_Hz"],
            "nfft": SPEC_FIXTURE["nfft"],
            "rows_avail": SPEC_FIXTURE["rows"],
        }
        return reduce_spectrum(memory_reader(spec_data, SPEC_FIXTURE["nfft"]), geom, query)
    rows_avail = ENV_FIXTURE["rows"]
    geom = {
        "dt": ENV_FIXTURE["bucket_samples"] / ENV_FIXTURE["sample_rate_Hz"],
        "rows_avail": rows_avail,
        "bucket_samples": ENV_FIXTURE["bucket_samples"],
        "last_bucket_samples": ENV_FIXTURE["last_bucket_samples"],
        "index_final": int(index_rows) == rows_avail,
    }
    return reduce_envelope(memory_reader(env_data, ENVELOPE_ROW_LEN), geom, query)


def write_golden(path: str) -> int:
    spec_data = build_spectrum_fixture()
    env_data = build_envelope_fixture()
    cases = []
    for cid, kind, index_rows, query in GOLDEN_CASES:
        out, p = run_case(kind, index_rows, query, spec_data, env_data)
        expect = {"rows": p["rows"], "cols": p["cols"], "t0": p["t0"], "t1": p["t1"], "data": out}
        if kind == "spectrum":
            expect["f0"] = p["f0"]
            expect["f1"] = p["f1"]
        entry = {"id": cid, "kind": kind, "query": query, "expect": expect}
        if index_rows is not None:
            entry["index_rows"] = index_rows
        cases.append(entry)
    doc = {
        "schema": GOLDEN_SCHEMA,
        "purpose": "视窗抽取端点（B-7）的归约基准：服务端 TypeScript 与本 Python 参考对同一输入必须逐值一致",
        "generator": "algos/reference/product_window.py --golden",
        "note": "max / min / 包络三列逐位相同；mean 走 pow 与 log10，允许 1 个 float32 ulp 的差",
        "spectrum": dict(SPEC_FIXTURE, input_sha256=hashlib.sha256(pack_f32(spec_data)).hexdigest()),
        "envelope": dict(ENV_FIXTURE, input_sha256=hashlib.sha256(pack_f32(env_data)).hexdigest()),
        "cases": cases,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"写出 {path}：{len(cases)} 个用例")
    return 0


# ---------------------------------------------------------------- 命令行

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="显示产品视窗抽取参考实现（B-7）")
    ap.add_argument("product_dir", nargs="?", help="产品目录 data/runs/<task_id>/<op_id>")
    ap.add_argument("--kind", choices=["spectrum", "envelope"], default="spectrum")
    ap.add_argument("--t0", type=float, default=None)
    ap.add_argument("--t1", type=float, default=None)
    ap.add_argument("--f0", type=float, default=None)
    ap.add_argument("--f1", type=float, default=None)
    ap.add_argument("--px", type=int, default=None)
    ap.add_argument("--py", type=int, default=None)
    ap.add_argument("--stat", choices=["max", "mean", "min"], default="max")
    ap.add_argument("--out", help="结果写成 float32 小端、行主序的裸文件")
    ap.add_argument("--golden", help="改为生成黄金基准到该路径")
    args = ap.parse_args(argv)

    if args.golden:
        return write_golden(args.golden)
    if not args.product_dir:
        ap.error("要么给产品目录，要么给 --golden")

    idx = read_index(args.product_dir, args.kind)
    row_len = int(idx["row_len"])
    f32 = os.path.join(args.product_dir, f"{args.kind}.f32")
    avail = rows_available(f32, row_len)
    geom = geom_from_index(idx, avail)
    read_row, fh = make_file_reader(f32, row_len)
    try:
        if args.kind == "spectrum":
            out, p = reduce_spectrum(read_row, geom, spec_query(args.t0, args.t1, args.f0, args.f1, args.px, args.py, args.stat))
        else:
            out, p = reduce_envelope(read_row, geom, env_query(args.t0, args.t1, args.px))
    finally:
        fh.close()

    info = {
        "rows": p["rows"],
        "cols": p["cols"],
        "t0": p["t0"],
        "t1": p["t1"],
        "rows_available": avail,
        "index_rows": int(idx["rows"]),
        "state": idx.get("state"),
    }
    if args.kind == "spectrum":
        info["f0"] = p["f0"]
        info["f1"] = p["f1"]
        info["stat"] = args.stat
    print(json.dumps(info, ensure_ascii=False))
    if args.out:
        with open(args.out, "wb") as f:
            f.write(pack_f32(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
