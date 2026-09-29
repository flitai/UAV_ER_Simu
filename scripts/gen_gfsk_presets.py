#!/usr/bin/env python3
"""把 GFSK 族机型预设表生成成 C++ 源（Q-3，14 号报告 §3，决策 D-089）。

真理源：
    models/radiator/gfsk-presets-v1.json  →  geo/src/gfsk_presets.cpp

与 OFDM 族那张表（models/radiator/presets-v1.json，scripts/gen_radiator_presets.py）分开：那张表的
sha256 钉在 OFDM 的两份黄金基准里，而它的结构（FFT 点数、CP、时隙抽签）本来也套不上 GFSK。

引擎与 geo 不在运行时读 JSON（同 FIR 系数表）。生成前先把不变量逐条核一遍，任何一条不成立就不写
文件（铁律 15：宁可报错，不生成有问题的表）：

  · 符号率、频偏、信道间隔、基频按 CC2500 数据手册的寄存器公式由 registers 复算，**逐位相等**
    （26 MHz 乘整数再除以 2 的幂，双精度下是精确的）；
  · 调制类型、前导字节数、同步位数与 MDMCFG2 / MDMCFG1 的相应位一致；
  · 占用带宽 = Carson 带宽 2·(f_dev + R/2)，逐位；
  · 帧内各包不重叠、相邻包之间留有空档（含跨周期那一对）；定长包的比特数与 PKTLEN / CRC 一致；
  · 跳频的停留 = 帧周期；频点表按规则复算（FrSky：1.5 MHz 栅格与两个例外点；S-FHSS：基频 + (16+6k)·间隔）；
  · S-FHSS 的跳频规则对每个 code 都是访遍 30 点的 30 格循环。

用法：
    uv run --quiet python scripts/gen_gfsk_presets.py          # 核对并写 C++
    uv run --quiet python scripts/gen_gfsk_presets.py --check  # 只核对，生成结果与盘上不同即退出 1

只用标准库。路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLE = os.path.join("models", "radiator", "gfsk-presets-v1.json")
OUT = os.path.join("geo", "src", "gfsk_presets.cpp")

FOSC_HZ = 26e6
TYPES = {"gfsk"}
ROLES = {"rc_hopping"}
MODULATIONS = {"gfsk": 1, "2fsk": 0}          # MDMCFG2[6:4]：001 = GFSK，000 = 2-FSK
PREAMBLE_BYTES = [2, 3, 4, 6, 8, 12, 16, 24]  # MDMCFG1[6:4]
RULES = {"step_mod", "sfhss"}


class TableError(Exception):
    pass


def _need(cond: bool, msg: str) -> None:
    if not cond:
        raise TableError(msg)


def _reg(regs: dict, name: str) -> int:
    _need(name in regs, f"缺寄存器 {name}")
    return int(regs[name], 16)


def symbol_rate(regs: dict) -> float:
    return (256 + _reg(regs, "MDMCFG3")) * 2 ** (_reg(regs, "MDMCFG4") & 0xF) * FOSC_HZ / 2 ** 28


def deviation(regs: dict) -> float:
    d = _reg(regs, "DEVIATN")
    return FOSC_HZ / 2 ** 17 * (8 + (d & 7)) * 2 ** ((d >> 4) & 7)


def channel_spacing(regs: dict) -> float:
    return FOSC_HZ / 2 ** 18 * (256 + _reg(regs, "MDMCFG0")) * 2 ** (_reg(regs, "MDMCFG1") & 3)


def base_freq(regs: dict) -> float:
    return _reg(regs, "FREQ") * FOSC_HZ / 2 ** 16


def sfhss_next(k: int, code: int) -> int:
    """MPM Futaba_cc2500.ino 的 SFHSS_calc_next_chan()，逐句转写。"""
    k += code + 2
    if k > 29:
        if k < 31:
            k += code + 2
        k -= 31
    return k


def sync_bits_of(word: str) -> int:
    _need(word.startswith("0x"), "sync_word 须写成十六进制")
    return 4 * (len(word) - 2)


def validate(doc: dict) -> list:
    _need(doc.get("schema") == "cuav-gfsk-presets/1", "schema 不是 cuav-gfsk-presets/1")
    _need(doc.get("version") == "v1", "version 不是 v1")
    out = []
    seen = set()
    for p in doc["presets"]:
        pid = p["id"]
        _need(pid not in seen, f"预设 id 重复：{pid}")
        seen.add(pid)
        _need(p["type"] in TYPES, f"{pid}：type 须为 {sorted(TYPES)}")
        _need(p["role"] in ROLES, f"{pid}：role 须为 {sorted(ROLES)}")
        _need(p["credibility"] in ("V1", "V2"), f"{pid}：credibility 须为 V1 / V2")
        regs = p["registers"]
        R, fd = symbol_rate(regs), deviation(regs)
        _need(p["symbol_rate_Hz"] == R, f"{pid}：symbol_rate_Hz 应为寄存器复算值 {R!r}")
        _need(p["deviation_Hz"] == fd, f"{pid}：deviation_Hz 应为寄存器复算值 {fd!r}")
        _need(p["occupied_bw_Hz"] == 2.0 * (fd + R / 2.0),
              f"{pid}：occupied_bw_Hz 应为 Carson 带宽 {2.0 * (fd + R / 2.0)!r}")
        mod = p["modulation"]
        _need(mod in MODULATIONS, f"{pid}：modulation 须为 {sorted(MODULATIONS)}")
        m2 = _reg(regs, "MDMCFG2")
        _need((m2 >> 4) & 7 == MODULATIONS[mod], f"{pid}：modulation 与 MDMCFG2[6:4] 不一致")
        if mod == "gfsk":
            _need(p["bt"] == 1.0, f"{pid}：CC2500 的 GFSK 是 BT = 1（SWRS040C §16.1）")
        else:
            _need(p["bt"] is None, f"{pid}：2-FSK 不带 bt")
        pre = PREAMBLE_BYTES[(_reg(regs, "MDMCFG1") >> 4) & 7]
        _need(p["preamble_bytes"] == pre, f"{pid}：preamble_bytes 应为 {pre}（MDMCFG1[6:4]）")
        sync_mode = m2 & 7
        want_sync = 32 if sync_mode in (3, 7) else 16
        sb = sync_bits_of(p["sync_word"])
        _need(sb == want_sync, f"{pid}：同步字应为 {want_sync} 位（MDMCFG2 SYNC_MODE {sync_mode}）")
        if want_sync == 32:
            w = p["sync_word"][2:]
            _need(w[:4] == w[4:], f"{pid}：32 位同步是 16 位同步字重复一次")
        head_bits = 8 * pre + sb

        fr = p["frame"]
        period = fr["period_s"]
        _need(period > 0.0, f"{pid}：period_s 须为正")
        pk = fr["packets"]
        _need(len(pk) >= 1, f"{pid}：至少一个包")
        spans = []
        for i, q in enumerate(pk):
            nb = q["n_bits"]
            _need(isinstance(nb, int) and nb > head_bits, f"{pid} 包 {i}：n_bits 须为大于前导 + 同步（{head_bits}）的整数")
            _need(q["offset_s"] >= 0.0, f"{pid} 包 {i}：offset_s ≥ 0")
            spans.append((q["offset_s"], q["offset_s"] + nb / R))
        for i in range(len(spans)):
            a0, a1 = spans[i]
            b0 = spans[i + 1][0] if i + 1 < len(spans) else spans[0][0] + period
            _need(a1 < b0, f"{pid}：包 {i} 结束于 {a1} s，不早于下一个包的起点 {b0} s")
        if "PKTLEN" in regs:
            crc = 2 if (_reg(regs, "PKTCTRL0") >> 2) & 1 else 0
            nb = 8 * (pre + sb // 8 + _reg(regs, "PKTLEN") + crc)
            _need(all(q["n_bits"] == nb for q in pk), f"{pid}：定长包应为 {nb} 比特（前导 + 同步 + PKTLEN + CRC）")

        hop = p["hop"]
        _need(hop["dwell_s"] == period, f"{pid}：跳频停留须等于帧周期")
        _need(hop["rule"] in RULES, f"{pid}：未知跳频规则 {hop['rule']}")
        ch = hop["channels_Hz"]
        if hop["rule"] == "step_mod":
            n = len(ch)
            _need(n == 47, f"{pid}：FrSky 频点表 47 点")
            want = [2404e6 + 1.5e6 * j + (6e5 if j in (18, 44) else 0.0) for j in range(n)]
            _need(ch == want, f"{pid}：频点表应为 2404.0 + 1.5·j MHz、j = 18 / 44 各 +0.6 MHz")
            st = hop["step"]
            _need(1 <= st < n and _gcd(st, n) == 1, f"{pid}：步进须与 {n} 互素才访遍全部频点")
        else:
            b, s = base_freq(regs), channel_spacing(regs)
            want = [b + (16 + 6 * k) * s for k in range(30)]
            _need(ch == want, f"{pid}：S-FHSS 频点表应为 FREQ + (16 + 6k)·间隔，k = 0…29")
            for code in range(28):
                k, seq = 0, []
                for _ in range(60):
                    seq.append(k)
                    k = sfhss_next(k, code)
                _need(sorted(set(seq)) == list(range(30)) and seq[:30] == seq[30:],
                      f"{pid}：code {code} 的跳频序列不是访遍 30 点的 30 格循环")
        out.append({"p": p, "R": R, "fd": fd})
    return out


def _gcd(a: int, b: int) -> int:
    while b:
        a, b = b, a % b
    return a


def _f(v: float) -> str:
    s = repr(float(v))
    return s if ("e" in s or "E" in s or "." in s) else s + ".0"


def _ident(pid: str) -> str:
    return "k" + "".join(part.capitalize() for part in pid.replace("-", "_").split("_"))


def render(items: list, sha: str) -> str:
    L = []
    w = L.append
    w("// GFSK 族机型预设表 v1 —— 本文件由脚本生成，不要手改。")
    w("//")
    w(f"// 来源：{TABLE.replace(os.sep, '/')}（sha256 {sha}）")
    w("// 生成：uv run --quiet python scripts/gen_gfsk_presets.py")
    w("//")
    w("// 每项参数的出处档（V / P / S / A / D / M）与引文只在 JSON 的 provenance 里，这里只放")
    w("// 生成与评价要用的数。与 JSON 的一致性由 engine/tests/test_gfsk.cpp 逐项核对（铁律 10）。")
    w("// 跳频频点表不在这里：频点写在场景的 hop 活动里（由 algos/reference/gfsk_ref.py 生成）。")
    w("")
    w('#include "cuav_geo/gfsk_presets.h"')
    w("")
    w("namespace cuav {")
    w("namespace geo {")
    w("namespace {")
    w("")
    for it in items:
        p = it["p"]
        base = _ident(p["id"])
        pk = p["frame"]["packets"]
        w(f"const GfskPacket {base}Packets[{len(pk)}] = {{")
        for q in pk:
            w(f"    {{ {_f(q['offset_s'])}, {q['n_bits']} }},")
        w("};")
    w("")
    w("const GfskPreset kPresets[] = {")
    for it in items:
        p = it["p"]
        base = _ident(p["id"])
        gauss = MODULATIONS[p["modulation"]]
        w("    {")
        w(f'        "{p["id"]}", "{p["type"]}", "{p["role"]}", "{p["credibility"]}",')
        w(f"        {gauss}, {_f(p['bt'] if p['bt'] is not None else 0.0)},")
        w(f"        {_f(p['symbol_rate_Hz'])}, {_f(p['deviation_Hz'])}, {_f(p['occupied_bw_Hz'])},")
        w(f"        {8 * p['preamble_bytes']}, {p['sync_word']}u, {sync_bits_of(p['sync_word'])},")
        w(f"        {_f(p['frame']['period_s'])}, {len(p['frame']['packets'])}, {base}Packets,")
        w(f"        {_f(p['hop']['dwell_s'])},")
        w("    },")
    w("};")
    w("")
    w(f'const char kSha256[] = "{sha}";')
    w("")
    w("}  // namespace")
    w("")
    w("const GfskPreset* gfsk_preset_v1(const std::string& id) {")
    w("    for (std::size_t i = 0; i < sizeof(kPresets) / sizeof(kPresets[0]); ++i) {")
    w("        if (id == kPresets[i].id) return &kPresets[i];")
    w("    }")
    w("    return 0;  // 不在表里：由调用方报错并列出可取值，不静默顶替（铁律 15）")
    w("}")
    w("")
    w("std::size_t gfsk_preset_v1_count() { return sizeof(kPresets) / sizeof(kPresets[0]); }")
    w("")
    w("const GfskPreset& gfsk_preset_v1_at(std::size_t i) { return kPresets[i]; }")
    w("")
    w("const char* gfsk_presets_v1_sha256() { return kSha256; }")
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
        print(f"GFSK 预设表不合格：{e}", file=sys.stderr)
        return 1
    text = render(items, sha)
    out = os.path.join(_ROOT, OUT)
    if a.check:
        try:
            with open(out, "r", encoding="utf-8", newline="") as f:
                same = f.read() == text
        except FileNotFoundError:
            same = False
        print(("一致：" if same else "不一致：") + OUT.replace(os.sep, "/"))
        return 0 if same else 1
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"写出 {OUT.replace(os.sep, '/')}：{len(items)} 个预设，表 sha256 {sha[:16]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
