#!/usr/bin/env python3
"""把机型预设表生成成 C++ 源（Q-2，14 号报告 §2，决策 D-088）。

真理源：
    models/radiator/presets-v1.json  →  geo/src/radiator_presets.cpp

引擎与 geo 不在运行时读 JSON（同 FIR 系数表，scripts/gen_fir_taps.py 的头注）。生成前先把
预设表的不变量逐条核一遍，任何一条不成立就不写文件（铁律 15：宁可报错不生成有问题的表）：

  · 原生采样率 = FFT 点数 × 子载波间隔，逐位相等；
  · 占用带宽 = (2K+1) × 子载波间隔，且 2K+1 < FFT 点数；
  · 时隙长是整数个原生样点（2 / 4 / 640 ms 在 15.36 / 30.72 / 61.44 MS/s 下都是）；
  · ZC 根与序列长 2K+1 互素（2401 = 7⁴，根不能是 7 的倍数）；
  · 时隙循环每行是概率分布、和为 1（容差 1e-12）；
  · 图传的时隙概率与 frame_fit 里的实测占空、长突发占比按闭式一致（D）；
  · 上行的空过概率 q 与 frame_fit 里的 10 ms 间隔占比满足 q(1−q) = f（取四位小数）；
  · DroneID 突发恰为 9880 个原生样点（643.23 µs，NDSS23 §III-B）。

用法：
    uv run --quiet python scripts/gen_radiator_presets.py          # 核对并写 C++
    uv run --quiet python scripts/gen_radiator_presets.py --check  # 只核对，生成结果与盘上不同即退出 1

只用标准库。路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLE = os.path.join("models", "radiator", "presets-v1.json")
OUT = os.path.join("geo", "src", "radiator_presets.cpp")

BITS_PER_AXIS = {"qpsk": 1, "16qam": 2, "64qam": 3}
TYPES = {"ofdm", "droneid"}
ROLES = {"video_link", "rc_hopping", "droneid"}


class TableError(Exception):
    pass


def _need(cond: bool, msg: str) -> None:
    if not cond:
        raise TableError(msg)


def burst_cp(burst: dict, num: dict) -> list:
    cs = burst.get("cp_short", num["cp_short"])
    cl = burst.get("cp_long", num["cp_long"])
    longs = set(burst["cp_long_at"])
    return [cl if i in longs else cs for i in range(burst["n_symbols"])]


def burst_zc(burst: dict) -> list:
    z = [0] * burst["n_symbols"]
    for idx, root in burst["zc"]:
        z[idx] = root
    return z


def closed_form_draw(duty: float, lam: float, slot_s: float, ds: float, dl: float, block: bool) -> list:
    """每时隙「空 / 短 / 长」的概率：由占空与长突发占比闭式解出（D）。

    记 s = P(短) + P(长)、λ = P(长)/s。长突发超出时隙时封住下一时隙（block），
    于是每时隙的突发率为 s/(1 + λs)，占空 = (P(短)·ds + P(长)·dl) / ((1 + λs)·slot)。
    令它等于实测占空解出 s。
    """
    b = 1.0 if block else 0.0
    s = duty * slot_s / ((1.0 - lam) * ds + lam * dl - duty * slot_s * lam * b)
    return [1.0 - s, (1.0 - lam) * s, lam * s]


def validate(doc: dict) -> list:
    _need(doc.get("schema") == "cuav-radiator-presets/1", "schema 不是 cuav-radiator-presets/1")
    _need(doc.get("version") == "v1", "version 不是 v1")
    nums = {}
    for n in doc["numerologies"]:
        fs = n["fft_size"] * n["subcarrier_spacing_Hz"]
        _need(fs == n["fs_native_Hz"], f"{n['id']}：fs_native_Hz ≠ fft_size × subcarrier_spacing_Hz")
        _need(n["fft_size"] & (n["fft_size"] - 1) == 0, f"{n['id']}：fft_size 不是 2 的幂")
        _need(n["cp_long"] >= n["cp_short"] > 0, f"{n['id']}：CP 长度不合理")
        nums[n["id"]] = n
    out = []
    seen = set()
    for p in doc["presets"]:
        pid = p["id"]
        _need(pid not in seen, f"预设 id 重复：{pid}")
        seen.add(pid)
        _need(p["type"] in TYPES, f"{pid}：type 须为 {sorted(TYPES)}")
        _need(p["role"] in ROLES, f"{pid}：role 须为 {sorted(ROLES)}")
        _need(p["numerology"] in nums, f"{pid}：未知数值结构 {p['numerology']}")
        num = nums[p["numerology"]]
        k = p["half_subcarriers"]
        nzc = 2 * k + 1
        _need(k >= 1 and nzc < num["fft_size"], f"{pid}：half_subcarriers 越界")
        _need(p["occupied_bw_Hz"] == nzc * num["subcarrier_spacing_Hz"],
              f"{pid}：occupied_bw_Hz 应为 (2K+1)·Δf = {nzc * num['subcarrier_spacing_Hz']}")
        _need(p["constellation"] in BITS_PER_AXIS, f"{pid}：未知星座 {p['constellation']}")
        _need(p["credibility"] in ("V1", "V2"), f"{pid}：credibility 须为 V1 / V2")
        bursts = []
        for bi, b in enumerate(p["bursts"]):
            ns = b["n_symbols"]
            _need(ns >= 1, f"{pid} 突发 {bi}：n_symbols ≥ 1")
            _need(all(0 <= i < ns for i in b["cp_long_at"]), f"{pid} 突发 {bi}：cp_long_at 越界")
            for idx, root in b["zc"]:
                _need(0 <= idx < ns, f"{pid} 突发 {bi}：ZC 符号下标越界")
                _need(1 <= root < nzc and math.gcd(root, nzc) == 1,
                      f"{pid} 突发 {bi}：ZC 根 {root} 须在 [1, {nzc}) 且与 {nzc} 互素")
            cp = burst_cp(b, num)
            length = sum(num["fft_size"] + c for c in cp)
            bursts.append({"cp": cp, "zc": burst_zc(b), "length": length, "n_symbols": ns})
        slot = p["frame"]["slot_s"] * num["fs_native_Hz"]
        slot_n = int(round(slot))
        _need(abs(slot - slot_n) < 1e-6 and slot_n > 0, f"{pid}：时隙 {p['frame']['slot_s']} s 不是整数个原生样点")
        cycle = p["frame"]["cycle"]
        _need(len(cycle) >= 1, f"{pid}：cycle 为空")
        for row in cycle:
            _need(len(row) == len(bursts) + 1, f"{pid}：cycle 每行须有 {len(bursts) + 1} 项")
            _need(all(0.0 <= v <= 1.0 for v in row), f"{pid}：概率越界")
            _need(abs(sum(row) - 1.0) <= 1e-12, f"{pid}：cycle 行和 {sum(row)} ≠ 1")
        fit = p.get("frame_fit") or {}
        if "duty" in fit:
            _need(len(bursts) == 2 and len(cycle) == 1, f"{pid}：闭式拟合只用于一行两种突发")
            fs = num["fs_native_Hz"]
            ds, dl = bursts[0]["length"] / fs, bursts[1]["length"] / fs
            block = bursts[1]["length"] + 64 > slot_n
            want = closed_form_draw(fit["duty"], fit["long_share"], p["frame"]["slot_s"], ds, dl, block)
            _need(all(abs(a - b) <= 1e-12 for a, b in zip(want, cycle[0])),
                  f"{pid}：cycle 与 frame_fit 的闭式解不一致，应为 {want}")
        if "skip_prob" in fit:
            f10 = fit["interval_10ms_share"]
            q = round((1.0 - math.sqrt(1.0 - 4.0 * f10)) / 2.0, 4)
            _need(q == fit["skip_prob"], f"{pid}：skip_prob 应为 {q}")
        if pid == "dji-droneid":
            _need(bursts[0]["length"] == 9880, f"{pid}：突发应为 9880 个原生样点")
        out.append({"p": p, "num": num, "bursts": bursts, "slot_n": slot_n})
    return out


def _f(v: float) -> str:
    s = repr(float(v))
    return s if ("e" in s or "E" in s or "." in s) else s + ".0"


def _ident(pid: str) -> str:
    return "k" + "".join(part.capitalize() for part in pid.replace("-", "_").split("_"))


def render(items: list, sha: str) -> str:
    L = []
    w = L.append
    w("// 机型预设表 v1 —— 本文件由脚本生成，不要手改。")
    w("//")
    w(f"// 来源：{TABLE.replace(os.sep, '/')}（sha256 {sha}）")
    w("// 生成：uv run --quiet python scripts/gen_radiator_presets.py")
    w("//")
    w("// 每项参数的出处档（V / P / S / A / D / M）与引文只在 JSON 的 provenance 里，这里只放")
    w("// 生成与评价要用的数。与 JSON 的一致性由 engine/tests/test_ofdm.cpp 逐项核对（铁律 10）。")
    w("")
    w('#include "cuav_geo/radiator_presets.h"')
    w("")
    w("namespace cuav {")
    w("namespace geo {")
    w("namespace {")
    w("")
    for it in items:
        p = it["p"]
        base = _ident(p["id"])
        for bi, b in enumerate(it["bursts"]):
            w(f"// {p['id']} 突发 {bi}：{b['n_symbols']} 符号、{b['length']} 个原生样点")
            w(f"const int {base}Cp{bi}[{b['n_symbols']}] = {{{', '.join(str(c) for c in b['cp'])}}};")
            w(f"const int {base}Zc{bi}[{b['n_symbols']}] = {{{', '.join(str(z) for z in b['zc'])}}};")
        w(f"const RadiatorBurst {base}Bursts[{len(it['bursts'])}] = {{")
        for bi, b in enumerate(it["bursts"]):
            w(f"    {{ {b['n_symbols']}, {base}Cp{bi}, {base}Zc{bi}, {b['length']} }},")
        w("};")
        cyc = [v for row in p["frame"]["cycle"] for v in row]
        w(f"const double {base}Cycle[{len(cyc)}] = {{{', '.join(_f(v) for v in cyc)}}};")
        w("")
    w("const RadiatorPreset kPresets[] = {")
    for it in items:
        p, num = it["p"], it["num"]
        base = _ident(p["id"])
        w("    {")
        w(f'        "{p["id"]}", "{p["type"]}", "{p["role"]}", "{p["credibility"]}",')
        w(f"        {num['fft_size']}, {_f(num['fs_native_Hz'])}, {_f(num['subcarrier_spacing_Hz'])},")
        w(f"        {p['half_subcarriers']}, {_f(p['occupied_bw_Hz'])},")
        w(f"        {BITS_PER_AXIS[p['constellation']]},")
        w(f"        {len(it['bursts'])}, {base}Bursts,")
        w(f"        {it['slot_n']}, {len(p['frame']['cycle'])}, {base}Cycle,")
        w("    },")
    w("};")
    w("")
    w(f'const char kSha256[] = "{sha}";')
    w("")
    w("}  // namespace")
    w("")
    w("const RadiatorPreset* radiator_preset_v1(const std::string& id) {")
    w("    for (std::size_t i = 0; i < sizeof(kPresets) / sizeof(kPresets[0]); ++i) {")
    w("        if (id == kPresets[i].id) return &kPresets[i];")
    w("    }")
    w("    return 0;  // 不在表里：由调用方报错并列出可取值，不静默顶替（铁律 15）")
    w("}")
    w("")
    w("std::size_t radiator_preset_v1_count() { return sizeof(kPresets) / sizeof(kPresets[0]); }")
    w("")
    w("const RadiatorPreset& radiator_preset_v1_at(std::size_t i) { return kPresets[i]; }")
    w("")
    w("const char* radiator_presets_v1_sha256() { return kSha256; }")
    w("")
    w("}  // namespace geo")
    w("}  // namespace cuav")
    return "\n".join(L) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="只核对：生成结果与盘上文件不同即退出 1")
    a = ap.parse_args()
    path = os.path.join(_ROOT, TABLE)
    with open(path, "rb") as f:
        raw = f.read()
    sha = hashlib.sha256(raw).hexdigest()
    try:
        items = validate(json.loads(raw.decode("utf-8")))
    except TableError as e:
        print(f"预设表不合格：{e}", file=sys.stderr)
        return 1
    text = render(items, sha)
    out = os.path.join(_ROOT, OUT)
    if a.check:
        with open(out, "r", encoding="utf-8", newline="") as f:
            same = f.read() == text
        print(("一致：" if same else "不一致：") + OUT.replace(os.sep, "/"))
        return 0 if same else 1
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"写出 {OUT.replace(os.sep, '/')}：{len(items)} 个预设，表 sha256 {sha[:16]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
