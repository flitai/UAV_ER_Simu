"""deploy/pack.py 的单测（W-2，D-099）。只读 git 里的文件与临时目录里的合成夹具，不读不入 git 的大数据。

钉住的是组包脚本自己的规矩：引擎必须出自当前提交、DEM 与清单逐块核对、实测子集按写死的规则来、
批索引裁剪后各计数自洽、出包前那几道检查真能拦住、同一输入两次出包逐字节相同。

运行：uv run --quiet python -m unittest tests/unit/test_pack.py
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "deploy"))

import pack  # noqa: E402


def stage_with(tmp: Path, files: dict[str, bytes]) -> pack.Stage:
    st = pack.Stage(tmp / "stage")
    st.root.mkdir(parents=True)
    for rel, data in files.items():
        st.put_bytes(data, rel)
    return st


GOOD_BAT = b"@echo off\r\nrem ok\r\n"


class SubsetAndIndexTest(unittest.TestCase):
    def test_committed_subset_matches_rule(self):
        """入库的子集清单必须就是规则算出来的那一份：改规则或改数据而不重新生成，这里就红。"""
        committed = json.loads((pack.ROOT / pack.SUBSET_LIST).read_text(encoding="utf-8"))
        self.assertEqual(committed, pack.subset_rule())

    def test_subset_excludes_validation_set(self):
        doc = pack.subset_rule()
        self.assertEqual(doc["in_validation_set"], [])
        holdout = {r["data_id"] for r in json.loads((pack.ROOT / pack.HOLDOUT).read_text(encoding="utf-8"))["holdout"]}
        self.assertFalse({r["data_id"] for r in doc["products"]} & holdout)
        # 每个类别一段，类别互不重复
        codes = [r["class_code"] for r in doc["products"]]
        self.assertEqual(len(codes), len(set(codes)))

    def test_trimmed_index_counts(self):
        ids = ["dronerfb_0_CH0_S4", "dronerfb_1036_CH0_S4"]
        idx = json.loads(pack.trimmed_index(ids))
        self.assertEqual([p["data_id"] for p in idx["products"]], ids)
        self.assertEqual(idx["product_count"], 2)
        self.assertEqual(sum(idx["datasets"].values()), 2)
        self.assertEqual(sum(idx["quality_distribution"].values()), 2)
        for v in idx["calibration"].values():
            self.assertEqual(v["product_count"], 2)
        raw = (pack.ROOT / pack.IQ_INDEX).read_bytes()
        self.assertEqual(idx["subset_of"]["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertGreater(idx["subset_of"]["product_count"], 2)

    def test_trimmed_index_unknown_id(self):
        with self.assertRaises(pack.PackError):
            pack.trimmed_index(["dronerfb_does_not_exist"])


class PackageSourcesTest(unittest.TestCase):
    def test_sources_cover_what_goes_in(self):
        """进包的东西都要在「未提交改动即拒」的范围里：漏一个，包里就可能混进没提交的改动。"""
        for path in ("deploy/windows/start.bat", "server/src/index.ts", "web/src", "models/recognition",
                     "engine/CMakeLists.txt", "data/scene", pack.SUBSET_LIST, pack.IQ_INDEX, "THIRD-PARTY-NOTICES",
                     "tests/regression/diagrams/chain-replay.json"):
            self.assertTrue(any(path == s or path.startswith(s + "/") for s in pack.PACKAGE_SOURCES), path)
        for path in ("scripts/gen_eval_dataset.py", "WORKLOG.md", "algos/reference/realism_report.py"):
            self.assertFalse(any(path == s or path.startswith(s + "/") for s in pack.PACKAGE_SOURCES), path)


class EngineSourceTest(unittest.TestCase):
    def _artifact(self, d: Path, commit: str, exe: bytes = b"MZfake", sha: str | None = None) -> None:
        (d / "cuav_run.exe").write_bytes(exe)
        (d / "cuav_run.build.json").write_text(json.dumps({
            "sha256": sha or hashlib.sha256(exe).hexdigest(), "commit": commit,
        }), encoding="utf-8")

    def test_accepts_matching_commit(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            self._artifact(d, "a" * 40)
            exe, rec = pack.engine_from_dir(d, "a" * 40)
            self.assertEqual(exe.name, "cuav_run.exe")
            self.assertEqual(rec["commit"], "a" * 40)

    def test_other_commit_judged_by_engine_sources(self):
        """引擎出自的提交 ≠ HEAD：其间只改了报告与脚本就照用，编进引擎的源动过就拒，提交找不到也拒。"""
        import subprocess
        with tempfile.TemporaryDirectory() as t:
            repo = Path(t) / "repo"
            (repo / "engine").mkdir(parents=True)
            (repo / "scripts").mkdir()

            def commit(rel: str, text: str) -> str:
                (repo / rel).write_text(text, encoding="utf-8")
                for cmd in (["add", rel], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", rel]):
                    subprocess.run(["git", *cmd], cwd=repo, check=True, capture_output=True)
                return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True,
                                      capture_output=True, text=True).stdout.strip()

            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            c1 = commit("engine/a.cpp", "1")
            c2 = commit("scripts/x.py", "2")      # 只动了脚本
            c3 = commit("engine/a.cpp", "3")      # 动了引擎源
            art = Path(t) / "art"
            art.mkdir()
            self._artifact(art, c1)
            old = pack.ROOT
            pack.ROOT = repo
            try:
                exe, rec = pack.engine_from_dir(art, c2)
                self.assertEqual(rec["commit"], c1)
                with self.assertRaisesRegex(pack.PackError, "engine/a.cpp"):
                    pack.engine_from_dir(art, c3)
                self._artifact(art, "f" * 40)
                with self.assertRaisesRegex(pack.PackError, "找不到"):
                    pack.engine_from_dir(art, c3)
            finally:
                pack.ROOT = old

    def test_rejects_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            self._artifact(d, "a" * 40, sha="0" * 64)
            with self.assertRaisesRegex(pack.PackError, "sha256"):
                pack.engine_from_dir(d, "a" * 40)


class DemCheckTest(unittest.TestCase):
    def test_dem_index_hash(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            tiles = {(0, 0, 0): b"a", (1, 1, 0): b"bb", (1, 0, 1): b"ccc", (10, 2, 3): b"d"}
            for (z, x, y), data in tiles.items():
                p = root / "dem" / str(z) / str(x) / f"{y}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
            # 与 scene/build_regional_basemap.py 同一口径：按 (z, x, y) 数值顺序逐行 `z/x/y <sha256>`
            h = hashlib.sha256()
            for (z, x, y) in sorted(tiles):
                h.update(f"{z}/{x}/{y} {hashlib.sha256(tiles[(z, x, y)]).hexdigest()}\n".encode())
            old = pack.ROOT
            pack.ROOT = root
            try:
                got = pack.check_dem("dem", {"tiles": 4, "index_sha256": h.hexdigest()})
                self.assertEqual(len(got), 4)
                (root / "dem" / "0" / "0" / "0.png").write_bytes(b"changed")
                with self.assertRaises(pack.PackError):
                    pack.check_dem("dem", {"tiles": 4, "index_sha256": h.hexdigest()})
            finally:
                pack.ROOT = old


class StageCheckTest(unittest.TestCase):
    def test_clean_stage_passes(self):
        with tempfile.TemporaryDirectory() as t:
            st = stage_with(Path(t), {"start.bat": GOOD_BAT, "web/dist/a.js": b"var x='/usr/lib';"})
            pack.check_stage(st)

    def test_machine_path_caught(self):
        for text in (b"see /Users/someone/file", b"at /home/runner/x", b'"C:\\Users\\me\\x"'):
            with tempfile.TemporaryDirectory() as t:
                st = stage_with(Path(t), {"start.bat": GOOD_BAT, "web/dist/vendor/NOTE.md": text})
                with self.assertRaisesRegex(pack.PackError, "机器路径"):
                    pack.check_stage(st)

    def test_non_ascii_or_space_name_caught(self):
        for name in ("data/中文.json", "data/a b.json"):
            with tempfile.TemporaryDirectory() as t:
                st = stage_with(Path(t), {"start.bat": GOOD_BAT, name: b"{}"})
                with self.assertRaisesRegex(pack.PackError, "ASCII"):
                    pack.check_stage(st)

    def test_bat_must_be_ascii_crlf(self):
        for bat in (b"@echo off\nrem lf only\n", "rem 中文\r\n".encode("utf-8"), b"@echo off\r\nrem no final newline"):
            with tempfile.TemporaryDirectory() as t:
                st = stage_with(Path(t), {"start.bat": bat})
                with self.assertRaises(pack.PackError):
                    pack.check_stage(st)

    def test_committed_bat_passes(self):
        with tempfile.TemporaryDirectory() as t:
            st = stage_with(Path(t), {"start.bat": (pack.DEPLOY / "windows" / "start.bat").read_bytes()})
            pack.check_stage(st)

    def test_duplicate_path_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            st = stage_with(Path(t), {"a.txt": b"1"})
            with self.assertRaises(pack.PackError):
                st.put_bytes(b"2", "a.txt")


class ZipAndReadmeTest(unittest.TestCase):
    def test_zip_is_deterministic(self):
        when = dt.datetime(2026, 10, 10, 6, 0, 0, tzinfo=dt.timezone.utc)
        files = {"start.bat": GOOD_BAT, "bin/cuav_run.exe": b"MZ" + bytes(range(256)) * 50,
                 "data/basemap/x.pmtiles": os.urandom(4096), "README.txt": "说明".encode("utf-8")}
        digests = []
        with tempfile.TemporaryDirectory() as t:
            for i in range(2):
                st = stage_with(Path(t) / str(i), files)
                st.mkdir("data/runs")
                out = Path(t) / f"out{i}"
                out.mkdir()
                z = pack.write_zip(st, "pkg", when, out)
                digests.append(hashlib.sha256(z.read_bytes()).hexdigest())
                with zipfile.ZipFile(z) as zf:
                    names = zf.namelist()
                    self.assertEqual(names, sorted(names))
                    self.assertTrue(all(n.startswith("pkg/") for n in names))
                    self.assertIn("pkg/data/runs/", names)
                    self.assertEqual(zf.getinfo("pkg/data/basemap/x.pmtiles").compress_type, zipfile.ZIP_STORED)
                    self.assertEqual(zf.read("pkg/bin/cuav_run.exe"), files["bin/cuav_run.exe"])
        self.assertEqual(digests[0], digests[1])

    def test_readme_has_bom_crlf_and_version(self):
        data = pack.render_readme("cuav-demo-20261010-abcdef0-win-x64", "abcdef0123456789")
        self.assertTrue(data.startswith(b"\xef\xbb\xbf"))
        text = data.decode("utf-8-sig")
        self.assertIn("cuav-demo-20261010-abcdef0-win-x64", text)
        self.assertIn("abcdef012345", text)
        self.assertNotIn("{version}", text)
        self.assertEqual(text.count("\n"), text.count("\r\n"))
        for word in ("录音", "验收集", "分子带"):   # D-095、D-097、D-098 的旧称不得出现在交付文字里
            self.assertNotIn(word, text)


if __name__ == "__main__":
    unittest.main()
