"""deploy/pe_imports.py 的单测：在内存里拼最小的 PE32+ 映像，不依赖真的 exe（W-2，D-099）。

真的 `cuav_run.exe` 只在 Windows CI 上有，那里另跑一次 `--forbid`。这里钉住的是读表本身：
导入表与延迟导入表都要读到、大小写去重、遇到 VC++ 运行库要拒。

运行：uv run --quiet python -m unittest tests/unit/test_pe_imports.py
"""
from __future__ import annotations

import contextlib
import io
import os
import struct
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "deploy"))

import pe_imports  # noqa: E402

SECTION_RVA = 0x1000
SECTION_OFF = 0x200


def build_pe(imports: list[str], delay: list[str], magic: int = 0x20B) -> bytes:
    """拼一个只有一个节的 PE 映像，节里放导入描述符、延迟导入描述符与 DLL 名。"""
    body = bytearray()
    imp_rva = SECTION_RVA
    n_imp = len(imports) + 1
    delay_rva = imp_rva + 20 * n_imp
    n_delay = len(delay) + 1
    str_rva = delay_rva + 32 * n_delay
    strings = bytearray()
    name_rvas = []
    for name in imports + delay:
        name_rvas.append(str_rva + len(strings))
        strings += name.encode("ascii") + b"\0"
    for i in range(len(imports)):
        body += struct.pack("<IIIII", 0, 0, 0, name_rvas[i], 0)
    body += b"\0" * 20
    for i in range(len(delay)):
        body += struct.pack("<IIIIIIII", 1, name_rvas[len(imports) + i], 0, 0, 0, 0, 0, 0)
    body += b"\0" * 32
    body += strings

    opt_size = 240 if magic == 0x20B else 224
    n_dirs_off, dirs_off = (108, 112) if magic == 0x20B else (92, 96)
    opt = bytearray(opt_size)
    struct.pack_into("<H", opt, 0, magic)
    struct.pack_into("<I", opt, n_dirs_off, 16)
    if imports:
        struct.pack_into("<II", opt, dirs_off + 8 * 1, imp_rva, 20 * n_imp)
    if delay:
        struct.pack_into("<II", opt, dirs_off + 8 * 13, delay_rva, 32 * n_delay)

    head = bytearray(0x40)
    head[0:2] = b"MZ"
    struct.pack_into("<I", head, 0x3C, 0x40)
    head += b"PE\0\0"
    head += struct.pack("<HHIIIHH", 0x8664, 1, 0, 0, 0, opt_size, 0x22)
    head += opt
    section = bytearray(40)
    section[0:6] = b".idata"
    struct.pack_into("<IIII", section, 8, len(body), SECTION_RVA, len(body), SECTION_OFF)
    head += section
    assert len(head) <= SECTION_OFF
    head += b"\0" * (SECTION_OFF - len(head))
    return bytes(head + body)


class PeImportsTest(unittest.TestCase):
    def test_reads_import_and_delay_tables(self):
        data = build_pe(["KERNEL32.dll", "ADVAPI32.dll"], ["SHELL32.dll"])
        self.assertEqual(pe_imports.imported_dlls(data),
                         ["KERNEL32.dll", "ADVAPI32.dll", "SHELL32.dll"])

    def test_pe32_also_read(self):
        data = build_pe(["KERNEL32.dll"], [], magic=0x10B)
        self.assertEqual(pe_imports.imported_dlls(data), ["KERNEL32.dll"])

    def test_case_insensitive_dedup(self):
        data = build_pe(["KERNEL32.dll"], ["kernel32.DLL"])
        self.assertEqual(pe_imports.imported_dlls(data), ["KERNEL32.dll"])

    def test_forbidden_runtime(self):
        dlls = ["KERNEL32.dll", "VCRUNTIME140.dll", "MSVCP140.dll",
                "api-ms-win-crt-runtime-l1-1-0.dll", "VCRUNTIME140_1.dll"]
        self.assertEqual(pe_imports.forbidden(dlls), dlls[1:])
        self.assertEqual(pe_imports.forbidden(["KERNEL32.dll", "WS2_32.dll"]), [])

    def test_main_forbid_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            ok = os.path.join(d, "ok.exe")
            bad = os.path.join(d, "bad.exe")
            with open(ok, "wb") as f:
                f.write(build_pe(["KERNEL32.dll"], []))
            with open(bad, "wb") as f:
                f.write(build_pe(["KERNEL32.dll", "VCRUNTIME140.dll"], []))
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(pe_imports.main(["--forbid", ok]), 0)
                self.assertEqual(pe_imports.main(["--forbid", bad]), 1)

    def test_not_a_pe(self):
        with self.assertRaises(pe_imports.PeError):
            pe_imports.imported_dlls(b"\x7fELF" + b"\0" * 100)


if __name__ == "__main__":
    unittest.main()
