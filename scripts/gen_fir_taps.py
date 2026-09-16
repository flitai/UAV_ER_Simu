#!/usr/bin/env python3
"""把 M-3 冻结的两张系数表生成成 C++ 源（06 备忘录 §9D M-3）。

真理源：
    models/channelizer/fir_pfb_v1.json  →  engine/src/pfb_taps.cpp   （--kind pfb）
    models/receiver/fir_rx_v1.json      →  engine/src/rx_taps.cpp    （--kind rx）

引擎不在运行时读 JSON——系数是常量，读文件会让组件依赖部署目录布局。两者是否同步由
engine/tests/test_channelizer.cpp 与 test_rx_filter.cpp 逐位核对，另比对表文件的 sha256，
避免「改了 JSON 忘了重生成」。做法与 M-2 的 scripts/gen_ddc_taps.py 完全一致。

**为什么不把 gen_ddc_taps.py 并进来**：`engine/src/ddc_taps.cpp` 的内容间接受
`engine/tests/golden/ddc.json` 的 table_sha256 锁着，合并两套生成器只要在排版上差一个字节
就要连带重生成 DDC 的黄金基准 —— 那是一次没有收益的基准变更（铁律 10）。两份脚本各管一摊。

用法：
    uv run --quiet python scripts/gen_fir_taps.py --kind pfb
    uv run --quiet python scripts/gen_fir_taps.py --kind rx

只用标准库。路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_KINDS = {
    "pfb": {
        "table": os.path.join("models", "channelizer", "fir_pfb_v1.json"),
        "out": os.path.join("engine", "src", "pfb_taps.cpp"),
        "design": "scripts/design_pfb_fir.py",
        "test": "engine/tests/test_channelizer.cpp",
    },
    "rx": {
        "table": os.path.join("models", "receiver", "fir_rx_v1.json"),
        "out": os.path.join("engine", "src", "rx_taps.cpp"),
        "design": "scripts/design_rx_fir.py",
        "test": "engine/tests/test_rx_filter.cpp",
    },
}


def _f(v: float) -> str:
    """%.17g 保证 double 往返逐位相同。"""
    s = repr(float(v))
    return s if ("e" in s or "E" in s or "." in s or "inf" in s or "nan" in s) else s + ".0"


def _array(w, name: str, half: list) -> None:
    w(f"const double {name}[{len(half)}] = {{")
    for i in range(0, len(half), 4):
        w("    " + ", ".join(_f(v) for v in half[i:i + 4]) + ",")
    w("};")
    w("")


def _head(w, kind: str, rel: str, sha: str, doc: dict) -> None:
    k = _KINDS[kind]
    title = "多相 FFT 信道化的原型低通" if kind == "pfb" else "接收滤波"
    w(f"// {title}冻结系数表 —— 本文件由脚本生成，不要手改。")
    w("//")
    w(f"// 来源：{rel}（sha256 {sha}）")
    w(f"// 生成：uv run --quiet python scripts/gen_fir_taps.py --kind {kind}")
    w(f"// 设计：uv run --quiet --with scipy --with numpy python {k['design']} --write")
    w("//")
    s = doc["spec"]
    if kind == "pfb":
        w(f"// 口径（10 报告 §3.7）：临界抽取，通带 {s['passband_edge_rel_out']}·fs_out、"
          f"阻带 {s['stopband_edge_rel_out']}·fs_out ≥ {s['stopband_atten_min_dB']} dB。")
        w("// 抽头数 N = M·T+1（T 取偶数）：N 为奇数使群时延 (N-1)/2 为整数个输入样点")
        w("//（08 报告 §8 口径二），且 gd = M·T/2 是 M 的整数倍，使多相 FFT 输出的常数相位")
        w("// exp(-j2πk·gd/M) 恒为 1 —— 于是 M 路输出不需要任何逐信道的相位修正。")
        w("// 装载时镜像展开再零填充到 pad_to = M·(T+1)，让 M 条支路等长；给 FIR 补零不改变 H(ω)。")
    else:
        w(f"// 口径：不抽取，只做幅频响应与群时延。建档键是相对通带 bw_rel = bw_Hz / fs_in，")
        w(f"// 通带边 bw_rel/2、过渡带 {s['transition_rel_fs']}·fs、阻带 ≥ {s['stopband_atten_min_dB']} dB。")
        w("// 抽头数为奇数使群时延 (N-1)/2 为整数个输入样点（08 报告 §8 口径二），由封装层扣除，")
        w("// 于是输出样点 m 对应输入样点 m。")
    w("// 只存半表（含中心抽头），装载时镜像展开：等波纹设计的输出不保证逐位对称，")
    w("// 存全表会让 C++ / Python / MATLAB 三方的群时延在 1e-17 级上对不齐。")
    w("//")
    w(f"// 与 JSON 的一致性由 {k['test']} 逐位核对（铁律 10）。")
    w("")
    w('#include "cuav/dsp.h"')
    w("")
    w("namespace cuav {")
    w("namespace dsp {")
    w("namespace {")
    w("")


def gen_pfb(w, doc: dict, sha: str) -> None:
    for e in doc["entries"]:
        m = e["channels"]
        w(f"// M = {m}：{e['ntaps']} 抽头（支路 {e['taps_per_branch']}），"
          f"群时延 {e['group_delay_in']} 个输入样点（= {e['group_delay_in'] // m}·M），"
          f"阻带 {e['stopband_atten_dB']:.2f} dB")
        _array(w, f"kPfbHalf{m}", e["half"])
    w("const PfbTable kPfbTables[] = {")
    for e in doc["entries"]:
        m = e["channels"]
        w(f"    {{ {m}, {e['ntaps']}, {e['taps_per_branch']}, {e['pad_to']}, "
          f"{e['group_delay_in']}, kPfbHalf{m} }},")
    w("};")
    w("")
    w(f'const char kPfbSha256[] = "{sha}";')
    w("")
    w("}  // namespace")
    w("")
    w("const PfbTable* pfb_fir_v1(int channels) {")
    w("    for (std::size_t i = 0; i < sizeof(kPfbTables) / sizeof(kPfbTables[0]); ++i) {")
    w("        if (kPfbTables[i].channels == channels) return &kPfbTables[i];")
    w("    }")
    w("    return 0;  // 不在表里：由调用方报错并列出支持的取值，不静默顶替（铁律 15）")
    w("}")
    w("")
    w("std::size_t pfb_fir_v1_count() { return sizeof(kPfbTables) / sizeof(kPfbTables[0]); }")
    w("")
    w("const PfbTable& pfb_fir_v1_at(std::size_t i) { return kPfbTables[i]; }")
    w("")
    w("const char* pfb_fir_v1_sha256() { return kPfbSha256; }")
    w("")
    w("void pfb_fir_expand(const PfbTable& t, std::vector<double>& h) {")
    w("    // 镜像展开再零填充到 pad_to。与 scripts/design_pfb_fir.py 的 expand() 逐字同法。")
    w("    h.assign(static_cast<std::size_t>(t.pad_to), 0.0);")
    w("    const int m = (t.ntaps + 1) / 2;")
    w("    for (int k = 0; k < m; ++k) {")
    w("        h[static_cast<std::size_t>(k)] = t.half[k];")
    w("        h[static_cast<std::size_t>(t.ntaps - 1 - k)] = t.half[k];")
    w("    }")
    w("}")
    w("")


def gen_rx(w, doc: dict, sha: str) -> None:
    def tag(r: float) -> str:
        return str(int(round(r * 100)))
    for e in doc["entries"]:
        r = e["bw_rel"]
        w(f"// bw_rel = {r}：{e['ntaps']} 抽头，群时延 {e['group_delay_in']} 个输入样点，"
          f"阻带 {e['stopband_atten_dB']:.2f} dB")
        _array(w, f"kRxHalf{tag(r)}", e["half"])
    w("const RxFirTable kRxTables[] = {")
    for e in doc["entries"]:
        r = e["bw_rel"]
        w(f"    {{ {_f(r)}, {e['ntaps']}, {e['group_delay_in']}, kRxHalf{tag(r)} }},")
    w("};")
    w("")
    w(f'const char kRxSha256[] = "{sha}";')
    w("")
    w("}  // namespace")
    w("")
    w("const RxFirTable* rx_fir_v1(double bw_rel) {")
    w("    // 相对容差 1e-9：bw_rel 是 bw_Hz / fs 两个 double 相除来的，0.8 这类十进制值")
    w("    // 本来就不精确可表示。这是**表示误差的匹配容差**，不是「取最近一档」——")
    w("    // 差得更远一律查不到，由调用方报错并列出可取的值（铁律 15）。")
    w("    for (std::size_t i = 0; i < sizeof(kRxTables) / sizeof(kRxTables[0]); ++i) {")
    w("        const double t = kRxTables[i].bw_rel;")
    w("        const double d = bw_rel > t ? bw_rel - t : t - bw_rel;")
    w("        if (d <= 1e-9 * t) return &kRxTables[i];")
    w("    }")
    w("    return 0;")
    w("}")
    w("")
    w("std::size_t rx_fir_v1_count() { return sizeof(kRxTables) / sizeof(kRxTables[0]); }")
    w("")
    w("const RxFirTable& rx_fir_v1_at(std::size_t i) { return kRxTables[i]; }")
    w("")
    w("const char* rx_fir_v1_sha256() { return kRxSha256; }")
    w("")
    w("void rx_fir_expand(const RxFirTable& t, std::vector<double>& h) {")
    w("    // 镜像展开。与 scripts/design_rx_fir.py 的 expand() 逐字同法。")
    w("    h.assign(static_cast<std::size_t>(t.ntaps), 0.0);")
    w("    const int m = (t.ntaps + 1) / 2;")
    w("    for (int k = 0; k < m; ++k) {")
    w("        h[static_cast<std::size_t>(k)] = t.half[k];")
    w("        h[static_cast<std::size_t>(t.ntaps - 1 - k)] = t.half[k];")
    w("    }")
    w("}")
    w("")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="由 M-3 的冻结系数表生成 C++ 源")
    ap.add_argument("--kind", choices=sorted(_KINDS), required=True)
    ap.add_argument("--table", default=None, help="表文件，仓库相对路径；缺省按 --kind 取")
    ap.add_argument("--out", default=None, help="输出 .cpp，仓库相对路径；缺省按 --kind 取")
    a = ap.parse_args(argv)

    k = _KINDS[a.kind]
    rel = a.table or k["table"]
    out = a.out or k["out"]

    raw = open(os.path.join(_ROOT, rel), "rb").read()
    sha = hashlib.sha256(raw).hexdigest()
    doc = json.loads(raw.decode("utf-8"))

    L: list[str] = []
    w = L.append
    _head(w, a.kind, rel, sha, doc)
    (gen_pfb if a.kind == "pfb" else gen_rx)(w, doc, sha)
    w("}  // namespace dsp")
    w("}  // namespace cuav")
    w("")

    with open(os.path.join(_ROOT, out), "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))
    total = sum(len(e["half"]) for e in doc["entries"])
    print(f"写出 {out}：{len(doc['entries'])} 档、半表共 {total} 个系数、表 sha256 {sha[:16]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
