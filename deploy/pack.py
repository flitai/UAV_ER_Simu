#!/usr/bin/env python3
"""单机包组包脚本（W-2，D-099）。只用标准库，开发机（macOS）与 Windows CI 都能跑。

包的根目录与仓库同构：服务按 server/dist/../.. 找根，引擎子进程的工作目录就是根，参数全是相对路径
（D-042 ②）。所以包里每个文件都放在它在仓库里的位置，另加启动器、便携 Node 与引擎二进制。

两种范围：
  program  只取 git 里的文件（程序、模型、场景文件、清单），不取盘上的大文件。CI 用它在 Windows 上冒烟。
  full     再加盘上数据：建筑集、北京区域底图与 DEM、全球概览底图、实测片段子集。交付用。

两个目标平台（--target，D-111）：
  win-x64    Windows 包：Electron 外壳 app/CuavDemo.exe 作主入口，start.bat + 便携 Node 作备用。
  mac-arm64  Mac 包（只能在 Mac 上组：要 ditto 解压保留符号链接、codesign 重新签名）：
             CuavDemo.app 作主入口，start.command 作备用（用 Electron 自带的 Node 起服务）。
  --no-electron 不带外壳（调试用；交付包都带）。

引擎有四种来源：
  --engine-ci <运行号>  从 GitHub Actions 取 cuav_run-<目标> 产物（调 gh run download）。交付用这一种。
  --engine <目录>       已经下载好的同一个产物目录（含 cuav_run[.exe] 与 cuav_run.build.json）。CI 用。
  --engine-local        本机编出的引擎：Windows 上是 MSVC 编出的 engine/build/Release/cuav_run.exe，
                        Mac 上是按最低系统 13.0 单独编的 engine/build-mac/cuav_run。证不了它出自哪个提交，
                        清单写 source.kind = local、deliverable: false，供本机自用，不作交付。
  --host                用本机开发引擎 engine/build/cuav_run、不带便携 Node 与外壳。**只用于在开发机上验证数据是全的**，
                        包名带 -host、清单写 deliverable: false，不交付。
前两种都读 cuav_run.build.json：其中的提交与当前 HEAD 不同即拒——包里的每个文件都出自同一个提交。

用法：
  python deploy/pack.py subset                         按规则生成 deploy/iq-subset.json（审阅后提交）
  python deploy/pack.py build --scope full --engine-ci <运行号> --zip
  python deploy/pack.py build --target mac-arm64 --scope full --engine-ci <运行号> --zip
  python deploy/pack.py build --scope program --engine <目录> --skip-build
  python deploy/pack.py build --scope full --host
  python deploy/pack.py build --scope full --engine-local --skip-build --zip     （Windows，本机编译的引擎）
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import plistlib
import re
import stat
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy"
CACHE = DEPLOY / ".cache"

NODE_VERSION = "v22.23.3"   # LTS（Jod），2026-09-23 发布；与 CI 同一大版本（D-084）
NODE_ZIP = f"node-{NODE_VERSION}-win-x64.zip"
NODE_ZIP_SHA256 = "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71"   # 官方 SHASUMS256.txt
NODE_URL = f"https://nodejs.org/dist/{NODE_VERSION}/{NODE_ZIP}"

TARGETS = ("win-x64", "mac-arm64")
ENGINE_ARTIFACT = {"win-x64": "cuav_run-win-x64", "mac-arm64": "cuav_run-mac-arm64"}
ENGINE_EXE = {"win-x64": "cuav_run.exe", "mac-arm64": "cuav_run"}
MAC_MIN_OS = "13.0"          # 与 Electron 44 的最低系统相同；CI 的 macOS 引擎按它编

# Electron 外壳（D-111）。2026-10-13 发布；Node 24.21、Chromium 152。sha256 取自官方 SHASUMS256.txt
ELECTRON_VERSION = "v44.7.1"
ELECTRON_ZIP = {
    "win-x64": ("electron-v44.7.1-win32-x64.zip", "ace7ce1580d33e9fe7284823d7e23ba687263c448d85d8dc4b5daa9bba73f97a"),
    "mac-arm64": ("electron-v44.7.1-darwin-arm64.zip", "747dfcb4fb57c635f3c5009fda329b9e6f9c84d0d37800b40c2b2b9eb7e2e571"),
}
ELECTRON_URL = "https://github.com/electron/electron/releases/download/{v}/{z}"
SHELL_TITLE = "无人机电子信号侦察仿真系统"
MAC_APP = "CuavDemo.app"
WIN_APP_DIR = "app"
WS_VERSION = "8.21.3"

AOI = "beijing-yayuncun"
SCENE = f"data/scene/{AOI}"
IQ_BATCH = "data/iq/measured/dronerfb"
IQ_INDEX = f"{IQ_BATCH}/index.manifest.json"
HOLDOUT = "data/iq/measured/holdout.manifest.json"
SUBSET_LIST = "deploy/iq-subset.json"

# 包里的东西从这些路径来（另有引擎，它的来源提交由构建记录钉住）。组包前这些路径里有未提交的改动即拒，
# 包就说得清每个文件出自哪个提交；别处（报告、其他脚本）的改动不挡组包。
PACKAGE_SOURCES = ("deploy", "server", "web", "models", "engine", "geo", "third_party", "data",
                   "tests/regression/diagrams", "THIRD-PARTY-NOTICES")

# 编进引擎二进制的源：引擎与 geo 的源码和 CMake、Coder 产物、第三方件，以及决定编译选项的 CI 配置。
# 引擎产物出自的提交与 HEAD 不同时，只要这些路径在两个提交之间一个字节没变，产物就等同于 HEAD 编出来的。
# 两个会话并行时这种情形经常有：另一边只提交了报告或脚本，不该为此再等一轮 CI。
ENGINE_SOURCES = ("engine", "geo", "models", "third_party", ".github/workflows")

# 包内要扫的机器路径：与 scripts/check-paths.sh 同一组（铁律 17）
MACHINE_PATH = re.compile(r"/Users/|/home/[a-z]|[A-Za-z]:\\Users\\")
TEXT_EXT = {".js", ".mjs", ".cjs", ".json", ".geojson", ".md", ".txt", ".html", ".css", ".bat", ".svg", ".ts"}
# 已经压缩过的格式不再压一遍：pmtiles 的瓦片本身是 gzip，png 自带压缩
STORED_EXT = {".pmtiles", ".png", ".zip"}


class PackError(RuntimeError):
    """组包条件不满足。报文说清哪一项、怎么处理。"""


# ---------------------------------------------------------------------------
# 小工具

def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True,
                          text=True, encoding="utf-8").stdout.strip()


def utf8_console() -> None:
    """Windows 上标准输出接到管道时缺省按系统代码页编码，打印中文会抛异常；一律改成 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_json(rel: str) -> dict:
    with open(ROOT / rel, encoding="utf-8") as f:
        return json.load(f)


def say(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# 实测片段子集

def subset_rule() -> dict:
    """规则写死：每个类别取索引顺序里第一个不在验证集的片段（即取自实测样本集，D-098），
    再并上回归框图夹具引用到的同一批片段。验证集的片段不进包：它只做独立检验。"""
    index = load_json(IQ_INDEX)
    holdout = {r["data_id"] for r in load_json(HOLDOUT)["holdout"]}
    picks: dict[str, dict] = {}
    for p in index["products"]:
        code = p["truth"]["class_code"]
        if p["data_id"] in holdout or code in picks:
            continue
        picks[code] = p
    rows = []
    for code in sorted(picks):
        p = picks[code]
        t = p["truth"]
        rows.append({
            "data_id": p["data_id"],
            "class_code": code,
            "class_name": t.get("class_name"),
            "reason": f"类别 {code} 在实测样本集里按索引顺序的第一个片段",
        })
    chosen = {r["data_id"] for r in rows}
    batch = IQ_BATCH.rsplit("/", 1)[1]
    by_id = {p["data_id"]: p for p in index["products"]}
    for path in sorted((ROOT / "tests" / "regression" / "diagrams").glob("*.json")):
        for m in sorted(set(re.findall(rf'"data_id"\s*:\s*"({batch}_[A-Za-z0-9_]+)"', path.read_text(encoding="utf-8")))):
            if m in chosen:
                continue
            if m not in by_id:
                raise PackError(f"{path.relative_to(ROOT).as_posix()} 引用的 {m} 不在批索引里")
            p = by_id[m]
            rows.append({
                "data_id": m,
                "class_code": p["truth"]["class_code"],
                "class_name": p["truth"].get("class_name"),
                "reason": f"回归框图 {path.name} 引用",
            })
            chosen.add(m)
    in_holdout = [r["data_id"] for r in rows if r["data_id"] in holdout]
    return {
        "schema": "cuav-iq-subset/1",
        "batch": IQ_BATCH,
        "rule": "每个类别取索引顺序里第一个不在验证集（holdout.manifest.json）的片段，再并上 tests/regression/diagrams 引用的片段",
        "note": "每个机型的第 3 架只出现在验证集里（D-098），所以实测样本集只有 13 个类别：6 个机型各 2 架，加背景",
        "products": rows,
        "in_validation_set": in_holdout,
    }


def cmd_subset(_: argparse.Namespace) -> int:
    doc = subset_rule()
    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    (ROOT / SUBSET_LIST).write_text(text, encoding="utf-8", newline="\n")
    say(f"写出 {SUBSET_LIST}：{len(doc['products'])} 个片段；其中在验证集里的 {len(doc['in_validation_set'])} 个")
    return 0


def trimmed_index(ids: list[str]) -> bytes:
    raw = (ROOT / IQ_INDEX).read_bytes()
    idx = json.loads(raw)
    want = set(ids)
    keep = [p for p in idx["products"] if p["data_id"] in want]
    missing = want - {p["data_id"] for p in keep}
    if missing:
        raise PackError(f"子集里的片段不在批索引里：{sorted(missing)}")
    if len(idx.get("datasets", {})) != 1:
        raise PackError("批索引的 datasets 不止一个数据集，裁剪后无法照比例重算")
    full_count = idx["product_count"]
    idx["product_count"] = len(keep)
    idx["datasets"] = {k: len(keep) for k in idx["datasets"]}
    for v in idx.get("calibration", {}).values():
        if "product_count" in v:
            v["product_count"] = len(keep)
    idx["quality_distribution"] = dict(sorted(collections.Counter(p["quality"] for p in keep).items()))
    idx["subset_of"] = {
        "index": IQ_INDEX,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "product_count": full_count,
        "list": SUBSET_LIST,
    }
    idx["products"] = keep
    return (json.dumps(idx, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


# ---------------------------------------------------------------------------
# 组包

class Stage:
    """暂存目录与文件账：每放一个文件就记下大小与 sha256。"""

    def __init__(self, root: Path):
        self.root = root
        self.files: dict[str, tuple[int, str]] = {}
        self.dirs: set[str] = set()
        self.links: dict[str, str] = {}       # 符号链接（Mac 的 .app 里有）：包内路径 → 链接目标
        self.execs: set[str] = set()          # 要带可执行位的文件

    def _dst(self, rel: str) -> Path:
        if rel in self.files:
            raise PackError(f"包内路径重复：{rel}")
        dst = self.root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        return dst

    def put(self, src: Path, rel: str) -> str:
        dst = self._dst(rel)
        shutil.copyfile(src, dst)
        digest = sha256_file(dst)
        self.files[rel] = (dst.stat().st_size, digest)
        return digest

    def put_bytes(self, data: bytes, rel: str) -> str:
        dst = self._dst(rel)
        dst.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        self.files[rel] = (len(data), digest)
        return digest

    def put_tree(self, src: Path, rel: str, skip=lambda p: False) -> int:
        n = 0
        for p in sorted(src.rglob("*")):
            if p.is_file() and not skip(p):
                self.put(p, f"{rel}/{p.relative_to(src).as_posix()}")
                n += 1
        return n

    def mkdir(self, rel: str) -> None:
        (self.root / rel).mkdir(parents=True, exist_ok=True)
        self.dirs.add(rel)

    def adopt_tree(self, rel: str) -> int:
        """已经放在暂存目录里的一棵树（Mac 的 .app：解压、改动、签名都在原地做）逐件记账，
        符号链接记链接目标、不跟进去，可执行位照文件本身的权限。"""
        n = 0
        for dirpath, dirnames, filenames in os.walk(self.root / rel):
            d = Path(dirpath)
            for name in sorted(dirnames + filenames):
                p = d / name
                r = p.relative_to(self.root).as_posix()
                if p.is_symlink():
                    self.links[r] = os.readlink(p)
                elif p.is_file():
                    if r in self.files:
                        raise PackError(f"包内路径重复：{r}")
                    self.files[r] = (p.stat().st_size, sha256_file(p))
                    if p.stat().st_mode & stat.S_IXUSR:
                        self.execs.add(r)
                    n += 1
            dirnames[:] = [x for x in dirnames if not (d / x).is_symlink()]
        return n


def run_build(skip: bool) -> None:
    if skip:
        return
    npm = shutil.which("npm")
    if not npm:
        raise PackError("找不到 npm；先装 Node，或已建好前端与服务时加 --skip-build")
    for sub in ("server", "web"):
        say(f"构建 {sub} …")
        subprocess.run([npm, "run", "build"], cwd=ROOT / sub, check=True, stdout=subprocess.DEVNULL)


def engine_from_dir(d: Path, head: str, target: str = "win-x64") -> tuple[Path, dict]:
    exe, rec_path = d / ENGINE_EXE[target], d / "cuav_run.build.json"
    if not exe.is_file() or not rec_path.is_file():
        raise PackError(f"{d} 里没有 {ENGINE_EXE[target]} 与 cuav_run.build.json（应是 CI 产物 {ENGINE_ARTIFACT[target]}）")
    rec = json.loads(rec_path.read_text(encoding="utf-8"))
    got = sha256_file(exe)
    if got != rec["sha256"]:
        raise PackError(f"{exe.name} 的 sha256 {got} 与构建记录 {rec['sha256']} 不符")
    if rec["commit"] != head:
        changed = engine_sources_changed(rec["commit"], head)
        if changed:
            raise PackError(f"引擎出自提交 {rec['commit'][:12]}，当前 HEAD 是 {head[:12]}，其间编进引擎的源有改动"
                            f"（{', '.join(changed[:5])}）。推送当前提交、等 CI 跑完，再用那次运行的产物组包")
        say(f"  引擎出自 {rec['commit'][:12]}，与 HEAD {head[:12]} 之间编进引擎的源（{' '.join(ENGINE_SOURCES)}）没有改动，照用")
    return exe, rec


def engine_sources_changed(commit: str, head: str) -> list[str]:
    """两个提交之间 ENGINE_SOURCES 里改动过的文件；提交不存在（如浅克隆）即拒，不猜。"""
    try:
        out = git("diff", "--name-only", commit, head, "--", *ENGINE_SOURCES)
    except subprocess.CalledProcessError as e:
        raise PackError(f"本地 git 里找不到引擎出自的提交 {commit[:12]}（{(e.stderr or '').strip()}）；先 git fetch") from e
    return [line for line in out.splitlines() if line]


def engine_from_ci(run_id: str, head: str, target: str = "win-x64") -> tuple[Path, dict]:
    d = CACHE / f"engine-{run_id}" if target == "win-x64" else CACHE / f"engine-{run_id}-{target}"
    if not (d / ENGINE_EXE[target]).is_file():
        if not shutil.which("gh"):
            raise PackError("找不到 gh（GitHub CLI）；或先手动下载产物再用 --engine <目录>")
        d.mkdir(parents=True, exist_ok=True)
        say(f"下载 CI 运行 {run_id} 的产物 {ENGINE_ARTIFACT[target]} …")
        subprocess.run(["gh", "run", "download", run_id, "-n", ENGINE_ARTIFACT[target], "-D", str(d)], cwd=ROOT, check=True)
    (d / ENGINE_EXE[target]).chmod(0o755)   # 下载的产物不带可执行位
    return engine_from_dir(d, head, target)


def engine_from_local(build_dir: Path, head: str) -> tuple[Path, dict]:
    """本机 MSVC 编出的引擎（Windows 上自己组包用）。记录与 CI 产物同形，但 kind = local、没有运行号。

    这里不核对 exe 出自哪个提交（本机构建没有构建记录），所以清单写 deliverable: false；
    /MT 由 check_stage 读导入表把关，与 CI 产物同一道检查。"""
    exe = build_dir / "Release" / "cuav_run.exe"
    if not exe.is_file():
        raise PackError(f"找不到 {exe}；先在仓库根执行 cmake -S engine -B engine/build 与 "
                        "cmake --build engine/build --config Release --parallel")
    compiler = "MSVC"
    for f in sorted((build_dir / "CMakeFiles").glob("*/CMakeCXXCompiler.cmake")):
        m = re.search(r'set\(CMAKE_CXX_COMPILER_VERSION "([^"]*)"\)', f.read_text(encoding="utf-8", errors="replace"))
        if m:
            compiler = f"MSVC {m.group(1)}"
            break
    rec = {"kind": "local", "sha256": sha256_file(exe), "bytes": exe.stat().st_size, "commit": head,
           "repository": None, "run_id": None, "run_attempt": None,
           "compiler": compiler, "runtime_library": "MultiThreaded (/MT)"}
    return exe, rec


def engine_from_local_mac(head: str) -> tuple[Path, dict]:
    """Mac 上本机编出的引擎。必须按最低系统 MAC_MIN_OS 单独编：开发用的 engine/build 是按本机系统编的。"""
    exe = ROOT / "engine" / "build-mac" / "cuav_run"
    if not exe.is_file():
        raise PackError("找不到 engine/build-mac/cuav_run；先在仓库根执行 "
                        f"cmake -S engine -B engine/build-mac -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET={MAC_MIN_OS} "
                        "与 cmake --build engine/build-mac --parallel")
    rec = {"kind": "local", "sha256": sha256_file(exe), "bytes": exe.stat().st_size, "commit": head,
           "repository": None, "run_id": None, "run_attempt": None,
           "compiler": "AppleClang", "runtime_library": "libc++（系统）", "macos_min": MAC_MIN_OS}
    return exe, rec


def download_checked(url: str, dst: Path, want: str) -> Path:
    if not dst.is_file():
        CACHE.mkdir(parents=True, exist_ok=True)
        say(f"下载 {url} …")
        tmp = dst.with_suffix(".part")
        with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(dst)
    got = sha256_file(dst)
    if got != want:
        raise PackError(f"{dst.name} 的 sha256 {got} 与官方值 {want} 不符；删掉 {dst} 重新下载")
    return dst


def node_zip() -> Path:
    return download_checked(NODE_URL, CACHE / NODE_ZIP, NODE_ZIP_SHA256)


def electron_zip(target: str) -> Path:
    name, want = ELECTRON_ZIP[target]
    return download_checked(ELECTRON_URL.format(v=ELECTRON_VERSION, z=name), CACHE / name, want)


def stage_electron(st: Stage, target: str) -> dict:
    """Electron 外壳（D-111）：官方运行时原样解压，只去掉自带的示例应用、放进 deploy/electron 的外壳。"""
    z = electron_zip(target)
    shell_files = ("main.js", "package.json")
    if target == "win-x64":
        with zipfile.ZipFile(z) as zf:
            for zi in sorted(zf.infolist(), key=lambda i: i.filename):
                if zi.is_dir() or zi.filename == "resources/default_app.asar":
                    continue
                rel = "CuavDemo.exe" if zi.filename == "electron.exe" else zi.filename
                st.put_bytes(zf.read(zi), f"{WIN_APP_DIR}/{rel}")
        for f in shell_files:
            st.put(DEPLOY / "electron" / f, f"{WIN_APP_DIR}/resources/app/{f}")
        entry = f"{WIN_APP_DIR}/CuavDemo.exe"
    else:
        if sys.platform != "darwin":
            raise PackError("Mac 包只能在 Mac 上组：要 ditto 解压（保留 .app 里的符号链接）与 codesign 重新签名")
        tmp = st.root / ".electron-unpack"
        subprocess.run(["ditto", "-x", "-k", str(z), str(tmp)], check=True)
        app_dir = st.root / MAC_APP
        (tmp / "Electron.app").rename(app_dir)
        res = app_dir / "Contents" / "Resources"
        # Mac 压缩包里许可证在 Electron.app 旁边，挪进 Resources 一起签名（与 THIRD-PARTY-NOTICES 写的位置一致）
        for lic in ("LICENSE", "LICENSES.chromium.html"):
            shutil.copyfile(tmp / lic, res / lic)
        shutil.rmtree(tmp)
        (res / "default_app.asar").unlink()
        (res / "app").mkdir()
        for f in shell_files:
            shutil.copyfile(DEPLOY / "electron" / f, res / "app" / f)
        plist_path = app_dir / "Contents" / "Info.plist"
        with open(plist_path, "rb") as f:
            plist = plistlib.load(f)
        plist.update({"CFBundleName": "CuavDemo", "CFBundleDisplayName": SHELL_TITLE,
                      "CFBundleIdentifier": "org.cuav.demo-shell"})
        with open(plist_path, "wb") as f:
            plistlib.dump(plist, f)
        # 改了 Info.plist 与 Resources，原来的签名失效；Apple 芯片上签名无效的程序不让启动。
        # 没有 Apple 开发者账号，只能做临时签名（ad-hoc），不能公证（包内说明写明首次打开的放行办法）
        subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app_dir)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        v = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app_dir)], capture_output=True, text=True)
        if v.returncode != 0:
            raise PackError(f"{MAC_APP} 重新签名后校验不过：{v.stderr.strip()}")
        st.adopt_tree(MAC_APP)
        entry = MAC_APP
    return {"electron": {"version": ELECTRON_VERSION, "zip": ELECTRON_ZIP[target][0], "zip_sha256": ELECTRON_ZIP[target][1],
                         "entry": entry, "shell_files": [f"deploy/electron/{f}" for f in shell_files]}}


def mac_engine_problems(exe: Path) -> list[str]:
    """Mac 引擎只许依赖系统库，最低系统不高于 MAC_MIN_OS（否则旧一点的 Mac 上起不来）。"""
    out = subprocess.run(["otool", "-L", str(exe)], capture_output=True, text=True, check=True).stdout
    bad = [l.split()[0] for l in out.splitlines()[1:] if l.strip() and not l.strip().startswith(("/usr/lib/", "/System/"))]
    probs = [f"依赖了非系统库：{bad}"] if bad else []
    load = subprocess.run(["otool", "-l", str(exe)], capture_output=True, text=True, check=True).stdout
    m = re.search(r"cmd LC_BUILD_VERSION.*?minos (\S+)", load, re.S)
    if not m:
        probs.append("读不出最低系统版本（LC_BUILD_VERSION）")
    elif tuple(int(x) for x in m.group(1).split(".")) > tuple(int(x) for x in MAC_MIN_OS.split(".")):
        probs.append(f"最低系统是 {m.group(1)}，高于 {MAC_MIN_OS}；按 CMAKE_OSX_DEPLOYMENT_TARGET={MAC_MIN_OS} 重编")
    return probs


def check_dem(rel: str, man: dict) -> list[Path]:
    """按 build_regional_basemap.py 的同一口径重算 DEM 索引哈希：按 zoom、x、y 逐行 `z/x/y <sha256>`。"""
    root = ROOT / rel
    tiles = []
    for p in root.rglob("*.png"):
        z, x, y = p.relative_to(root).with_suffix("").parts
        tiles.append((int(z), int(x), int(y), p))
    tiles.sort()
    h = hashlib.sha256()
    for z, x, y, p in tiles:
        h.update(f"{z}/{x}/{y} {sha256_file(p)}\n".encode())
    if len(tiles) != man["tiles"] or h.hexdigest() != man["index_sha256"]:
        raise PackError(f"{rel} 与清单不符：{len(tiles)} 块（清单 {man['tiles']}），索引哈希 {h.hexdigest()[:12]}"
                        f"（清单 {man['index_sha256'][:12]}）")
    return [p for *_, p in tiles]


def need_file(rel: str) -> Path:
    p = ROOT / rel
    if not p.is_file():
        raise PackError(f"缺文件 {rel}（不在 git 里，要从开发机的数据目录取；见 deploy/README.md）")
    return p


def check_sha(rel: str, want: str, size: int | None = None) -> Path:
    p = need_file(rel)
    got = sha256_file(p)
    if got != want or (size is not None and p.stat().st_size != size):
        raise PackError(f"{rel} 与清单不符：sha256 {got[:12]}（清单 {want[:12]}），{p.stat().st_size} 字节（清单 {size}）")
    return p


def stage_program(st: Stage, args: argparse.Namespace, head: str) -> dict:
    """程序部分：启动器、服务、前端、模型、git 里的场景与清单、引擎、便携 Node。"""
    info: dict = {}

    target = args.target
    # 启动器与说明。launch.mjs 两个平台共用；备用启动方式 Windows 是 start.bat，Mac 是 start.command
    if not args.host:
        if target == "win-x64":
            st.put(DEPLOY / "windows" / "start.bat", "start.bat")
        else:
            st.put(DEPLOY / "mac" / "start.command", "start.command")
            st.execs.add("start.command")
    st.put(DEPLOY / "windows" / "launch.mjs", "launch.mjs")
    st.put(ROOT / "THIRD-PARTY-NOTICES", "THIRD-PARTY-NOTICES")

    # 引擎
    if args.host:
        exe = ROOT / "engine" / "build" / "cuav_run"
        if not exe.is_file():
            raise PackError("本机引擎 engine/build/cuav_run 不存在；先按 CLAUDE.md 构建引擎")
        st.put(exe, "bin/cuav_run")
        os.chmod(st.root / "bin" / "cuav_run", 0o755)
        info["engine"] = {"file": "bin/cuav_run", "sha256": st.files["bin/cuav_run"][1], "source": {"kind": "local"}}
    else:
        if args.engine_local:
            exe, rec = engine_from_local_mac(head) if target == "mac-arm64" else engine_from_local(ROOT / "engine" / "build", head)
            say(f"  引擎取本机编译的 {exe.relative_to(ROOT).as_posix()}（{rec['compiler']}）：证不了出自哪个提交，包只供本机自用")
        elif args.engine_ci:
            exe, rec = engine_from_ci(args.engine_ci, head, target)
        else:
            exe, rec = engine_from_dir(Path(args.engine), head, target)
        rel = f"bin/{ENGINE_EXE[target]}"
        st.put(exe, rel)
        if target == "mac-arm64":
            st.execs.add(rel)
            os.chmod(st.root / rel, 0o755)
        keys = ("repository", "run_id", "run_attempt", "commit", "compiler", "runtime_library")
        info["engine"] = {"file": rel, "sha256": rec["sha256"],
                          "source": {"kind": rec.get("kind", "ci"), **{k: rec.get(k) for k in keys},
                                     **({"macos_min": rec.get("macos_min")} if target == "mac-arm64" else {})}}

    # 便携 Node：只取 node.exe 与 LICENSE（Windows 包；Mac 包用 Electron 自带的 Node）
    if not args.host and target == "win-x64":
        z = node_zip()
        with zipfile.ZipFile(z) as zf:
            top = f"node-{NODE_VERSION}-win-x64"
            st.put_bytes(zf.read(f"{top}/node.exe"), "node/node.exe")
            st.put_bytes(zf.read(f"{top}/LICENSE"), "node/LICENSE")
        info["node"] = {"version": NODE_VERSION, "zip": NODE_ZIP, "zip_sha256": NODE_ZIP_SHA256}

    # 应用服务：只拷 src 里非测试源文件对应的 .js（dist 里可能有陈旧文件）
    src = ROOT / "server" / "src"
    n = 0
    for ts in sorted(src.rglob("*.ts")):
        rel = ts.relative_to(src).as_posix()
        if rel.endswith(".test.ts") or rel == "tasks/testkit.ts":
            continue
        js = ROOT / "server" / "dist" / (rel[:-3] + ".js")
        if not js.is_file():
            raise PackError(f"server/dist 里缺 {js.name}；先 cd server && npm run build")
        st.put(js, f"server/dist/{rel[:-3]}.js")
        n += 1
    st.put(ROOT / "server" / "package.json", "server/package.json")
    lock = json.loads((ROOT / "server" / "package-lock.json").read_text(encoding="utf-8"))
    ws_dir = ROOT / "server" / "node_modules" / "ws"
    ws_ver = json.loads((ws_dir / "package.json").read_text(encoding="utf-8"))["version"]
    lock_ver = lock["packages"]["node_modules/ws"]["version"]
    if not (ws_ver == lock_ver == WS_VERSION):
        raise PackError(f"ws 版本不一致：node_modules {ws_ver}、锁文件 {lock_ver}、随包约定 {WS_VERSION}")
    st.put_tree(ws_dir, "server/node_modules/ws")
    info["server_js_files"] = n

    # 前端产物，不带 .map
    web = ROOT / "web" / "dist"
    if not (web / "index.html").is_file():
        raise PackError("web/dist 不存在；先 cd web && npm run build")
    st.put_tree(web, "web/dist", skip=lambda p: p.suffix == ".map")

    # 模型：git 里的全部文件（识别库运行时读，两张 FIR 表导出时读）
    for rel in git("ls-files", "models").splitlines():
        st.put(ROOT / rel, rel)

    # git 里的场景与底图清单
    for rel in (f"{SCENE}/manifest.json", f"{SCENE}/buildings.manifest.json",
                "data/basemap/regional/beijing.manifest.json", "data/basemap/regional/beijing-dem.manifest.json",
                "data/basemap/overview/world-z6.manifest.json"):
        st.put(need_file(rel), rel)
    scene_sha = st.files[f"{SCENE}/manifest.json"][1]
    # 只取 git 里的场景：盘上还可能有未入库的副本（演示备场脚本写进来的正式集格子），
    # 它们不属于任何提交，进了包就说不清包出自哪个提交
    for rel in sorted(r for r in git("ls-files", f"{SCENE}/scenarios").splitlines() if r.endswith(".scenario.json")):
        p = ROOT / rel
        st.put(p, rel)
        want = json.loads(p.read_text(encoding="utf-8"))["aoi"]["manifest_sha256"]
        if want != scene_sha:
            raise PackError(f"{rel} 记的场景数据包清单哈希 {want[:12]} 与包里那份 {scene_sha[:12]} 不符，引擎会拒")

    for d in ("data/runs", "data/diagrams", "data/exports", "data/tmp"):
        st.mkdir(d)

    if not args.host and not args.no_electron:
        info.update(stage_electron(st, target))
    return info


def stage_data(st: Stage) -> dict:
    """盘上数据：每一件都按清单核过 sha256 才进包。"""
    scene = load_json(f"{SCENE}/manifest.json")
    bmeta = next(p for p in scene["products"] if p["file"] == "buildings.geojson")
    st.put(check_sha(f"{SCENE}/buildings.geojson", bmeta["sha256"], bmeta["size_bytes"]), f"{SCENE}/buildings.geojson")

    for rel_man, rel_file in (("data/basemap/regional/beijing.manifest.json", "data/basemap/regional/beijing.pmtiles"),
                              ("data/basemap/overview/world-z6.manifest.json", "data/basemap/overview/world-z6.pmtiles")):
        out = load_json(rel_man)["output"]
        st.put(check_sha(rel_file, out["sha256"], out["size_bytes"]), rel_file)
    dem_rel = "data/basemap/regional/beijing-dem"
    for p in check_dem(dem_rel, load_json(f"{dem_rel}.manifest.json")):
        st.put(p, p.relative_to(ROOT).as_posix())

    subset = load_json(SUBSET_LIST)
    if subset != subset_rule():
        raise PackError(f"{SUBSET_LIST} 与按规则重算的结果不同；运行 pack.py subset 重新生成并审阅")
    ids = [r["data_id"] for r in subset["products"]]
    index_rows = {p["data_id"]: p for p in load_json(IQ_INDEX)["products"]}
    iq_bytes = 0
    for i in ids:
        man_rel = f"{IQ_BATCH}/{i}.manifest.json"
        man = json.loads(need_file(man_rel).read_text(encoding="utf-8"))
        if man["identity"]["content_sha256"] != index_rows[i]["content_sha256"]:
            raise PackError(f"{man_rel} 的内容哈希与批索引不符")
        st.put(ROOT / man_rel, man_rel)
        segs = man["segments"]
        for seg in segs:
            rel = f"{IQ_BATCH}/{seg['file']}"
            st.put(check_sha(rel, seg["sha256"], seg["bytes"]), rel)
            iq_bytes += seg["bytes"]
        if len(segs) == 1 and segs[0]["sha256"] != index_rows[i]["content_sha256"]:
            raise PackError(f"{i} 的样点文件哈希与批索引的内容哈希不符")
    st.put_bytes(trimmed_index(ids), IQ_INDEX)
    st.put(need_file(HOLDOUT), HOLDOUT)
    return {"iq_subset": {"list": SUBSET_LIST, "products": len(ids), "bytes": iq_bytes}}


def check_stage(st: Stage, args: argparse.Namespace | None = None) -> None:
    """出包前检查（铁律 15、17；deploy/README.md 的已知坑）。"""
    # Mac 的 .app 内部文件名由 Electron 上游定（如「Electron Helper (GPU).app」），含空格；对它只要求 ASCII
    in_app = lambda r: r.startswith(f"{MAC_APP}/")
    names = list(st.files) + sorted(st.dirs) + list(st.links)
    bad_names = [r for r in names if not re.fullmatch(r"[ -~]+" if in_app(r) else r"[!-~]+", r)]
    if bad_names:
        raise PackError(f"包内文件名必须是不含空格的 ASCII：{bad_names[:5]}")
    hits = []
    for rel in st.files:
        if Path(rel).suffix.lower() not in TEXT_EXT:
            continue
        # Electron 运行时是上游原样的文件（许可证文本等），铁律 17 管的是本项目自己的文件；外壳本身照查
        if (in_app(rel) or rel.startswith(f"{WIN_APP_DIR}/")) and "/resources/app/" not in rel.replace("/Resources/", "/resources/"):
            continue
        text = (st.root / rel).read_text(encoding="utf-8", errors="replace")
        m = MACHINE_PATH.search(text)
        if m:
            hits.append(f"{rel}: …{text[max(0, m.start() - 30):m.end() + 30]}…")
    if hits:
        raise PackError("包内有机器路径（铁律 17）：\n  " + "\n  ".join(hits[:10]))
    if "start.bat" in st.files:
        bat = (st.root / "start.bat").read_bytes()
        if any(b > 0x7E or (b < 0x20 and b not in (0x0D, 0x0A, 0x09)) for b in bat):
            raise PackError("start.bat 必须只含 ASCII：cmd.exe 按系统代码页读它")
        if bat.count(b"\n") != bat.count(b"\r\n") or not bat.endswith(b"\r\n"):
            raise PackError("start.bat 的每一行都必须以 CRLF 结尾")
    if "start.command" in st.files:
        cmd = (st.root / "start.command").read_bytes()
        if b"\r" in cmd or not cmd.startswith(b"#!/bin/sh"):
            raise PackError("start.command 必须以 #!/bin/sh 开头、只用 LF 换行")
    # Mac 引擎：交付的包要查依赖与最低系统；--host 组的验证包用的是开发引擎，不查
    if "bin/cuav_run" in st.files and args is not None and not args.host and sys.platform == "darwin":
        probs = mac_engine_problems(st.root / "bin" / "cuav_run")
        if probs:
            raise PackError("Mac 引擎不合要求：" + "；".join(probs))
    if "bin/cuav_run.exe" in st.files:
        sys.path.insert(0, str(DEPLOY))
        import pe_imports
        dlls = pe_imports.imported_dlls((st.root / "bin" / "cuav_run.exe").read_bytes())
        bad = pe_imports.forbidden(dlls)
        if bad:
            raise PackError(f"cuav_run.exe 依赖了 VC++ 运行库（应静态链接 /MT）：{bad}")


def render_readme(name: str, commit: str, target: str = "win-x64") -> bytes:
    if target == "mac-arm64":
        text = (DEPLOY / "mac" / "README.template.txt").read_text(encoding="utf-8")
        return text.replace("{version}", name).replace("{commit}", commit[:12]).encode("utf-8")
    text = (DEPLOY / "windows" / "README.template.txt").read_bytes().decode("utf-8-sig")
    text = text.replace("{version}", name).replace("{commit}", commit[:12])
    return "﻿".encode("utf-8") + text.encode("utf-8")


def write_zip(st: Stage, name: str, when: dt.datetime, out: Path) -> Path:
    """确定性 zip：按路径排序、时间戳取提交时间、权限位固定。同一输入两次出包逐字节相同。"""
    zpath = out / f"{name}.zip"
    tmp = zpath.with_suffix(".zip.part")
    stamp = when.timetuple()[:6]
    entries = sorted([(rel, "f") for rel in st.files] + [(rel, "d") for rel in st.dirs] + [(rel, "l") for rel in st.links])
    with zipfile.ZipFile(tmp, "w", allowZip64=True) as zf:
        for rel, kind in entries:
            arc = f"{name}/{rel}" + ("/" if kind == "d" else "")
            zi = zipfile.ZipInfo(arc, date_time=stamp)
            zi.create_system = 3                                  # 按 Unix 记权限位，各平台一致
            if kind == "l":
                # 符号链接按 Unix 约定存：类型位 S_IFLNK、内容是链接目标（Finder 与 ditto 解压时还原成链接）
                zi.external_attr = (0o120000 | 0o755) << 16
                zf.writestr(zi, st.links[rel])
            elif kind == "f":
                mode = 0o755 if rel.endswith((".exe", ".bat")) or rel in ("bin/cuav_run",) or rel in st.execs else 0o644
                zi.external_attr = (0o100000 | mode) << 16
                stored = Path(rel).suffix.lower() in STORED_EXT
                zi.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
                big = (st.root / rel).stat().st_size >= (1 << 31)
                with open(st.root / rel, "rb") as src, zf.open(zi, "w", force_zip64=big) as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
            else:
                zi.external_attr = (0o040000 | 0o755) << 16
                zf.writestr(zi, b"")
    tmp.replace(zpath)
    return zpath


def cmd_build(args: argparse.Namespace) -> int:
    if not (args.host or args.engine or args.engine_ci or args.engine_local):
        raise PackError("要指定引擎来源：--engine-ci <运行号>、--engine <目录>、--engine-local（Windows）或 --host")
    if args.target == "mac-arm64" and sys.platform != "darwin" and not args.host:
        raise PackError("Mac 包只能在 Mac 上组（要 ditto 与 codesign）")
    if args.engine_local and args.target == "win-x64" and sys.platform != "win32":
        raise PackError("--engine-local 只在 Windows 上用（读 MSVC 编出的 engine/build/Release/cuav_run.exe）；"
                        "其他平台验证数据用 --host")
    head = git("rev-parse", "HEAD")
    dirty = git("status", "--porcelain", "--untracked-files=no", "--", *PACKAGE_SOURCES)
    if dirty and not args.allow_dirty:
        raise PackError("包的来源目录里有未提交的改动，包就说不清出自哪个提交；先提交，或加 --allow-dirty（只用于调试）：\n" + dirty)
    when = dt.datetime.fromtimestamp(int(git("show", "-s", "--format=%ct", head)), dt.timezone.utc)
    name = f"cuav-demo-{when:%Y%m%d}-{head[:7]}-" + (f"host-{sys.platform}" if args.host else args.target)
    if args.scope == "program":
        name += "-program"

    run_build(args.skip_build)
    out = Path(args.out).resolve()
    stage_root = out / name
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True)
    st = Stage(stage_root)

    say(f"组包 {name}（范围 {args.scope}）")
    try:
        info = stage_program(st, args, head)
        if args.scope == "full":
            info.update(stage_data(st))
        st.put_bytes(render_readme(name, head, args.target), "README.txt")
        check_stage(st, args)
    except BaseException:
        shutil.rmtree(stage_root, ignore_errors=True)   # 不留半截的包目录
        raise

    manifest = {
        "schema": "cuav-package/1",
        "name": name,
        "scope": args.scope,
        "platform": args.target if not args.host else f"host-{sys.platform}",
        "deliverable": not args.host and not args.engine_local and not dirty,
        "git": {"commit": head, "commit_time_utc": when.strftime("%Y-%m-%dT%H:%M:%SZ"), "dirty": bool(dirty)},
        **info,
        "file_count": len(st.files),
        "total_bytes": sum(b for b, _ in st.files.values()),
        "files": [{"path": rel, "bytes": b, "sha256": h} for rel, (b, h) in sorted(st.files.items())],
        **({"links": [{"path": rel, "target": t} for rel, t in sorted(st.links.items())]} if st.links else {}),
    }
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    st.put_bytes(text.encode("utf-8"), "package.manifest.json")

    say(f"  文件 {manifest['file_count']} 个，{manifest['total_bytes'] / 1e6:.1f} MB → {stage_root.relative_to(ROOT) if stage_root.is_relative_to(ROOT) else stage_root}")
    if args.zip:
        z = write_zip(st, name, when, out)
        say(f"  压缩包 {z.name}：{z.stat().st_size / 1e6:.1f} MB，sha256 {sha256_file(z)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    utf8_console()
    ap = argparse.ArgumentParser(description="单机包组包（W-2，D-099）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("subset", help=f"按规则生成 {SUBSET_LIST}")
    b = sub.add_parser("build", help="组包")
    b.add_argument("--scope", choices=("program", "full"), default="full")
    b.add_argument("--target", choices=TARGETS, default="win-x64", help="目标平台（D-111）")
    b.add_argument("--no-electron", action="store_true", help="不带 Electron 外壳（调试用；交付包都带）")
    g = b.add_mutually_exclusive_group()
    g.add_argument("--engine-ci", metavar="运行号")
    g.add_argument("--engine", metavar="目录")
    g.add_argument("--engine-local", action="store_true",
                   help="本机编出的引擎（Windows：MSVC 编出的 engine/build/Release/cuav_run.exe；Mac：engine/build-mac/cuav_run）；包只供本机自用，不交付")
    g.add_argument("--host", action="store_true", help="用本机开发引擎、不带便携 Node 与外壳；只用于验证，不交付")
    b.add_argument("--out", default=str(ROOT / "dist"))
    b.add_argument("--zip", action="store_true")
    b.add_argument("--skip-build", action="store_true", help="前端与服务已经建好时跳过 npm run build")
    b.add_argument("--allow-dirty", action="store_true")
    args = ap.parse_args(argv)
    try:
        return cmd_subset(args) if args.cmd == "subset" else cmd_build(args)
    except PackError as e:
        print(f"组包失败：{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
