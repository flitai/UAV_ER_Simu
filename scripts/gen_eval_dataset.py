#!/usr/bin/env python3
"""评测数据集生成（试样集，D-092；14 号报告 §8.3）。

格子文件 tests/regression/eval-dataset/<集合>.json 写意图（接收配置、传播、S4、平台与辐射源、信噪比目标）。
三个子命令：

  resolve   编写步骤：解算平台位置（视距按 cuav_run --field 迭代到 0.01 dB，非视距按环搜索），
            量接收机 IQ 不平衡与直流（DroneRFb 训练部分的背景，M 档），冻结回格子文件。输出要审阅并提交。
  prepare   每格写场景与链路规格，经 web/src/chain/examples/_gen.ts eval 编译成框图（往返逐字节、频率计划对放行表），
            再用 cuav_run --validate 核一遍；不跑引擎。
  run       prepare 之后逐格运行 cuav_run、导出 S3 与 S4 的 SigMF、做断言、删运行目录，最后写数据集索引与交付件。

输出在 data/eval/<集合>/（不入 git，只有 *.manifest.json 与 *.md 入库，见 .gitignore）。

跑法：
    uv run --quiet --with numpy --with scipy python scripts/gen_eval_dataset.py resolve --set sample-v1
    uv run --quiet --with numpy python scripts/gen_eval_dataset.py prepare --set sample-v1
    uv run --quiet --with numpy --with sigmf --with matplotlib python scripts/gen_eval_dataset.py run --set sample-v1
"""
from __future__ import annotations

import argparse
import json
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
        R.resolve_cell(doc, cell)
        for p in cell["platforms"]:
            r = p["resolved"]
            extra = "" if p.get("off") else (f"，预算信噪比 {r['snr_budget_dB']} dB（目标 {p['snr_dB']}），路损 {r['path_loss_dB']} dB，"
                                            f"刀口 {r['diffraction_dB']} dB，{'视距' if r['line_of_sight'] else '非视距'}")
            print(f"{cell['id']} {p['id']}：方位 {r['azimuth_deg']}°、水平 {r['range_m']} m{extra}")
    C.save(doc)
    print(f"已写回 {os.path.relpath(C.path_of(a.set), ROOT)}：审阅后提交")
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
    for cell in _pick(doc, a.cells):
        files = prepare_cell(doc, cell)
        print(f"{cell['id']}：{files['diagram']}（--validate 通过）")
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
        plats.append({"platform": p["id"], "primary": e["id"], "snr_target_dB": p["snr_dB"],
                      "snr_budget_dB_median": _median(snr), "snr_measured_dB_median_s3": _median(meas),
                      "snr_measured_n_s3": len(meas), "annotations_s3": len(mine3),
                      "s4_capture": {k: sum(1 for a in mine4 if a.get("cuav:capture") == k)
                                     for k in ("full", "partial", "none")}})
    return fails, {"ops": ops, "platforms": plats}


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
           "seeds": {"run": S.seeds.derive(doc["set_seed"], cell["id"], "run"),
                     "scenario": S.seeds.derive(doc["set_seed"], cell["id"], "scenario")},
           "platforms": summ["platforms"], "ops": out_ops,
           "wall_s": round(wall, 1), "realtime_factor": round(doc["duration_s"] / wall, 4)}
    return {"record": rec, "fails": fails, "files": files}


def _write_package_extras(doc: dict, base: str, records: list[dict], state: dict) -> None:
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
            fh.write(readme.render(doc, records))
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
            if rel != "SHA512SUMS":
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
                "package_bytes": sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(pkg) for f in fs),
                "cells": records,
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
        ps = "；".join(f"{p['primary']} 预算 {p['snr_budget_dB_median']:.2f} / 实测 "
                      f"{'—' if p['snr_measured_dB_median_s3'] is None else format(p['snr_measured_dB_median_s3'], '.2f')} dB"
                      for p in r["platforms"]) or "无辐射源"
        print(f"{cell['id']}：{len(r['ops'])} 个观测点，墙钟 {r['wall_s']} s（实时因子 {r['realtime_factor']}）；{ps}"
              + ("" if not out["fails"] else f"；失败 {out['fails']}"), flush=True)
    if a.cells:
        print("只跑了部分格子：不写数据集清单与交付件")
    else:
        _write_package_extras(doc, base, records, state)
        print(f"交付件在 {os.path.relpath(os.path.join(base, 'package'), ROOT)}；内部清单 "
              f"{os.path.relpath(os.path.join(base, 'dataset.manifest.json'), ROOT)}")
    if fails:
        print(f"断言失败 {len(fails)} 项：")
        for f in fails:
            print(f"  {f}")
        return 1
    return 0


def verify(doc: dict, cell_id: str, base: str) -> int:
    """重跑一格到临时目录，逐字节比对交付的数据、元数据、链路旁挂与预览图。"""
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
    print(f"重跑 {cell_id}：{n} 个文件" + ("逐字节相同" if not bad else f"，不同：{bad}"))
    return 0 if not bad else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve", help="解算平台位置并量前端非理想，冻结回格子文件")
    r.add_argument("--set", required=True)
    r.add_argument("--cells", help="只解这些格子（逗号分隔）")
    r.add_argument("--frontend", action="store_true", help="重新量前端非理想（缺省只在还没量过时量）")
    r.set_defaults(func=cmd_resolve)
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
    q.set_defaults(func=cmd_run)
    a = ap.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
