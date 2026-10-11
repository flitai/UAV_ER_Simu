#!/usr/bin/env python3
"""评测数据集生成（试样集，D-092；14 号报告 §8.3）。

格子文件 tests/regression/eval-dataset/<集合>.json 写意图（接收配置、传播、S4、平台与辐射源、信噪比目标）。
三个子命令：

  resolve   编写步骤：解算平台位置（视距按 cuav_run --field 迭代到 0.01 dB，非视距按环搜索），
            量接收机 IQ 不平衡与直流（DroneRFb 训练部分的背景，M 档），冻结回格子文件。输出要审阅并提交。
  prepare   每格写场景与链路规格，经 web/src/chain/examples/_gen.ts eval 编译成框图（往返逐字节、频率计划对放行表），
            再用 cuav_run --validate 核一遍；不跑引擎。
  run       prepare 之后逐格运行 cuav_run、导出 S3 与 S4 的 SigMF、做断言、删运行目录，最后写数据集索引与交付件。
  pack      交付包对 SHA512SUMS 全量核对后打成确定性 zip（与单机包同一个 write_zip），写在 data/eval/<集合>/，另附 .sha512。

输出在 data/eval/<集合>/（不入 git，只有 *.manifest.json 与 *.md 入库，见 .gitignore）。

跑法：
    uv run --quiet --with numpy --with scipy python scripts/gen_eval_dataset.py resolve --set sample-v1
    uv run --quiet --with numpy python scripts/gen_eval_dataset.py prepare --set sample-v1
    uv run --quiet --with numpy --with sigmf --with matplotlib python scripts/gen_eval_dataset.py run --set sample-v1
    uv run --quiet --with numpy python scripts/gen_eval_dataset.py pack --set sample-v1
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from eval_dataset import cells as C  # noqa: E402
from eval_dataset import scenario as S  # noqa: E402


def _engine() -> str:
    return os.environ.get("CUAV_RUN") or os.path.join(ROOT, "engine", "build", "cuav_run")


def out_dir(set_id: str) -> str:
    return os.path.join(ROOT, "data", "eval", set_id)


def _pick(doc: dict, which: str | None) -> list[dict]:
    if not which:
        return list(doc["cells"])
    want = which.split(",")
    miss = sorted(set(want) - {c["id"] for c in doc["cells"]})
    if miss:
        raise SystemExit(f"格子文件里没有 {miss}")
    return [c for c in doc["cells"] if c["id"] in want]


# ---------------------------------------------------------------- resolve

def cmd_resolve(a) -> int:
    from eval_dataset import resolve as R
    doc = C.load(a.set)
    if a.frontend or doc.get("frontend_measured") is None:
        from eval_dataset import frontend
        doc["frontend_measured"] = frontend.measure()
        fm = doc["frontend_measured"]
        print(f"前端（DroneRFb 训练背景 {fm['source']['n_slices']} 片）：增益不平衡 {fm['iq_gain_imbalance_dB']} dB、"
              f"相位不平衡 {fm['iq_phase_imbalance_deg']}°、直流比噪声 {fm['dc_rel_noise_dB']} dB")
    for cell in _pick(doc, a.cells):
        R.resolve_cell(doc, cell, missing_only=a.missing_only)
        if cell.get("seed_from"):
            print(f"{cell['id']}：位置随来源格 {cell['seed_from']['set']}/{cell['seed_from']['cell']}")
            continue
        for p in cell["platforms"]:
            r = p["resolved"]
            extra = "" if p.get("off") else (f"，预算信噪比 {r['snr_budget_dB']} dB（目标 {p['snr_dB']}），路损 {r['path_loss_dB']} dB，"
                                            f"刀口 {r['diffraction_dB']} dB，{'视距' if r['line_of_sight'] else '非视距'}")
            print(f"{cell['id']} {p['id']}：方位 {r['azimuth_deg']}°、水平 {r['range_m']} m{extra}", flush=True)
        C.save(doc)                                      # 每格解算完就落盘：一百多格中途出错不必从头再来
    C.save(doc)
    print(f"已写回 {os.path.relpath(C.path_of(a.set), ROOT)}：审阅后提交")
    return 0


# ---------------------------------------------------------------- matrix

def cmd_matrix(a) -> int:
    """按 scripts/eval_dataset/matrix.py 展开正式集的格子文件；意图没变的格子保留已解算的位置。"""
    from eval_dataset import matrix as M
    if a.set != M.SET_ID:
        raise SystemExit(f"矩阵只定义了 {M.SET_ID}")
    existing = C.load(a.set) if os.path.exists(C.path_of(a.set)) else None
    doc = M.build(existing)
    C.save(doc)
    kinds: dict = {}
    for c in doc["cells"]:
        kinds[c["group"]["kind"]] = kinds.get(c["group"]["kind"], 0) + 1
    red = [(c["id"], p["id"], p["power_reduction"]["dB"]) for c in doc["cells"] for p in c["platforms"]
           if "power_reduction" in p]
    todo = sum(1 for c in doc["cells"] for p in c["platforms"] if not p.get("resolved"))
    print(f"写出 {os.path.relpath(C.path_of(a.set), ROOT)}：{len(doc['cells'])} 格 {kinds}；"
          f"降发射功率的平台 {len(red)} 个；待解算的平台 {todo} 个")
    for cid, pid, db in red:
        print(f"  {cid} {pid}：发射功率降 {db} dB")
    return 0


# ---------------------------------------------------------------- prepare

def prepare_cell(doc: dict, cell: dict, base: str | None = None) -> dict:
    """写场景与链路规格、编译框图、--validate；返回各文件的仓库相对路径。"""
    base = base or out_dir(doc["set_id"])
    sid = S.scenario_id(doc, cell)
    rel = lambda p: os.path.relpath(p, ROOT)            # noqa: E731
    scen_path = os.path.join(base, "scenarios", f"{sid}.scenario.json")
    spec_path = os.path.join(base, "repro", f"{sid}.chain.json")
    diag_path = os.path.join(base, "repro", f"{sid}.diagram.json")
    for p in (scen_path, spec_path):
        os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(scen_path, "wb") as fh:
        fh.write(S.dumps(S.build(doc, cell)))
    with open(spec_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(S.chain_spec(doc, cell, rel(scen_path)), ensure_ascii=False, indent=2) + "\n")
    p = subprocess.run(["npx", "tsx", "src/chain/examples/_gen.ts", "eval", "--spec", rel(spec_path)],
                       cwd=os.path.join(ROOT, "web"), capture_output=True)
    if p.returncode != 0:
        raise SystemExit(f"{cell['id']}：_gen eval 失败：{p.stderr.decode('utf-8', 'replace').strip()}")
    with open(diag_path, "wb") as fh:
        fh.write(p.stdout)
    v = subprocess.run([_engine(), "--validate", rel(diag_path), "--scenario", rel(scen_path),
                        "--library-root", "models/recognition"], cwd=ROOT, capture_output=True, text=True)
    if v.returncode != 0:
        raise SystemExit(f"{cell['id']}：cuav_run --validate 退出码 {v.returncode}：{(v.stdout + v.stderr).strip()[-800:]}")
    return {"scenario": rel(scen_path), "chain_spec": rel(spec_path), "diagram": rel(diag_path)}


def cmd_prepare(a) -> int:
    doc = C.load(a.set)
    bad = []
    for cell in _pick(doc, a.cells):
        try:
            files = prepare_cell(doc, cell)
        except SystemExit as e:                          # 一次报出全部不通过的格（正式集一百多格）
            bad.append(str(e))
            print(str(e), flush=True)
            continue
        print(f"{cell['id']}：{files['diagram']}（--validate 通过）", flush=True)
    if bad:
        print(f"不通过 {len(bad)} 格")
        return 1
    return 0


# ---------------------------------------------------------------- run

DIRTY_PATHS = ["engine", "geo", "models", "tools", "scripts", "algos", "web/src"]
DELIVER_EXT = (".sigmf-data", ".sigmf-meta", ".cuav-links.jsonl")
FREE_MIN_GB = 20


def _sha(path: str, algo: str = "sha256") -> str:
    import hashlib
    h = hashlib.new(algo)
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


# macOS 在目录里自动生成的元数据文件与目录：不进 SHA512SUMS，也不进交付 zip（用户 2026-10-10）
MAC_JUNK_NAMES = {".DS_Store", ".localized", "Icon\r", ".Spotlight-V100", ".Trashes", ".fseventsd",
                  ".TemporaryItems", ".DocumentRevisions-V100", "__MACOSX"}


def is_mac_junk(rel: str) -> bool:
    """rel 是交付包内的相对路径（「/」分隔）；任一段是 macOS 元数据名或 AppleDouble「._」文件即为真。"""
    return any(part in MAC_JUNK_NAMES or part.startswith("._") for part in rel.split("/"))


def git_state() -> dict:
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    st = subprocess.run(["git", "status", "--porcelain", "--", *DIRTY_PATHS], cwd=ROOT, capture_output=True,
                        text=True).stdout
    dirty = [l[3:] for l in st.splitlines() if l.strip()]
    return {"commit": head, "dirty": bool(dirty), "dirty_paths": dirty}


def _primaries(cell: dict) -> list[tuple[dict, dict]]:
    out = []
    for p in cell["platforms"]:
        if not p.get("off"):
            out.append((p, next(e for e in p["emitters"] if e["id"] == p["primary"])))
    return out


def _median(xs: list[float]) -> float | None:
    import statistics
    return float(statistics.median(xs)) if xs else None


def check_cell(doc: dict, cell: dict, res: list[dict], pkg_data: str) -> tuple[list[str], dict]:
    """生成之后的断言；返回（失败项，逐观测点与逐平台的摘要）。"""
    fails: list[str] = []
    ops: dict = {}
    for r in res:
        with open(os.path.join(pkg_data, r["stem"] + ".sigmf-meta"), encoding="utf-8") as fh:
            meta = json.load(fh)
        g = meta["global"]
        cap: dict = {}
        for a in meta["annotations"]:
            cap[a.get("cuav:capture")] = cap.get(a.get("cuav:capture"), 0) + 1
        ops[r["op_id"]] = {"meta": meta, "res": r, "capture": cap}
        if g["cuav:quality"]["state"] != "valid":
            fails.append(f"{r['stem']}：质量 {g['cuav:quality']['state']}（{g['cuav:quality']['reasons']}）")
        if r["export_clipped"]:
            fails.append(f"{r['stem']}：导出削顶 {r['export_clipped']}")
        if g["cuav:quality"]["engine_clipped_samples"]:
            fails.append(f"{r['stem']}：ADC 削顶 {g['cuav:quality']['engine_clipped_samples']}")
        if r["annotations"] != r["truth_rows_site"] - r["outside_capture"]:
            fails.append(f"{r['stem']}：注记 {r['annotations']} 条 ≠ 真值行 {r['truth_rows_site']} − 录制时间外 {r['outside_capture']}")
    plats = []
    s3 = ops["s3"]["meta"]["annotations"]
    s4 = ops["s4"]["meta"]["annotations"]
    if not _primaries(cell) and s3:
        fails.append(f"{cell['id']}：纯背景段却有 {len(s3)} 条注记")
    for p, e in _primaries(cell):
        hop = "preset" in e and S.is_hopping(e["preset"])
        tol = p["search"]["tol_dB"] + 0.05 if "search" in p else 0.05
        mine3 = [a for a in s3 if a["cuav:emitter_id"] == e["id"]]
        mine4 = [a for a in s4 if a["cuav:emitter_id"] == e["id"]]
        if not mine3:
            fails.append(f"{cell['id']} {p['id']}：主辐射源 {e['id']} 在 S3 没有注记")
            continue
        snr = [a["cuav:snr_dB"] for a in mine3 if a.get("cuav:snr_dB") is not None]
        if len(snr) != len(mine3):
            fails.append(f"{cell['id']} {e['id']}：有注记没有预算信噪比")
        dev = [abs(x - p["snr_dB"]) for x in snr]
        if dev and (max(dev) > (tol + 0.5 if hop else tol) or (hop and _median(dev) > tol + 0.15)):
            fails.append(f"{cell['id']} {e['id']}：预算信噪比偏离目标 {p['snr_dB']} dB，最大 {max(dev):.3f} dB")
        if any(a.get("cuav:capture") != "full" for a in mine3):
            fails.append(f"{cell['id']} {e['id']}：主辐射源在 S3 有不在可用频带里的注记")
        if not hop and any(a.get("cuav:capture") != "full" for a in mine4):
            fails.append(f"{cell['id']} {e['id']}：定频主辐射源在 S4 有不在可用频带里的注记")
        meas = [a["cuav:snr_measured_dB"] for a in mine3 if a.get("cuav:snr_measured_dB") is not None]
        # 开了衰落时逐段信噪比随衰落起伏：dB 值的中位数偏低（瑞利时中位功率只有均值的 ln 2），
        # 对链路预算（平均值）要比线性功率的均值
        mean_lin = (10 * math.log10(sum(10 ** (x / 10) for x in meas) / len(meas))) if meas else None
        plats.append({"platform": p["id"], "primary": e["id"], "snr_target_dB": p["snr_dB"],
                      "snr_budget_dB_median": _median(snr), "snr_measured_dB_median_s3": _median(meas),
                      "snr_measured_dB_mean_lin_s3": None if mean_lin is None else round(mean_lin, 4),
                      "snr_measured_n_s3": len(meas), "annotations_s3": len(mine3),
                      "s4_capture": {k: sum(1 for a in mine4 if a.get("cuav:capture") == k)
                                     for k in ("full", "partial", "none")}})
    fails += co_adjacent_check(doc, cell, plats)
    return fails, {"ops": ops, "platforms": plats}


def truth_rows_match(doc: dict, run_dir: str, pkg_data: str, res: list[dict]) -> list[str]:
    """S3 的注记与引擎写的真值（truth.jsonl）逐行对应：辐射源、起止样点、类别都相同（Q-6 的验收项）。

    样点号用导出工具的同一个 sample_at（与引擎 geo::sample_at 同式）；这里核的是「一行真值一条注记、
    没有多也没有少、内容对得上」，不是取整规则本身（那由导出工具的单测守着）。"""
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import iq_export_sigmf as X
    r3 = next(r for r in res if r["op_id"] == "s3")
    with open(os.path.join(pkg_data, r3["stem"] + ".sigmf-meta"), encoding="utf-8") as fh:
        meta = json.load(fh)
    fs = meta["global"]["core:sample_rate"]
    n = r3["samples"]
    site = doc["site"]["id"]
    want = []
    truth = os.path.join(run_dir, "truth.jsonl")
    with open(truth, encoding="utf-8") if os.path.exists(truth) else open(os.devnull, encoding="utf-8") as fh:
        for line in fh:                                  # 纯背景段没有发射，引擎不写 truth.jsonl：按零行
            t = json.loads(line)
            if t.get("site_id") not in (None, site):
                continue
            s0 = X.sample_at(t["t_s"], fs)
            s1 = min(X.sample_at(t["t_end_s"], fs), n)
            if s1 > s0:
                want.append((t.get("emitter_id"), s0, s1 - s0, t["label"]))
    got = [(a.get("cuav:emitter_id"), a["core:sample_start"], a["core:sample_count"], a["core:label"])
           for a in meta["annotations"]]
    if sorted(want, key=str) != sorted(got, key=str):
        miss = len(set(want) - set(got))
        extra = len(set(got) - set(want))
        return [f"{r3['stem']}：注记与真值不能逐行对应（真值有而注记没有 {miss} 行，注记有而真值没有 {extra} 行）"]
    return []


CO_ADJ_TOL_DB = 1.0


def co_adjacent_check(doc: dict, cell: dict, plats: list[dict]) -> list[str]:
    """标准算例 4（多信号同频及邻频叠加，D-083 并入 Q-6）：视距的同频与邻频段，每个平台在 S3 上的实测信噪比
    （线性平均，同时同频的突发不计）与链路预算之差不超过 1 dB。"""
    if cell.get("group", {}).get("preset_group") != "mxco" or cell["propagation"] != "los":
        return []
    out = []
    for p in plats:
        m, b = p["snr_measured_dB_mean_lin_s3"], p["snr_budget_dB_median"]
        if m is None or abs(m - b) > CO_ADJ_TOL_DB:
            out.append(f"{cell['id']} {p['primary']}：同频邻频叠加后实测 {m} dB 对预算 {b:.2f} dB，超过 {CO_ADJ_TOL_DB} dB")
    return out


def preview(data_path: str, meta: dict, png: str, title: str) -> None:
    """时频图预览（峰值保持）：读交付的 ci16 数据，1024 点 Hann，按时间分组取最大，dB 色标。"""
    import numpy as np
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    g = meta["global"]
    fs = g["core:sample_rate"]
    fc = meta["captures"][0]["core:frequency"]
    amp = 10 ** (g["cuav:full_scale_dBm"] / 20)
    raw = np.memmap(data_path, dtype="<i2", mode="r")
    nfft = 1024
    n_frames = raw.size // (2 * nfft)
    rows = min(600, n_frames)
    grp = n_frames // rows
    w = np.hanning(nfft)
    img = np.empty((rows, nfft))
    for r in range(rows):
        blk = np.asarray(raw[2 * nfft * grp * r: 2 * nfft * grp * (r + 1)], dtype=np.float64).reshape(grp, nfft, 2)
        z = (blk[..., 0] + 1j * blk[..., 1]) / 32768 * amp
        p = np.abs(np.fft.fftshift(np.fft.fft(z * w, axis=1), axes=1)) ** 2 / (np.sum(w) ** 2)
        img[r] = 10 * np.log10(np.max(p, axis=0) + 1e-30)
    t1 = rows * grp * nfft / fs
    fig, ax = plt.subplots(figsize=(8, 5), dpi=100)
    hi = float(np.percentile(img, 99.9))
    lo = float(np.percentile(img, 5)) - 5
    ax.imshow(img, aspect="auto", origin="upper", cmap="viridis", vmin=lo, vmax=hi,
              extent=[(fc - fs / 2) / 1e6, (fc + fs / 2) / 1e6, t1, 0])
    ax.set_xlabel("Frequency (MHz)")
    ax.set_ylabel("Time (s)")
    ax.set_title(title)
    fig.colorbar(ax.images[0], ax=ax, label="dBm (peak hold)")
    fig.tight_layout()
    fig.savefig(png, metadata={"Software": None})
    plt.close(fig)


def run_cell(doc: dict, cell: dict, base: str, keep_runs: bool) -> dict:
    import shutil
    import time
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import iq_export_sigmf as X
    files = prepare_cell(doc, cell, base)
    sid = S.scenario_id(doc, cell)
    pkg_data = os.path.join(base, "package", "data")
    os.makedirs(pkg_data, exist_ok=True)
    run_dir = os.path.join(ROOT, "data", "runs", f"eval-{doc['set_id']}-{cell['id']}")
    shutil.rmtree(run_dir, ignore_errors=True)
    t0 = time.time()
    p = subprocess.run([_engine(), "--run", files["diagram"], "--out", os.path.relpath(run_dir, ROOT),
                        "--task-id", f"eval-{doc['set_id']}-{cell['id']}", "--scenario", files["scenario"],
                        "--library-root", "models/recognition"], cwd=ROOT, capture_output=True, text=True)
    wall = time.time() - t0
    if p.returncode != 0:
        raise SystemExit(f"{cell['id']}：cuav_run 退出码 {p.returncode}：{p.stderr.strip()[-800:]}")
    shutil.copy(os.path.join(ROOT, files["diagram"]), os.path.join(run_dir, "diagram.json"))
    for f in os.listdir(pkg_data):
        if f.startswith(sid + "_"):
            os.remove(os.path.join(pkg_data, f))
    res = X.export_run(run_dir, pkg_data, ops=["s3", "s4"], stem_prefix=sid,
                       scenario_path=os.path.join(ROOT, files["scenario"]))
    X.validate_with_sigmf(pkg_data, [r["stem"] for r in res])
    fails, summ = check_cell(doc, cell, res, pkg_data)
    fails += truth_rows_match(doc, run_dir, pkg_data, res)
    if not keep_runs:
        shutil.rmtree(run_dir, ignore_errors=True)
    prev_dir = os.path.join(base, "package", "previews")
    os.makedirs(prev_dir, exist_ok=True)
    out_ops = []
    for r in res:
        meta = summ["ops"][r["op_id"]]["meta"]
        g = meta["global"]
        png = os.path.join(prev_dir, f"{r['stem']}.png")
        preview(os.path.join(pkg_data, r["stem"] + ".sigmf-data"), meta, png,
                f"{sid} {g['cuav:observation_point']}  {g['core:sample_rate'] / 1e6:g} MS/s @ "
                f"{meta['captures'][0]['core:frequency'] / 1e6:g} MHz")
        out_ops.append({
            "op_id": r["op_id"], "point": g["cuav:observation_point"], "stem": r["stem"],
            "sample_rate_Hz": g["core:sample_rate"], "center_Hz": meta["captures"][0]["core:frequency"],
            "samples": r["samples"], "duration_s": r["samples"] / g["core:sample_rate"],
            "usable_band_Hz": g["cuav:usable_band_Hz"], "state": g["cuav:quality"]["state"],
            "lossless": r["lossless"], "requant_margin_dB": r["requant_margin_dB"],
            "annotations": r["annotations"], "capture": summ["ops"][r["op_id"]]["capture"],
            "presets_version": g.get("cuav:presets_version"),
            "files": [{"name": f"data/{r['stem']}{ext}", "bytes": os.path.getsize(os.path.join(pkg_data, r["stem"] + ext)),
                       "sha256": _sha(os.path.join(pkg_data, r["stem"] + ext)),
                       "sha512": _sha(os.path.join(pkg_data, r["stem"] + ext), "sha512")} for ext in DELIVER_EXT]
                     + [{"name": f"previews/{r['stem']}.png", "bytes": os.path.getsize(png), "sha256": _sha(png),
                         "sha512": _sha(png, "sha512")}],
        })
    rec = {"id": cell["id"], "title": cell["title"], "receiver": cell["receiver"],
           "propagation": cell["propagation"], "s4": cell["s4"],
           "presets": sorted({e["preset"] for pl in cell["platforms"] for e in pl["emitters"] if "preset" in e}),
           "scenario_id": sid, "scenario_sha256": _sha(os.path.join(ROOT, files["scenario"])),
           "diagram_sha256": _sha(os.path.join(ROOT, files["diagram"])),
           "seeds": {"run": S.seeds.derive(*C.seed_basis(doc, cell), "run"),
                     "scenario": S.seeds.derive(*C.seed_basis(doc, cell), "scenario")},
           "platforms": summ["platforms"], "ops": out_ops,
           "wall_s": round(wall, 1), "realtime_factor": round(C.duration_s(doc, cell) / wall, 4)}
    return {"record": rec, "fails": fails, "files": files}


def presets_summary(records: list[dict]) -> str:
    """各段 S3 元数据里的 cuav:presets_version 合起来，如「OFDM 族 v2，GFSK 族 v1」。"""
    seen: dict = {}
    for r in records:
        for o in r["ops"]:
            for k, v in (o.get("presets_version") or {}).items():
                seen.setdefault(k, set()).add(v)
    name = {"ofdm": "OFDM 族", "gfsk": "GFSK 族"}
    return "，".join(f"{name.get(k, k)} {'/'.join(sorted(v))}" for k, v in sorted(seen.items())) or "—"


def sample_relation(doc: dict, records: list[dict]) -> dict | None:
    """seed_from 的格子与来源集合同一格的数据文件是否逐字节相同（按两边清单里记的 sha256 比）。"""
    out = {"identical": [], "different": []}
    by_id = {r["id"]: r for r in records}
    cache: dict = {}
    for c in doc["cells"]:
        sf = c.get("seed_from")
        if not sf or c["id"] not in by_id:
            continue
        if sf["set"] not in cache:
            with open(os.path.join(out_dir(sf["set"]), "dataset.manifest.json"), encoding="utf-8") as fh:
                cache[sf["set"]] = {r["id"]: r for r in json.load(fh)["cells"]}
        src = cache[sf["set"]][sf["cell"]]
        mine = {o["op_id"]: next(f["sha256"] for f in o["files"] if f["name"].endswith(".sigmf-data")) for o in by_id[c["id"]]["ops"]}
        theirs = {o["op_id"]: next(f["sha256"] for f in o["files"] if f["name"].endswith(".sigmf-data")) for o in src["ops"]}
        key = "identical" if mine == theirs else "different"
        item = {"segment": S.scenario_id(doc, c), "sample_segment": src["scenario_id"],
                "presets": sorted({x for x in by_id[c["id"]]["presets"]})}
        if key == "different":
            item.update(_annotation_diff(os.path.join(out_dir(doc["set_id"]), "package", "data", f"{item['segment']}_s3.sigmf-meta"),
                                         os.path.join(out_dir(sf["set"]), "package", "data", f"{item['sample_segment']}_s3.sigmf-meta")))
        out[key].append(item)
    return out if (out["identical"] or out["different"]) else None


def _annotation_diff(meta_a: str, meta_b: str) -> dict:
    """两份 S3 元数据的注记比对：条数、（辐射源, 起点, 类别）是否逐条相同、长度不同的条数与差值范围（样点）。"""
    def rows(path):
        with open(path, encoding="utf-8") as fh:
            m = json.load(fh)
        return [(a.get("cuav:emitter_id"), a["core:sample_start"], a["core:label"], a["core:sample_count"])
                for a in m["annotations"]]
    a, b = rows(meta_a), rows(meta_b)
    ka = {x[:3]: x[3] for x in a}
    kb = {x[:3]: x[3] for x in b}
    common = sorted(set(ka) & set(kb))
    d = [ka[k] - kb[k] for k in common if ka[k] != kb[k]]
    # 预设 v2 每 7 个符号放一个长循环前缀，15 / 30 符号的突发长 1.04 / 2.08 µs（80 MS/s 下 83 / 166 个样点）：
    # 0 < 差 ≤ 200 个样点算「循环前缀排布」；其余是时隙抽取结果不同（如长突发变短突发）
    cp = [x for x in d if 0 < x <= 200]
    other = [x for x in d if not 0 < x <= 200]
    return {"annotations": [len(a), len(b)], "same_starts": set(ka) == set(kb), "common": len(common),
            "only_here": len(set(ka) - set(kb)), "only_source": len(set(kb) - set(ka)),
            "length_changed": len(d), "cp_longer": len(cp), "cp_delta_samples": [min(cp), max(cp)] if cp else None,
            "draw_changed": len(other)}


def snr_diff_distribution(doc: dict, base: str, records: list[dict]) -> dict:
    """主辐射源逐条注记的「数据实测带内信噪比 − 链路预算带内信噪比」（S3，dB），按传播分组给分位数。
    实测为 null 的注记（同时同频、跨越或不在可用频带）不计。14 §10.1 的 Q-6 验收项：分布写进数据说明。"""
    cells = {c["id"]: c for c in doc["cells"]}
    groups: dict = {"los": [], "nlos": []}
    for r in records:
        c = cells[r["id"]]
        prim = {p["primary"] for p in c["platforms"] if not p.get("off")}
        if not prim:
            continue
        stem = next(o["stem"] for o in r["ops"] if o["op_id"] == "s3")
        with open(os.path.join(base, "package", "data", stem + ".sigmf-meta"), encoding="utf-8") as fh:
            ann = json.load(fh)["annotations"]
        for a in ann:
            if a.get("cuav:emitter_id") in prim and a.get("cuav:snr_measured_dB") is not None:
                groups[c["propagation"]].append(a["cuav:snr_measured_dB"] - a["cuav:snr_dB"])

    def q(xs: list[float], f: float) -> float:
        xs = sorted(xs)
        k = f * (len(xs) - 1)
        i = int(math.floor(k))
        return xs[i] + (xs[min(i + 1, len(xs) - 1)] - xs[i]) * (k - i)

    return {k: ({"n": len(v), "p05": round(q(v, 0.05), 2), "p25": round(q(v, 0.25), 2), "median": round(q(v, 0.5), 2),
                 "p75": round(q(v, 0.75), 2), "p95": round(q(v, 0.95), 2)} if v else {"n": 0})
            for k, v in groups.items()}


def verify_random(doc: dict, base: str, share: float) -> dict:
    """随机抽 share 比例的格子（至少一格，按集合种子抽、可复现）重跑并逐字节比对（Q-6 的验收项）。"""
    import random
    ids = [c["id"] for c in doc["cells"]]
    n = max(1, math.ceil(share * len(ids)))
    pick = sorted(random.Random(doc["set_seed"]).sample(ids, n), key=ids.index)
    bad = {}
    for cid in pick:
        b = verify_cell(doc, cid, base)
        if b:
            bad[cid] = b
    return {"share": share, "seed": doc["set_seed"], "cells": pick, "mismatched": bad}


def _write_package_extras(doc: dict, base: str, records: list[dict], state: dict, extra: dict | None = None) -> None:
    """数据手册与读取示例（tools/eval_dataset/ 的入库源文件）、甲方用的 index.json、SHA512SUMS、内部清单。"""
    import shutil
    pkg = os.path.join(base, "package")
    src = os.path.join(ROOT, "tools", "eval_dataset")
    if os.path.isdir(src):
        ex = os.path.join(pkg, "examples")
        os.makedirs(ex, exist_ok=True)
        for f in sorted(os.listdir(os.path.join(src, "examples"))):
            shutil.copy(os.path.join(src, "examples", f), os.path.join(ex, f))
        from eval_dataset import readme
        with open(os.path.join(pkg, "README.md"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(readme.render(doc, records, {"engine_version": state.get("engine_version"), **(extra or {})}))
    client = {"schema_version": "cuav-eval-dataset-index/1", "set_id": doc["set_id"], "name": doc["name"],
              "duration_s": doc["duration_s"],
              "segments": [{"id": r["id"], "title": r["title"], "receiver": r["receiver"],
                            "propagation": r["propagation"], "presets": r["presets"], "platforms": [
                                {k: p[k] for k in ("platform", "primary", "snr_target_dB")} for p in r["platforms"]],
                            "files": [{k: o[k] for k in ("point", "stem", "sample_rate_Hz", "center_Hz", "samples",
                                                          "usable_band_Hz", "annotations")} for o in r["ops"]]}
                           for r in records]}
    with open(os.path.join(pkg, "index.json"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(client, ensure_ascii=False, indent=2) + "\n")
    lines = []
    for dirpath, _, fnames in os.walk(pkg):
        for f in fnames:
            rel = os.path.relpath(os.path.join(dirpath, f), pkg).replace(os.sep, "/")
            if rel != "SHA512SUMS" and not is_mac_junk(rel):
                lines.append(f"{_sha(os.path.join(dirpath, f), 'sha512')}  {rel}")
    with open(os.path.join(pkg, "SHA512SUMS"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(sorted(lines, key=lambda l: l.split("  ", 1)[1])) + "\n")
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import iq_export_sigmf as X
    manifest = {"schema_version": "cuav-eval-dataset-manifest/1", "set_id": doc["set_id"],
                "cells_file": os.path.relpath(C.path_of(doc["set_id"]), ROOT).replace(os.sep, "/"),
                "cells_sha256": _sha(C.path_of(doc["set_id"])), "git": state["git"],
                "cuav_run_sha256": state["engine_sha256"], "engine_version": state["engine_version"],
                "exporter": f"tools/iq_export_sigmf.py {X.VERSION}", "sigmf_version": X.SIGMF_VERSION,
                "package_bytes": sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(pkg) for f in fs
                                     if not is_mac_junk(os.path.relpath(os.path.join(d, f), pkg).replace(os.sep, "/"))),
                "cells": records,
                **({k: (extra or {})[k] for k in ("presets_version", "verify", "sample_relation", "snr_diff", "docs")
                    if (extra or {}).get(k)}),
                "reproduce": [f"uv run --quiet --with numpy --with sigmf --with matplotlib python scripts/gen_eval_dataset.py run --set {doc['set_id']}"]}
    with open(os.path.join(base, "dataset.manifest.json"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


def cmd_run(a) -> int:
    import shutil
    doc = C.load(a.set)
    base = os.path.join(ROOT, a.root) if a.root else out_dir(doc["set_id"])
    free_gb = shutil.disk_usage(ROOT).free / 1e9
    if free_gb < FREE_MIN_GB:
        raise SystemExit(f"磁盘余量 {free_gb:.0f} GB，不到 {FREE_MIN_GB} GB")
    gs = git_state()
    if gs["dirty"] and not a.allow_dirty:
        raise SystemExit(f"这些目录有未提交的改动，生成的数据对不上任何一个提交：{gs['dirty_paths'][:8]}（--allow-dirty 跳过）")
    cat = json.loads(subprocess.run([_engine(), "--catalog"], capture_output=True, text=True, check=True).stdout)
    state = {"git": gs, "engine_sha256": _sha(_engine()), "engine_version": cat["engine_version"]}
    if a.verify:
        return verify(doc, a.verify, base)
    records, fails = [], []
    for cell in _pick(doc, a.cells):
        out = run_cell(doc, cell, base, a.keep_runs)
        r = out["record"]
        records.append(r)
        fails += out["fails"]
        ps = "；".join(f"{p['primary']} 预算 {p['snr_budget_dB_median']:.2f} / 实测中位 "
                      f"{'—' if p['snr_measured_dB_median_s3'] is None else format(p['snr_measured_dB_median_s3'], '.2f')}"
                      f" / 实测线性均值 {'—' if p['snr_measured_dB_mean_lin_s3'] is None else format(p['snr_measured_dB_mean_lin_s3'], '.2f')} dB"
                      for p in r["platforms"]) or "无辐射源"
        print(f"{cell['id']}：{len(r['ops'])} 个观测点，墙钟 {r['wall_s']} s（实时因子 {r['realtime_factor']}）；{ps}"
              + ("" if not out["fails"] else f"；失败 {out['fails']}"), flush=True)
    if a.cells:
        print("只跑了部分格子：不写数据集清单与交付件")
    else:
        extra: dict = {}
        if doc.get("purpose") == "formal":
            extra["presets_version"] = presets_summary(records)
            extra["sample_relation"] = sample_relation(doc, records)
            extra["snr_diff"] = snr_diff_distribution(doc, base, records)
            print(f"随机抽 {a.verify_share:.0%} 重跑比对 …", flush=True)
            extra["verify"] = verify_random(doc, base, a.verify_share)
            for cid, b in extra["verify"]["mismatched"].items():
                fails.append(f"{cid}：重跑与交付件不同：{b}")
        _write_package_extras(doc, base, records, state, extra)
        print(f"交付件在 {os.path.relpath(os.path.join(base, 'package'), ROOT)}；内部清单 "
              f"{os.path.relpath(os.path.join(base, 'dataset.manifest.json'), ROOT)}")
    if fails:
        print(f"断言失败 {len(fails)} 项：")
        for f in fails:
            print(f"  {f}")
        return 1
    return 0


def cmd_rerender(a) -> int:
    """只重出说明类交付件（README、index.json、SHA512SUMS 与内部清单），不重跑数据（同 D-101 的做法）。

    生成时的提交、引擎哈希与各段记录照抄清单；另记 `docs.commit`（重出说明时的提交）。数据文件、元数据、
    链路文件与预览图一个字节不动，重出后整包对 SHA512SUMS 全部核对一遍。"""
    doc = C.load(a.set)
    base = out_dir(doc["set_id"])
    with open(os.path.join(base, "dataset.manifest.json"), encoding="utf-8") as fh:
        man = json.load(fh)
    state = {"git": man["git"], "engine_sha256": man["cuav_run_sha256"], "engine_version": man["engine_version"]}
    extra = {k: man[k] for k in ("presets_version", "verify", "sample_relation", "snr_diff") if k in man}
    if doc.get("purpose") == "formal":
        extra["snr_diff"] = snr_diff_distribution(doc, base, man["cells"])
        extra["sample_relation"] = sample_relation(doc, man["cells"])
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    extra["docs"] = {"commit": head, "note": "说明类交付件（README、index.json、SHA512SUMS）按这一提交重出；数据未重新生成"}
    before = {f["name"]: f["sha512"] for r in man["cells"] for o in r["ops"] for f in o["files"]}
    _write_package_extras(doc, base, man["cells"], state, extra)
    pkg = os.path.join(base, "package")
    bad = [n for n, h in before.items() if _sha(os.path.join(pkg, n), "sha512") != h]
    if bad:
        raise SystemExit(f"重出说明时数据文件变了：{bad[:5]}")
    print(f"重出 {os.path.relpath(pkg, ROOT)} 的 README、index.json 与 SHA512SUMS；{len(before)} 个数据与预览文件未变")
    return 0


def verify(doc: dict, cell_id: str, base: str) -> int:
    """重跑一格到临时目录，逐字节比对交付的数据、元数据、链路旁挂与预览图。"""
    return 0 if not verify_cell(doc, cell_id, base) else 1


def verify_cell(doc: dict, cell_id: str, base: str) -> list[str]:
    """重跑一格，返回与交付件不同的文件名（空表即逐字节相同）。"""
    import filecmp
    import shutil
    cell = _pick(doc, cell_id)[0]
    tmp = os.path.join(ROOT, "data", "tmp", f"eval-verify-{doc['set_id']}")
    shutil.rmtree(tmp, ignore_errors=True)
    out = run_cell(doc, cell, tmp, keep_runs=False)
    bad = []
    for o in out["record"]["ops"]:
        for f in o["files"]:
            a, b = os.path.join(base, "package", f["name"]), os.path.join(tmp, "package", f["name"])
            if not os.path.exists(a) or not filecmp.cmp(a, b, shallow=False):
                bad.append(f["name"])
    shutil.rmtree(tmp, ignore_errors=True)
    n = sum(len(o["files"]) for o in out["record"]["ops"])
    print(f"重跑 {cell_id}：{n} 个文件" + ("逐字节相同" if not bad else f"，不同：{bad}"), flush=True)
    return bad


def cmd_pack(a) -> int:
    """把交付包打成一个 zip，供转交甲方（用户 2026-10-10「先把试样集打个包」）。

    1. 交付包对自己的 SHA512SUMS 全量核对：清单里的每个文件都在、哈希都对，包里也没有清单外的文件；
    2. 文件名纯 ASCII（铁律 15），文本文件里没有本机路径（铁律 17，正则与单机包同一条）；
    3. 用单机包同一个 `deploy/pack.py` 的 write_zip 出确定性 zip：条目按路径排序、时间戳取交付包入库文件最后一次提交的时间、
       权限位固定，已压缩的格式（png）不再压；同一输入两次出包逐字节相同；
    4. 重新打开 zip，逐个条目按 SHA512SUMS 再核一遍，再给 zip 本身写一个 `.sha512` 旁挂。

    zip 与旁挂写在 data/eval/<集合>/ 下（不入 git）。交付包的入库文件（README、内部清单）有未提交改动即拒。"""
    import datetime as dt
    import hashlib
    import zipfile
    from pathlib import Path
    sys.path.insert(0, os.path.join(ROOT, "deploy"))
    import pack as P
    base = Path(ROOT) / "data" / "eval" / a.set
    pkg = base / "package"
    tracked = [str(p.relative_to(ROOT)) for p in (pkg / "README.md", base / "dataset.manifest.json")]
    st = subprocess.run(["git", "status", "--porcelain", "--", *tracked], cwd=ROOT, capture_output=True, text=True).stdout
    if st.strip():
        raise SystemExit(f"交付包的入库文件有未提交改动，先提交再打包：\n{st}")
    when_s = subprocess.run(["git", "log", "-1", "--format=%ct", "--", *tracked], cwd=ROOT, capture_output=True,
                            text=True).stdout.strip()
    if not when_s:
        raise SystemExit("交付包的入库文件还没有提交过")
    when = dt.datetime.fromtimestamp(int(when_s), dt.timezone.utc)

    sums = {}
    for line in (pkg / "SHA512SUMS").read_text(encoding="utf-8").splitlines():
        if line.strip():
            h, rel = line.split("  ", 1)
            sums[rel] = h
    junk = sorted(p.relative_to(pkg).as_posix() for p in pkg.rglob("*") if is_mac_junk(p.relative_to(pkg).as_posix()))
    if junk:
        print(f"跳过 macOS 元数据（不进 zip）：{junk}")
    on_disk = sorted(p.relative_to(pkg).as_posix() for p in pkg.rglob("*")
                     if p.is_file() and not is_mac_junk(p.relative_to(pkg).as_posix()))
    extra = sorted(set(on_disk) - set(sums) - {"SHA512SUMS"})
    missing = sorted(set(sums) - set(on_disk))
    if extra or missing:
        raise SystemExit(f"交付包与 SHA512SUMS 不一致：清单外 {extra}，缺 {missing}")
    bad = [rel for rel in sorted(sums) if _sha(str(pkg / rel), "sha512") != sums[rel]]
    if bad:
        raise SystemExit(f"这些文件的 SHA-512 与 SHA512SUMS 不符：{bad}")
    nonascii = [rel for rel in on_disk if not rel.isascii()]
    if nonascii:
        raise SystemExit(f"文件名不是纯 ASCII：{nonascii}")
    leak = [rel for rel in on_disk if Path(rel).suffix.lower() in P.TEXT_EXT | {".jsonl", ".sigmf-meta", ".m", ".py"}
            and P.MACHINE_PATH.search((pkg / rel).read_text(encoding="utf-8", errors="replace"))]
    if leak:
        raise SystemExit(f"这些文件里有本机路径：{leak}")
    print(f"交付包核对通过：{len(on_disk)} 个文件，SHA-512 全部与 SHA512SUMS 相符，文件名纯 ASCII，没有本机路径")

    stage = P.Stage(pkg)
    for rel in on_disk:
        stage.files[rel] = ((pkg / rel).stat().st_size, "")
    stage.dirs = {p.relative_to(pkg).as_posix() for p in pkg.rglob("*")
                  if p.is_dir() and not is_mac_junk(p.relative_to(pkg).as_posix())}
    name = f"cuav-eval-{a.set}"
    zpath = P.write_zip(stage, name, when, base)

    n = 0
    with zipfile.ZipFile(zpath) as zf:
        for zi in zf.infolist():
            if is_mac_junk(zi.filename.rstrip("/")):
                raise SystemExit(f"zip 里有 macOS 元数据条目：{zi.filename}")
            if zi.is_dir():
                continue
            rel = zi.filename[len(name) + 1:]
            h = hashlib.sha512()
            with zf.open(zi) as fh:
                for b in iter(lambda: fh.read(1 << 20), b""):
                    h.update(b)
            if rel != "SHA512SUMS" and h.hexdigest() != sums.get(rel):
                raise SystemExit(f"zip 里的 {rel} 与 SHA512SUMS 不符")
            n += 1
    if n != len(on_disk):
        raise SystemExit(f"zip 里有 {n} 个文件，交付包有 {len(on_disk)} 个")
    zsha = _sha(str(zpath), "sha512")
    (base / f"{name}.zip.sha512").write_text(f"{zsha}  {name}.zip\n", encoding="utf-8")
    print(f"写了 {zpath.relative_to(ROOT)}：{zpath.stat().st_size} 字节（交付包 {sum(stage.files[r][0] for r in on_disk)} 字节），"
          f"{n} 个文件逐个按 SHA512SUMS 复核通过；时间戳 {when.strftime('%Y-%m-%dT%H:%M:%SZ')}")
    print(f"zip 的 SHA-512 写在 {(base / f'{name}.zip.sha512').relative_to(ROOT)}：{zsha[:16]}…")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve", help="解算平台位置并量前端非理想，冻结回格子文件")
    r.add_argument("--set", required=True)
    r.add_argument("--cells", help="只解这些格子（逗号分隔）")
    r.add_argument("--frontend", action="store_true", help="重新量前端非理想（缺省只在还没量过时量）")
    r.add_argument("--missing-only", action="store_true", help="只解还没有位置的平台（正式集一百多格，分批解）")
    r.set_defaults(func=cmd_resolve)
    m = sub.add_parser("matrix", help="展开正式集的格子文件（Q-6）")
    m.add_argument("--set", required=True)
    m.set_defaults(func=cmd_matrix)
    p = sub.add_parser("prepare", help="写场景、链路规格与框图并 --validate")
    p.add_argument("--set", required=True)
    p.add_argument("--cells")
    p.set_defaults(func=cmd_prepare)
    q = sub.add_parser("run", help="逐格运行、导出、断言，写交付件与数据集清单")
    q.add_argument("--set", required=True)
    q.add_argument("--cells", help="只跑这些格子（逗号分隔；不写清单与交付件）")
    q.add_argument("--root", help="输出根目录（仓库相对；缺省 data/eval/<集合>）")
    q.add_argument("--keep-runs", action="store_true", help="保留 data/runs/ 里的运行目录")
    q.add_argument("--allow-dirty", action="store_true", help="允许生成器相关目录有未提交改动")
    q.add_argument("--verify", metavar="CELL", help="重跑一格到临时目录、逐字节比对交付件")
    q.add_argument("--verify-share", type=float, default=0.05,
                   help="正式集：整集生成后随机抽这一比例的格子重跑比对（缺省 0.05，按集合种子抽）")
    q.set_defaults(func=cmd_run)
    rr = sub.add_parser("rerender", help="只重出 README、index.json 与 SHA512SUMS（不重跑数据）")
    rr.add_argument("--set", required=True)
    rr.set_defaults(func=cmd_rerender)
    k = sub.add_parser("pack", help="核对交付包并打成确定性 zip（供转交）")
    k.add_argument("--set", required=True)
    k.set_defaults(func=cmd_pack)
    a = ap.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
