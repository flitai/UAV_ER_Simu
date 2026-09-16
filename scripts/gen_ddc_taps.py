#!/usr/bin/env python3
"""把冻结的 DDC 系数表生成成 C++ 源（06 备忘录 §9D M-2）。

真理源是 `models/adc-ddc/fir_lp_v1.json`（由 scripts/design_ddc_fir.py 设计并冻结）。
引擎不在运行时读它——系数是常量，读文件会让组件依赖部署目录布局；所以这里把它编成
`engine/src/ddc_taps.cpp`。两者是否同步由 engine/tests/test_ddc.cpp 逐位核对，
另比对表文件的 sha256，避免「改了 JSON 忘了重生成」。

用法：
    uv run --quiet python scripts/gen_ddc_taps.py

只用标准库。路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TABLE_REL = os.path.join("models", "adc-ddc", "fir_lp_v1.json")
_OUT_REL = os.path.join("engine", "src", "ddc_taps.cpp")


def _f(v: float) -> str:
    """%.17g 保证 double 往返逐位相同。"""
    s = repr(float(v))
    return s if ("e" in s or "E" in s or "." in s or "inf" in s or "nan" in s) else s + ".0"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="由冻结系数表生成 C++ 源")
    ap.add_argument("--table", default=_TABLE_REL)
    ap.add_argument("--out", default=_OUT_REL)
    a = ap.parse_args(argv)

    tpath = os.path.join(_ROOT, a.table)
    raw = open(tpath, "rb").read()
    sha = hashlib.sha256(raw).hexdigest()
    doc = json.loads(raw.decode("utf-8"))
    entries = doc["entries"]

    L: list[str] = []
    w = L.append
    w("// DDC 抗混叠低通的冻结系数表 —— 本文件由脚本生成，不要手改。")
    w("//")
    w(f"// 来源：{a.table}（sha256 {sha}）")
    w("// 生成：uv run --quiet python scripts/gen_ddc_taps.py")
    w("// 设计：uv run --quiet --with scipy --with numpy python scripts/design_ddc_fir.py --write")
    w("//")
    w(f"// 口径（10 报告 §3.6）：通带 {doc['spec']['passband_edge_rel_out']}·fs_out、"
      f"阻带 {doc['spec']['stopband_edge_rel_out']}·fs_out ≥ {doc['spec']['stopband_atten_min_dB']} dB，")
    w("// 抽头数为奇数使群时延 (N-1)/2 为整数个输入样点（08 报告 §8 口径二）。")
    w("// 只存半表（含中心抽头），装载时镜像展开：等波纹设计的输出不保证逐位对称，")
    w("// 存全表会让 C++ / Python / MATLAB 三方的群时延在 1e-17 级上对不齐。")
    w("//")
    w("// 与 JSON 的一致性由 engine/tests/test_ddc.cpp 逐位核对（铁律 10）。")
    w("")
    w('#include "cuav/dsp.h"')
    w("")
    w("namespace cuav {")
    w("namespace dsp {")
    w("namespace {")
    w("")
    for e in entries:
        d, n = e["decim"], e["ntaps"]
        half = e["half"]
        at = e["stopband_atten_dB"]
        at_txt = "—" if at is None else f"{at:.2f} dB"
        w(f"// D = {d}：{n} 抽头，群时延 {e['group_delay_in']} 个输入样点，阻带 {at_txt}")
        w(f"const double kHalf{d}[{len(half)}] = {{")
        for i in range(0, len(half), 4):
            chunk = ", ".join(_f(v) for v in half[i:i + 4])
            w(f"    {chunk},")
        w("};")
        w("")
    w("const FirTable kTables[] = {")
    for e in entries:
        d = e["decim"]
        w(f"    {{ {d}, {e['ntaps']}, {e['group_delay_in']}, kHalf{d} }},")
    w("};")
    w("")
    w(f'const char kTableSha256[] = "{sha}";')
    w("")
    w("}  // namespace")
    w("")
    w("const FirTable* ddc_fir_lp_v1(int decim) {")
    w("    for (std::size_t i = 0; i < sizeof(kTables) / sizeof(kTables[0]); ++i) {")
    w("        if (kTables[i].decim == decim) return &kTables[i];")
    w("    }")
    w("    return 0;  // 不在表里：由调用方报错并列出支持的取值，不静默顶替（铁律 15）")
    w("}")
    w("")
    w("std::size_t ddc_fir_lp_v1_count() { return sizeof(kTables) / sizeof(kTables[0]); }")
    w("")
    w("const FirTable& ddc_fir_lp_v1_at(std::size_t i) { return kTables[i]; }")
    w("")
    w("const char* ddc_fir_lp_v1_sha256() { return kTableSha256; }")
    w("")
    w("void ddc_fir_expand(const FirTable& t, std::vector<double>& h) {")
    w("    // 镜像展开。与 scripts/design_ddc_fir.py 的 expand() 逐字同法。")
    w("    h.assign(static_cast<std::size_t>(t.ntaps), 0.0);")
    w("    const int m = (t.ntaps + 1) / 2;")
    w("    for (int k = 0; k < m; ++k) {")
    w("        h[static_cast<std::size_t>(k)] = t.half[k];")
    w("        h[static_cast<std::size_t>(t.ntaps - 1 - k)] = t.half[k];")
    w("    }")
    w("}")
    w("")
    w("}  // namespace dsp")
    w("}  // namespace cuav")
    w("")

    opath = os.path.join(_ROOT, a.out)
    with open(opath, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))
    total = sum(len(e["half"]) for e in entries)
    print(f"写出 {a.out}：{len(entries)} 档、半表共 {total} 个系数、表 sha256 {sha[:16]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
