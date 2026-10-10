#!/usr/bin/env python3
"""列出 Windows 可执行文件（PE）依赖的 DLL，并可拒绝 VC++ 运行库（W-2，D-099）。

为什么要这一道检查：`cuav_run.exe` 随单机包交给一台干净的 Windows 机。CMake 对 MSVC 的缺省是
动态运行库（/MD），那样编出来的程序要 `VCRUNTIME140.dll`、`MSVCP140.dll` 与一串
`api-ms-win-crt-*.dll`，没装 VC++ 运行库的机器上双击即报「找不到 DLL」。引擎 CMake 已改成静态链接
（/MT），这里读导入表把这件事钉住：哪天有人把那一行删了，CI 当场红，而不是等到演示机上才发现。

只用标准库，开发机（macOS）与 CI（Windows、Linux）都能跑；不依赖 dumpbin（要先进 VS 开发者环境）。
读的是导入表与延迟导入表两张表，二者都会让加载器去找 DLL。

用法：
    python deploy/pe_imports.py <exe>             列出依赖的 DLL，每行一个
    python deploy/pe_imports.py --forbid <exe>    同上；见到 VC++ 运行库即退出码 1
"""
from __future__ import annotations

import argparse
import fnmatch
import struct
import sys

# 静态链接（/MT）之后不该再出现的 DLL。不区分大小写。
#   vcruntime* / msvcp* / concrt* / vcomp*：VC++ 运行库各件（vcomp 是 OpenMP）
#   ucrtbase* / api-ms-win-crt-*：通用 C 运行库（UCRT）。Win10 起系统自带，但 /MT 下本就不该依赖它，
#   出现就说明某个目标漏了 /MT。
FORBIDDEN = (
    "vcruntime*.dll",
    "msvcp*.dll",
    "concrt*.dll",
    "vcomp*.dll",
    "ucrtbase*.dll",
    "api-ms-win-crt-*.dll",
)


class PeError(ValueError):
    """文件不是能读的 PE 映像。"""


def _u16(b: bytes, off: int) -> int:
    return struct.unpack_from("<H", b, off)[0]


def _u32(b: bytes, off: int) -> int:
    return struct.unpack_from("<I", b, off)[0]


def _cstr(b: bytes, off: int) -> str:
    end = b.find(b"\0", off)
    if end < 0:
        raise PeError(f"字符串在偏移 {off} 处没有结束符")
    return b[off:end].decode("ascii")


def imported_dlls(data: bytes) -> list[str]:
    """返回导入表与延迟导入表里的 DLL 名，按出现顺序、去重。"""
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise PeError("不是 PE 文件（缺 MZ 头）")
    pe = _u32(data, 0x3C)
    if data[pe:pe + 4] != b"PE\0\0":
        raise PeError("不是 PE 文件（缺 PE 签名）")
    coff = pe + 4
    n_sections = _u16(data, coff + 2)
    opt_size = _u16(data, coff + 16)
    opt = coff + 20
    magic = _u16(data, opt)
    if magic == 0x20B:        # PE32+（64 位）
        n_dirs_off, dirs_off = opt + 108, opt + 112
    elif magic == 0x10B:      # PE32（32 位）
        n_dirs_off, dirs_off = opt + 92, opt + 96
    else:
        raise PeError(f"不认识的可选头标识 0x{magic:x}")
    n_dirs = _u32(data, n_dirs_off)

    sections = []
    sec = opt + opt_size
    for i in range(n_sections):
        s = sec + 40 * i
        vsize, va, rawsize, rawptr = struct.unpack_from("<IIII", data, s + 8)
        sections.append((va, max(vsize, rawsize), rawptr))

    def rva_to_off(rva: int) -> int:
        for va, size, rawptr in sections:
            if va <= rva < va + size:
                return rva - va + rawptr
        raise PeError(f"相对虚拟地址 0x{rva:x} 不落在任何节里")

    def directory(index: int) -> tuple[int, int]:
        if index >= n_dirs:
            return 0, 0
        return struct.unpack_from("<II", data, dirs_off + 8 * index)

    names: list[str] = []

    rva, size = directory(1)            # 导入表：每项 20 字节，Name 在第 12 字节
    if rva and size:
        off = rva_to_off(rva)
        while True:
            desc = data[off:off + 20]
            if len(desc) < 20 or desc == b"\0" * 20:
                break
            names.append(_cstr(data, rva_to_off(_u32(desc, 12))))
            off += 20

    rva, size = directory(13)           # 延迟导入表：每项 32 字节，DllNameRVA 在第 4 字节
    if rva and size:
        off = rva_to_off(rva)
        while True:
            desc = data[off:off + 32]
            if len(desc) < 32 or desc == b"\0" * 32:
                break
            names.append(_cstr(data, rva_to_off(_u32(desc, 4))))
            off += 32

    seen: set[str] = set()
    out = []
    for n in names:
        if n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def forbidden(dlls: list[str]) -> list[str]:
    return [d for d in dlls if any(fnmatch.fnmatch(d.lower(), p) for p in FORBIDDEN)]


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):   # Windows 上接到管道时缺省不是 UTF-8，中文报文会抛异常
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="列出 PE 文件依赖的 DLL")
    ap.add_argument("exe")
    ap.add_argument("--forbid", action="store_true",
                    help="见到 VC++ 运行库或通用 C 运行库的 DLL 即退出码 1")
    a = ap.parse_args(argv)
    with open(a.exe, "rb") as f:
        dlls = imported_dlls(f.read())
    for d in dlls:
        print(d)
    if a.forbid:
        bad = forbidden(dlls)
        if bad:
            print(f"依赖了 VC++ 运行库（应静态链接 /MT）：{', '.join(bad)}", file=sys.stderr)
            return 1
        print(f"未依赖 VC++ 运行库（共 {len(dlls)} 个 DLL）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
