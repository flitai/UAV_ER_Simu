#!/usr/bin/env python3
"""识别库 v2 的校准调查（Q-4c，D-094；14 号报告 §8.6「区间从哪来」）。

只在**校准集**上取数：格子文件 tests/regression/eval-dataset/calib-v1.json（单源格，每个预设一格，信噪比 10 / 20 / 30 dB）
加 golden-01 / 02 / 03 开分子带（旧合成波形的模板用）。**不碰试样集**——试样集只用来评价。

每格跑两种链路：
  wb  宽带：DDC 旁路，检测器吃 S3 的全带（80 MS/s），与 Q-4b 回归的宽带版本同一构造；
  s4  交付链路：格子文件写的 DDC（S4 的 20 / 40 / 80 MS/s）。
检测器开分子带（格子文件 chain.det 的 subband_bins = 8），特征提取改成分子带口径（basis = subband），
识别器从框图里拿掉——调查只要特征，不让一份还不存在的库参与。

特征行怎么归到模板：用评价器的 segments_tf 配对（evaluate.tf_segments 的 detail），分子带段号 → 配上的真值行 →
该行的预设（preset_id）或波形 → 模板 id（PRESET_TEMPLATE / legacy_template）。没配上真值的段（虚警、碎片）不进统计；
只取 quality = full 的行。

输出 models/recognition/v2-calibration.json：每个模板、每个特征的可用比例与分位数（p2.5 / p50 / p97.5 / 最小 / 最大，
线性插值），以及调查用到的格子与引擎二进制的 sha256（只作留档，--check 不比它）。不写时间戳、墙钟与 git 提交
（写了提交号，这份文件一入库 --check 就再也过不了）：两次运行逐字节相同。

用法（约 6 分钟、4 进程；运行目录在 data/tmp/q4c-calib/，跑完即删）：
    uv run --quiet --with numpy python algos/reference/q4c_feature_survey.py
    uv run --quiet --with numpy python algos/reference/q4c_feature_survey.py --check   # 只核对入库的统计表与重跑结果逐字节相同
    uv run --quiet --with numpy python algos/reference/q4c_feature_survey.py --with-library v2   # 校准集内的自检，只报数
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import evaluate as EV  # noqa: E402
from eval_dataset import cells as C  # noqa: E402
from eval_dataset import scenario as S  # noqa: E402

CUAV_RUN = os.environ.get("CUAV_RUN", os.path.join(ROOT, "engine", "build", "cuav_run"))
SET_ID = "calib-v1"
TMP = os.path.join("data", "tmp", "q4c-calib")
OUT = os.path.join("models", "recognition", "v2-calibration.json")
FEATURES = ["bandwidth_Hz", "duration_s", "spectral_flatness", "hop_from_prev_Hz", "interval_from_prev_s"]
QUANTILES = (2.5, 50.0, 97.5)

# 预设 → v2 模板（14 §8.6 的模板表）
PRESET_TEMPLATE = {
    "dji-video-10m": "ofdm_video", "dji-video-20m-a": "ofdm_video", "dji-video-20m-c": "ofdm_video",
    "dji-video-40m": "ofdm_video",
    "dji-uplink-1m": "ofdm_uplink", "dji-uplink-2m": "ofdm_uplink", "dji-uplink-4m": "ofdm_uplink",
    "dji-droneid": "droneid",
    "frsky-d16v2-fcc": "gfsk_fhss", "futaba-sfhss": "gfsk_fhss",
}
# 旧合成波形：golden 场景开分子带（14 §8.6：它们本来就是编的波形，自洽而已）
LEGACY = [
    ("golden-01", "golden-01.default", None),
    ("golden-02", "golden-02.subband", "tests/regression/diagrams/chain-golden-02-subband.json"),
    ("golden-03", "golden-03.3x3", "tests/regression/diagrams/chain-3x3-aoa.json"),
]
SUBBAND_BINS = 8


def legacy_template(t: dict) -> str | None:
    """旧合成波形的真值行 → 模板 id：单音 / 定频突发 / 跳频突发 / 带限噪声图传。"""
    lab = t.get("label")
    return {"cw_beacon": "tone", "telemetry_burst": "burst_fixed", "rc_hopping": "burst_hopping",
            "video_link": "noise_video"}.get(lab)


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


LIBRARY: str | None = None    # --with-library：保留识别器、按这个库版本识别（校准集内的自检），缺省拿掉识别器
REC_PARAMS: dict = {}         # --accept-threshold 等：自检时识别器的判决参数（14 §8.6「判决参数」只许在校准集上量）


def patch_diagram(doc: dict) -> dict:
    """检测器开分子带、特征与评价改分子带口径；识别器缺省拿掉（与它相连的边一并拿掉），--with-library 时留下并指定库。"""
    for n in doc["nodes"]:
        if n["type"] == "EnergyDetector":
            n["params"]["subband_bins"] = SUBBAND_BINS
        if n["type"] in ("FeatureExtractor", "Evaluator"):
            n["params"]["basis"] = "subband"
        if n["type"] == "TemplateClassifier" and LIBRARY:
            n["params"].update(basis="subband", library_version=LIBRARY, **REC_PARAMS)
    rec = {n["id"] for n in doc["nodes"] if n["type"] == "TemplateClassifier" and not LIBRARY}
    doc["nodes"] = [n for n in doc["nodes"] if n["id"] not in rec]
    doc["edges"] = [e for e in doc["edges"] if e["from"]["node"] not in rec and e["to"]["node"] not in rec]
    doc["observation_points"] = []
    return doc


def build_cell(doc: dict, cell: dict, variant: str) -> tuple[str, str]:
    """格子的场景与框图（经 _gen.ts eval 编译，再按 patch_diagram 改），返回两份文件的仓库相对路径。"""
    base = os.path.join(ROOT, TMP, "diagrams")
    os.makedirs(base, exist_ok=True)
    sid = S.scenario_id(doc, cell)
    scen = os.path.join(base, f"{sid}.scenario.json")
    with open(scen, "wb") as fh:
        fh.write(S.dumps(S.build(doc, cell)))
    spec = S.chain_spec(doc, cell, rel(scen))
    spec["diagram_id"] += f"-{variant}"
    spec["taps"] = []
    spec["iq"] = []
    if variant == "wb":
        del spec["slots"]["ddc"]                          # DDC 旁路：检测器吃 S3 的全带
        # 宽带下只剩「跳频点离 S3 带边不到 5% 保护带」那一条提示性检查（同 Q-4b 回归的 WB_ALLOW）
        spec["plan_allow"] = sorted(set(spec["plan_allow"]) & {"edge"})
    spec_path = os.path.join(base, f"{sid}.{variant}.chain.json")
    with open(spec_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
    p = subprocess.run(["npx", "tsx", "src/chain/examples/_gen.ts", "eval", "--spec", rel(spec_path)],
                       cwd=os.path.join(ROOT, "web"), capture_output=True)
    if p.returncode != 0:
        raise SystemExit(f"{cell['id']} {variant}：_gen eval 失败：{p.stderr.decode('utf-8', 'replace').strip()[-600:]}")
    diag = os.path.join(base, f"{sid}.{variant}.diagram.json")
    with open(diag, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(patch_diagram(json.loads(p.stdout)), ensure_ascii=False, indent=2) + "\n")
    return rel(diag), rel(scen)


def build_legacy(name: str, fixture: str | None) -> tuple[str, str]:
    base = os.path.join(ROOT, TMP, "diagrams")
    os.makedirs(base, exist_ok=True)
    scen_id = name.split(".")[0]
    scen = f"data/scene/beijing-yayuncun/scenarios/{scen_id}.scenario.json"
    if fixture is None:          # 缺省链（golden-01）：取 _gen.ts default 生成的模块里的那份框图
        p = subprocess.run(["npx", "tsx", "src/chain/examples/_gen.ts", "default"], cwd=os.path.join(ROOT, "web"),
                           capture_output=True, text=True)
        if p.returncode != 0:
            raise SystemExit(f"_gen default 失败：{p.stderr.strip()[-600:]}")
        line = next(ln for ln in p.stdout.splitlines() if ln.startswith("export const DEFAULT_CHAIN_TEXT = "))
        doc = json.loads(json.loads(line[len("export const DEFAULT_CHAIN_TEXT = "):]))
    else:
        with open(os.path.join(ROOT, fixture), encoding="utf-8") as fh:
            doc = json.load(fh)
    diag = os.path.join(base, f"{name}.diagram.json")
    with open(diag, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(patch_diagram(doc), ensure_ascii=False, indent=2) + "\n")
    return rel(diag), scen


def run_one(job: tuple[str, str, str]) -> tuple[str, str]:
    name, diag, scen = job
    out = os.path.join(TMP, "runs", name)
    shutil.rmtree(os.path.join(ROOT, out), ignore_errors=True)
    p = subprocess.run([CUAV_RUN, "--run", diag, "--out", out, "--task-id", name, "--scenario", scen,
                        "--library-root", "models/recognition"], cwd=ROOT, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"{name}：cuav_run 退出码 {p.returncode}：{(p.stdout + p.stderr).strip()[-800:]}")
    return name, out


def rows_by_template(out: str, legacy: bool) -> tuple[dict, dict]:
    """一次运行里配上真值的 full 特征行，按模板分组；另返回计数（配上 / 没配上 / 非 full）。"""
    with open(os.path.join(ROOT, out, "metrics.json"), encoding="utf-8") as fh:
        metrics = json.load(fh)
    det_all = EV.read_jsonl(os.path.join(ROOT, out, "detections.jsonl"))
    feat_all = EV.read_jsonl(os.path.join(ROOT, out, "features.jsonl"))
    truth_all = EV.read_jsonl(os.path.join(ROOT, out, "truth.jsonl"))
    got: dict = {}
    counts = {"feature_rows": 0, "paired": 0, "unpaired": 0, "not_full": 0}
    for sec in metrics["sites"]:
        site, node = sec.get("site_id"), sec["node_id"]
        det = [r for r in det_all if r.get("site_id") == site] if site else det_all
        feats = [r for r in feat_all if r.get("site_id") == site] if site else feat_all
        truth = [r for r in truth_all if r.get("node_id") == node]
        params = {"match_overlap": sec["params"]["match_overlap"], "frame_dt_s": sec["detector"]["frame_dt_s"]}
        d: dict = {}
        EV.tf_segments(det, truth, params, d)
        truth_of_seg = {d["segments"][si][0]: d["truth"][ti] for ti, si in d.get("seg_of", {}).items()}
        for f in feats:
            counts["feature_rows"] += 1
            t = truth_of_seg.get(f["segment_id"])
            if t is None:
                counts["unpaired"] += 1
                continue
            counts["paired"] += 1
            if f["quality"] != "full":
                counts["not_full"] += 1
                continue
            tpl = legacy_template(t) if legacy else PRESET_TEMPLATE.get(t.get("preset_id"))
            if tpl is None:
                raise SystemExit(f"{out}：真值行没有对应的模板（preset {t.get('preset_id')}、label {t.get('label')}）")
            got.setdefault(tpl, []).append(f)
    return got, counts


def feature_value(f: dict, name: str):
    """与识别器的 feature_value 同规则：带宽要有信号频点，跳频差与间隔要有上一段；跳频差取绝对值。"""
    if name == "bandwidth_Hz":
        return float(f["bandwidth_Hz"]) if int(f.get("signal_bins", 0)) > 0 else None
    if name in ("hop_from_prev_Hz", "interval_from_prev_s"):
        if f.get(name) is None:
            return None
        return abs(float(f[name])) if name == "hop_from_prev_Hz" else float(f[name])
    v = f.get(name)
    return None if v is None else float(v)


def quantile(sorted_vals: list[float], q: float) -> float:
    """线性插值分位数（与 numpy 缺省 method = linear 同式），纯 Python、确定。"""
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    pos = (n - 1) * q / 100.0
    lo = int(math.floor(pos))
    hi = min(lo + 1, n - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def stats(rows: list[dict]) -> dict:
    out = {"rows": len(rows), "features": {}}
    for name in FEATURES:
        vals = sorted(v for v in (feature_value(r, name) for r in rows) if v is not None)
        e = {"available": len(vals), "available_frac": round(len(vals) / len(rows), 6) if rows else 0.0}
        if vals:
            e.update({f"p{q:g}": quantile(vals, q) for q in QUANTILES})
            e.update({"min": vals[0], "max": vals[-1]})
        out["features"][name] = e
    return out


def survey(workers: int) -> dict:
    doc = C.load(SET_ID)
    jobs, legacy_names = [], set()
    for cell in doc["cells"]:
        for variant in ("wb", "s4"):
            diag, scen = build_cell(doc, cell, variant)
            jobs.append((f"{cell['id']}.{variant}", diag, scen))
    for scen_id, name, fixture in LEGACY:
        diag, scen = build_legacy(name, fixture)
        jobs.append((name, diag, scen))
        legacy_names.add(name)
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        outs = dict(ex.map(run_one, jobs))
    per_tpl: dict = {}
    runs = []
    for name, _, _ in jobs:
        got, counts = rows_by_template(outs[name], name in legacy_names)
        runs.append({"run": name, **counts, "templates": {k: len(v) for k, v in sorted(got.items())}})
        for tpl, rows in got.items():
            per_tpl.setdefault(tpl, []).extend(rows)
    return {
        "schema": "cuav-recognition-calibration/1",
        "purpose": "识别库 v2 的校准统计（Q-4c，D-094；14 号报告 §8.6）：只取校准集与 golden 场景，不含试样集",
        "generator": "algos/reference/q4c_feature_survey.py",
        "calibration_set": f"tests/regression/eval-dataset/{SET_ID}.json",
        "calibration_set_sha256": sha256_file(C.path_of(SET_ID)),
        "legacy": [{"scenario": s, "fixture": f or "web/src/chain/examples/_gen.ts default"} for s, _, f in LEGACY],
        "variants": {"wb": "DDC 旁路、检测器吃 S3 全带", "s4": "格子文件写的 DDC（交付链路）"},
        "subband_bins": SUBBAND_BINS,
        "row_filter": "配上真值（segments_tf 一对一配对）且 quality = full",
        "quantile_method": "线性插值（numpy linear 同式）",
        "engine": {"cuav_run_sha256": sha256_file(CUAV_RUN)},
        "templates": {tpl: stats(per_tpl[tpl]) for tpl in sorted(per_tpl)},
        "runs": runs,
    }


def dumps(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, indent=1, allow_nan=False) + "\n"


def self_check(workers: int) -> int:
    """校准集内的自检（14 §8.6「判决参数」）：同一批格子带识别器跑一遍，逐格报识别准确率与按模板的召回。
    库就是从这些格子取的，这是训练集内的数——只用来看判决参数行不行，不当验收。"""
    doc = C.load(SET_ID)
    jobs = []
    for cell in doc["cells"]:
        for variant in ("wb", "s4"):
            diag, scen = build_cell(doc, cell, variant)
            jobs.append((f"{cell['id']}.{variant}", diag, scen))
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        outs = dict(ex.map(run_one, jobs))
    tot: dict = {}
    worst = 1.0
    for name, _, _ in jobs:
        out = outs[name]
        with open(os.path.join(ROOT, out, "metrics.json"), encoding="utf-8") as fh:
            sec = json.load(fh)["sites"][0]
        rec = EV.read_jsonl(os.path.join(ROOT, out, "recognitions.jsonl"))
        det = EV.read_jsonl(os.path.join(ROOT, out, "detections.jsonl"))
        truth = EV.read_jsonl(os.path.join(ROOT, out, "truth.jsonl"))
        d: dict = {}
        EV.tf_segments(det, truth, {"match_overlap": sec["params"]["match_overlap"],
                                    "frame_dt_s": sec["detector"]["frame_dt_s"]}, d)
        truth_of_seg = {d["segments"][si][0]: d["truth"][ti] for ti, si in d.get("seg_of", {}).items()}
        per: dict = {}
        for r in rec:
            t = truth_of_seg.get(r["segment_id"])
            if t is None:
                continue
            tpl = PRESET_TEMPLATE.get(t.get("preset_id"))
            e = per.setdefault(tpl, [0, 0, 0])
            e[0] += 1
            e[1] += (r["result"] != "unknown" and r["label"] == t["label"])
            e[2] += r.get("template") == tpl
            te = tot.setdefault(tpl, [0, 0, 0])
            te[0] += 1
            te[1] += (r["result"] != "unknown" and r["label"] == t["label"])
            te[2] += r.get("template") == tpl
        acc = sec["recognition"]["accuracy"]
        if acc is not None:
            worst = min(worst, acc)
        print(f"{name:12s} 准确率 {acc}（{sec['recognition']['evaluated']} 段，未知率 {sec['recognition']['unknown_rate']}）  " +
              "  ".join(f"{k} 标签 {v[1]}/{v[0]} 模板 {v[2]}/{v[0]}" for k, v in sorted(per.items())))
    print("合计：" + "；".join(f"{k} 标签 {v[1]}/{v[0]}（{v[1] / v[0]:.3f}）模板 {v[2]}/{v[0]}" for k, v in sorted(tot.items())))
    print(f"逐格最低准确率 {worst:.4f}")
    return 0


def main(argv=None) -> int:
    global LIBRARY
    ap = argparse.ArgumentParser(description="识别库 v2 的校准调查")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--check", action="store_true", help="重跑并与入库的统计表逐字节比对，不写文件")
    ap.add_argument("--with-library", help="校准集内的自检：带识别器、按这个库版本（如 v2）跑一遍，只报数、不写文件")
    ap.add_argument("--accept-threshold", type=float, help="自检时识别器的接受门限（缺省用框图里的值）")
    args = ap.parse_args(argv)
    if args.accept_threshold is not None:
        REC_PARAMS["accept_threshold"] = args.accept_threshold
    if not os.path.exists(CUAV_RUN):
        print(f"没有 {rel(CUAV_RUN)}：先构建引擎", file=sys.stderr)
        return 2
    shutil.rmtree(os.path.join(ROOT, TMP), ignore_errors=True)
    if args.with_library:
        LIBRARY = args.with_library
        try:
            return self_check(args.workers)
        finally:
            shutil.rmtree(os.path.join(ROOT, TMP), ignore_errors=True)
    try:
        text = dumps(survey(args.workers))
    finally:
        shutil.rmtree(os.path.join(ROOT, TMP), ignore_errors=True)
    path = os.path.join(ROOT, OUT)
    if args.check:
        # 引擎二进制的哈希只作留档：换平台、换编译器、改了与特征无关的代码都会变，比的是除它之外的全部字节
        with open(path, encoding="utf-8") as fh:
            old = json.loads(fh.read())
        new = json.loads(text)
        eng_old, eng_new = old.pop("engine"), new.pop("engine")
        same = dumps(old) == dumps(new)
        print(("校准统计表与重跑结果逐字节相同（引擎二进制" + ("相同）" if eng_old == eng_new else "不同，只作留档）"))
              if same else "校准统计表与重跑结果不同")
        return 0 if same else 1
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    d = json.loads(text)
    for tpl, s in d["templates"].items():
        f = s["features"]
        bw, du = f["bandwidth_Hz"], f["duration_s"]
        print(f"{tpl:14s} 行 {s['rows']:5d}  带宽 p2.5–p97.5 {bw.get('p2.5', 0) / 1e3:9.1f}–{bw.get('p97.5', 0) / 1e3:9.1f} kHz  "
              f"时长 {du.get('p2.5', 0) * 1e3:8.3f}–{du.get('p97.5', 0) * 1e3:9.3f} ms  "
              f"上一段可用 {f['interval_from_prev_s']['available_frac']:.2f}")
    print(f"已写 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
