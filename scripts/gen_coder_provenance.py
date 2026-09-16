#!/usr/bin/env python3
"""给 Coder 产物补齐哈希，并编成 C++ 溯源串（06 备忘录 §9D M-3；08 报告 §13 第 4 条）。

08 §13 要求 Coder 产物的组件把 `implementation` 置为 `coder`、`source_ref` **必填**，
且必须含来源 `.m` 的路径、MATLAB 与 Coder 的版本、codegen 参数哈希；目录导出时校验，
缺失即拒绝（`engine/src/catalog.cpp:65-69`，那条闸从 B-1 起就在等 M-3）。

引擎不能在 `describe()` 时读文件（组件不该依赖部署目录布局，同 ddc_taps.cpp 的道理），
所以这里把溯源串**编进** `engine/src/coder_provenance.cpp`。

分工：`matlab/coder/build_coder.m` 写下它知道的事（版本、配置、入口与参数形状），
本脚本补它算不了的事（各文件的 sha256、配置与参数的规范化哈希）——哈希在 Python 侧算，
标准库就够，而且 CI 不装 MATLAB 也能重新核对。

用法：
    uv run --quiet python scripts/gen_coder_provenance.py            # 补哈希 + 生成 .cpp
    uv run --quiet python scripts/gen_coder_provenance.py --verify   # 只核对，不写（CI / 提交前）

只用标准库。路径从本文件位置推导（铁律 17）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 入库的产物只有这几类；其余（interface/、*.mat、*.mk 等）不入库，理由见 matlab/coder/README.md
_SRC_EXT = (".c", ".h")

_KINDS = {
    "pfb": {"dir": os.path.join("models", "channelizer", "coder"), "label": "Channelizer"},
    "rx": {"dir": os.path.join("models", "receiver", "coder"), "label": "RxFilter"},
}
_OUT_REL = os.path.join("engine", "src", "coder_provenance.cpp")


def _sha(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _entries(doc: dict) -> list:
    """MATLAB 的 jsonencode 会把只有一个元素的结构体数组塌成对象，这里统一成列表。"""
    e = doc.get("entry_points", [])
    return e if isinstance(e, list) else [e]


def _shared(doc: dict) -> list:
    s = doc.get("shared_m", [])
    if isinstance(s, str):
        return [s]
    return list(s)


def _canon(o) -> str:
    """规范化序列化：键排序、无空格。配置与参数的哈希对它算，于是与生成日期、机器无关。"""
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def collect(kind: str) -> dict:
    k = _KINDS[kind]
    d = os.path.join(_ROOT, k["dir"])
    pjson = os.path.join(d, "PROVENANCE.json")
    if not os.path.exists(pjson):
        raise SystemExit(f"缺 {k['dir']}/PROVENANCE.json：先跑 MATLAB_ROOT=<安装目录> sh matlab/run_matlab.sh")
    doc = json.load(open(pjson, encoding="utf-8"))

    srcs = [e["source_m"] for e in _entries(doc)] + _shared(doc)
    src_hashes = {}
    for rel in sorted(set(srcs)):
        p = os.path.join(_ROOT, rel)
        if not os.path.exists(p):
            raise SystemExit(f"溯源里记的来源 .m 不存在：{rel}")
        src_hashes[rel] = _sha(p)

    files = sorted(f for f in os.listdir(d) if f.endswith(_SRC_EXT))
    file_hashes = {f: _sha(os.path.join(d, f)) for f in files}

    # codegen 参数哈希 = 配置 + 每个入口的参数形状，规范化后一次 sha256。
    # 与生成时间、机器、目录都无关；改了任何一项配置或接口尺寸，它才变。
    args_hash = hashlib.sha256(_canon({
        "config": doc["config"],
        "entries": [{"name": e["name"], "args": e["args"]} for e in _entries(doc)],
    }).encode("utf-8")).hexdigest()

    return {
        "kind": kind,
        "label": k["label"],
        "dir": k["dir"].replace(os.sep, "/"),
        "matlab_version": doc["matlab_version"],
        "coder_version": doc["coder_version"],
        "sources": src_hashes,
        "files": file_hashes,
        "args_sha256": args_hash,
    }


def sources_sha256(info: dict) -> str:
    """来源 .m 的集合哈希：任何一份 .m 变了它就变，与文件个数、顺序无关。"""
    return hashlib.sha256(_canon(info["sources"]).encode("utf-8")).hexdigest()


def source_ref(info: dict) -> str:
    """组件 describe() 里 source_ref 的取值。一行装下 08 §13 第 4 条要的四件事：
    来源 .m 的路径、MATLAB 与 Coder 的版本、codegen 参数哈希，外加产物目录。

    六个 cuav_pfb_mN.m 只是把 M 钉死、算法全在 cuav_pfb_cycle.m 里，所以列文件名而不是
    逐个列哈希——逐个列会让这一行长到没法看，而防篡改由**集合哈希**兜住，一份变了就变。"""
    rels = sorted(info["sources"])
    base = os.path.commonpath([r.replace("/", os.sep) for r in rels]).replace(os.sep, "/") \
        if len(rels) > 1 else os.path.dirname(rels[0])
    names = ", ".join(os.path.basename(r) for r in rels)
    return (f"{base}/{{{names}}}｜来源集 sha256 {sources_sha256(info)[:16]}"
            f"｜MATLAB {info['matlab_version']}｜Coder {info['coder_version']}"
            f"｜codegen 参数 sha256 {info['args_sha256'][:16]}｜{info['dir']}/")


def render(infos: list) -> str:
    L: list[str] = []
    w = L.append
    w("// Coder 产物的溯源串 —— 本文件由脚本生成，不要手改。")
    w("//")
    w("// 生成：uv run --quiet python scripts/gen_coder_provenance.py")
    w("// 核对：uv run --quiet python scripts/gen_coder_provenance.py --verify")
    w("//")
    w("// 08 报告 §13 第 4 条：Coder 产物的组件把 implementation 置为 coder、source_ref 必填，")
    w("// 须含来源 .m 的路径、MATLAB 与 Coder 的版本、codegen 参数哈希；目录导出时校验，")
    w("// 缺失即拒绝（engine/src/catalog.cpp:65-69）。引擎不在 describe() 时读文件，故编进来。")
    w("//")
    w("// 产物文件的 sha256 也编进来：单测据此核对「入库的 .c 与生成它的那一次是同一份」，")
    w("// 「手改了生成物」或「改了 .m 忘了重生成」都会当场红（铁律 10）。")
    w("")
    w('#include "cuav/coder_provenance.h"')
    w("")
    w("namespace cuav {")
    w("namespace coder_provenance {")
    w("")
    for info in infos:
        k = info["kind"]
        w(f"// {info['label']}：{info['dir']}/")
        w(f"const char* {k}_source_ref() {{")
        w(f'    return "{source_ref(info)}";')
        w("}")
        w("")
        w(f"const char* {k}_args_sha256() {{ return \"{info['args_sha256']}\"; }}")
        w("")
        w("namespace {")
        w(f"const FileHash k_{k}_files[] = {{")
        for f, h in sorted(info["files"].items()):
            w(f'    {{ "{f}", "{h}" }},')
        w("};")
        w("}  // namespace")
        w("")
        w(f"std::size_t {k}_file_count() {{ return sizeof(k_{k}_files) / sizeof(k_{k}_files[0]); }}")
        w(f"const FileHash& {k}_file_at(std::size_t i) {{ return k_{k}_files[i]; }}")
        w("")
    w("}  // namespace coder_provenance")
    w("}  // namespace cuav")
    w("")
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="给 Coder 产物补齐哈希并生成 C++ 溯源串")
    ap.add_argument("--verify", action="store_true",
                    help="只核对入库的 .cpp 与当前产物是否一致，不写文件")
    a = ap.parse_args(argv)

    infos = [collect(k) for k in ("pfb", "rx")]
    text = render(infos)
    out = os.path.join(_ROOT, _OUT_REL)

    if a.verify:
        if not os.path.exists(out):
            print(f"缺 {_OUT_REL}：先跑一次不带 --verify 的", file=sys.stderr)
            return 2
        cur = open(out, encoding="utf-8").read()
        if cur != text:
            print(f"{_OUT_REL} 与当前 Coder 产物对不上：产物改过而溯源没重生成，"
                  f"或反过来。跑 uv run --quiet python scripts/gen_coder_provenance.py", file=sys.stderr)
            return 1
        print(f"溯源核对通过：{_OUT_REL} 与 {sum(len(i['files']) for i in infos)} 个产物文件一致")
        return 0

    with open(out, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"写出 {_OUT_REL}")
    for info in infos:
        print(f"  {info['label']}：{len(info['files'])} 个产物文件、"
              f"{len(info['sources'])} 份来源 .m、codegen 参数 sha256 {info['args_sha256'][:16]}…")
        print(f"    source_ref = {source_ref(info)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
