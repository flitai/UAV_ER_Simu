#!/usr/bin/env python3
"""分子带检测的端到端回归（Q-4b，06 §9K，决策 D-093）。

全部从**保存的典型链路**或格子文件跑真引擎，检测器开 subband_bins = 8：

  ① 帧级一字不动：同一条 golden-02 宽带链，开与不开分子带各跑一次——谱与包络产品逐字节相同，
     检测行去掉 subband_hit / subbands 两个键后逐行相同，metrics.json 除 segments_tf 与 task_id 外逐值相同；
  ② golden-02（10 MS/s，图传 2 MHz 带限噪声 + 五点跳频遥控）：
       单源时段（3.0–4.5 s 只有跳频）按验收规则判：分子带突发检出率 ≥ 帧级突发检出率 − 0.02，碎片 ≤ 2%；
       两源同时出现的时段（5–6 s）只报数：帧级几段盖住了多少个跳频突发、分子带配上多少、漏的落在哪些频点；
  ③ 试样集的宽带版本（80 MS/s @ 2440 / 5790 MHz，DDC 旁路，0.5 s）：
       单源视距段 s02 / s03 / s04 / s05 按同一条验收规则判；
       多源段 s01 / s06 / s07 逐辐射源报配上 / 真值 / 被并掉；非视距段 s09 / s10 只报数（用户 2026-10-04 定）；
  ④ 纯背景 s08：暖机（噪声窗 W 帧）之后有子带命中的帧占比，对设计的 pfa（整帧、按检验数 Bonferroni 分摊）。
     门限是噪声已知时的精确尾概率；噪声换成 W = 256 帧的中位数估计后尾概率会抬高——
     块越窄抬得越多，8 频点的块约 1.5 倍——而嵌套块的命中高度相关、Bonferroni 又把总和高估了。
     两者方向相反，判据取 ≤ 2·pfa，实测值照实打印；
  ⑤ 每次运行都用 algos/reference/evaluate.py 逐值核对 metrics.json（含 segments_tf）。

真值频段落在检测频段内不足一半的行（如 S-FHSS 的 0 号信道 2403.97 MHz，只有 33% 在 2404–2476 MHz 内）
计 truth_partial、不进分母：频率重叠比够不到配对条件，检测器怎样都配不上（本回归首跑时 s05 因此差 0.034，查明后改的口径）。

虚警段照实打印，分两类：落在真值突发起止 2 帧以内的（矩形门控突发开关时的频谱泼溅，能量是真的，
只是不在真值频段里），与其余的。实时因子照实打印。

零基准（既有产品逐字节不变）不在这里做：那要上一版提交的引擎，按 D-093 手工比对并记录。

用法（约 4 分钟，运行目录约 1 GB，用完即删）：
    uv run --quiet python tests/regression/subband_detection.py
"""
from __future__ import annotations

import bisect
import copy
import filecmp
import json
import math
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "algos", "reference"))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import evaluate as EV  # noqa: E402
from eval_dataset import cells as C  # noqa: E402
from eval_dataset import scenario as S  # noqa: E402

CUAV_RUN = os.environ.get("CUAV_RUN", os.path.join(ROOT, "engine", "build", "cuav_run"))
G02 = os.path.join("tests", "regression", "diagrams", "chain-golden-02.json")
G02_SB = os.path.join("tests", "regression", "diagrams", "chain-golden-02-subband.json")
G02_SCEN = os.path.join("data", "scene", "beijing-yayuncun", "scenarios", "golden-02.scenario.json")
RUN_BASE = os.path.join("data", "runs", "q4b-subband")
TMP = os.path.join("data", "tmp", "q4b-subband")
SUBBAND_BINS = 8
CELL_DURATION_S = 0.5
PD_SLACK = 0.02          # 验收规则：分子带检出率不低于帧级 − 0.02
FRAG_MAX = 0.02          # 验收规则：碎片 ≤ 2%
EDGE_FRAMES = 2

SINGLE = ["s02", "s03", "s04", "s05"]
MULTI = ["s01", "s06", "s07"]
NLOS = ["s09", "s10"]
NOISE = "s08"

fails = 0


def check(cond: bool, what: str) -> None:
    global fails
    print(("  通过  " if cond else "  失败  ") + what)
    fails += 0 if cond else 1


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT)


def read_jsonl(path: str) -> list[dict]:
    return EV.read_jsonl(os.path.join(ROOT, path))


def run(diagram: str, scenario: str, name: str) -> tuple[str, float]:
    out = os.path.join(RUN_BASE, name)
    shutil.rmtree(os.path.join(ROOT, out), ignore_errors=True)
    t0 = time.perf_counter()
    p = subprocess.run([CUAV_RUN, "--run", diagram, "--out", out, "--scenario", scenario,
                        "--library-root", "models/recognition"], cwd=ROOT, capture_output=True, text=True)
    wall = time.perf_counter() - t0
    if p.returncode != 0:
        raise SystemExit(f"{name}：cuav_run 退出码 {p.returncode}：{(p.stdout + p.stderr).strip()[-800:]}")
    return out, wall


def section(out: str) -> dict:
    with open(os.path.join(ROOT, out, "metrics.json"), encoding="utf-8") as fh:
        m = json.load(fh)
    assert len(m["sites"]) == 1, "本回归只用单站链路"
    return m["sites"][0]


def params_of(sec: dict) -> dict:
    return {"truth_source": sec["params"]["truth_source"], "match_overlap": sec["params"]["match_overlap"],
            "roc_points": sec["params"]["roc_points"], "frame_dt_s": sec["detector"]["frame_dt_s"],
            "threshold": sec["detector"].get("threshold"), "has_rec": sec["recognition"]["state"] != "not_applicable"}


def parity(out: str) -> bool:
    p = subprocess.run([sys.executable, os.path.join(ROOT, "algos", "reference", "evaluate.py"), out],
                       cwd=ROOT, capture_output=True, text=True)
    return p.returncode == 0


def window_rates(out: str, sec: dict, t_lo: float, t_hi: float) -> dict:
    """只取起点落在 [t_lo, t_hi) 的真值行，帧级与分子带各算一遍突发检出率与碎片。"""
    det = read_jsonl(os.path.join(out, "detections.jsonl"))
    rec = read_jsonl(os.path.join(out, "recognitions.jsonl"))
    truth = [t for t in read_jsonl(os.path.join(out, "truth.jsonl")) if t_lo <= t["t_s"] < t_hi]
    mine = EV.evaluate(det, rec, truth, params_of(sec))
    tf = mine["segments_tf"]
    seg = mine["segments"]
    n = tf["truth"]
    return {"truth": n, "pd_frame": seg["pd_segment"], "pd_tf": tf["pd_burst"],
            "fragments": tf["fragments"], "frag_ratio": tf["fragments"] / n if n else None,
            "per_emitter": tf["per_emitter"]}


def false_split(out: str, sec: dict) -> tuple[int, int]:
    """评价器的虚警段（没有任何候选真值的段，频段取核心）分成两类：起点在真值起止 2 帧以内的，与其余的。"""
    det = read_jsonl(os.path.join(out, "detections.jsonl"))
    truth = read_jsonl(os.path.join(out, "truth.jsonl"))
    d: dict = {}
    EV.tf_segments(det, truth, params_of(sec), d)
    dt = sec["detector"]["frame_dt_s"]
    edges = sorted({t["t_s"] for t in d["truth"]} | {t["t_end_s"] for t in d["truth"]})
    near = far = 0
    for si in d["false"]:
        t0 = d["segments"][si][1]
        i = bisect.bisect_left(edges, t0)
        dist = min((abs(t0 - edges[j]) for j in (i - 1, i) if 0 <= j < len(edges)), default=math.inf)
        if dist <= EDGE_FRAMES * dt:
            near += 1
        else:
            far += 1
    return near, far


# ---------------------------------------------------------------- ① 帧级一字不动

def part_frame_untouched() -> tuple[str, dict]:
    print("① 帧级一字不动（golden-02 宽带链，开与不开分子带）")
    plain, w0 = run(G02, G02_SCEN, "g02-plain")
    sb, w1 = run(G02_SB, G02_SCEN, "g02-subband")
    print(f"  墙钟：全带 {w0:.1f} s、分子带 {w1:.1f} s（6 s 信号，10 MS/s）")
    a, b = os.path.join(ROOT, plain), os.path.join(ROOT, sb)
    prod_same = n_prod = 0
    for op in sorted(os.listdir(a)):
        pa = os.path.join(a, op)
        if not os.path.isdir(pa):
            continue
        for f in sorted(os.listdir(pa)):
            n_prod += 1
            prod_same += filecmp.cmp(os.path.join(pa, f), os.path.join(b, op, f), shallow=False)
    check(n_prod > 0 and prod_same == n_prod, f"谱与包络产品逐字节相同（{prod_same} / {n_prod} 个文件）")
    ra = read_jsonl(os.path.join(plain, "detections.jsonl"))
    rb = read_jsonl(os.path.join(sb, "detections.jsonl"))
    strip = [{k: v for k, v in r.items() if k not in ("subband_hit", "subbands")} for r in rb]
    check(len(ra) == len(rb) and ra == strip,
          f"检测行去掉 subband_hit / subbands 后逐行相同（{len(ra)} 行；分子带行都带这两个键："
          f"{all('subband_hit' in r and 'subbands' in r for r in rb)}）")
    sa, sb_sec = section(plain), section(sb)
    keys = sorted(set(sa) | set(sb_sec))
    diff = [k for k in keys if k != "segments_tf" and sa.get(k) != sb_sec.get(k)]
    check(not diff and "segments_tf" not in sa and "segments_tf" in sb_sec,
          f"metrics.json 除 segments_tf 外逐值相同（不同的键：{diff or '无'}；全带没有 segments_tf）")
    check(parity(plain) and parity(sb), "两次运行的 metrics.json 与 Python 参考逐值一致")
    shutil.rmtree(a, ignore_errors=True)
    return sb, sb_sec


# ---------------------------------------------------------------- ② golden-02

def part_golden02(out: str, sec: dict) -> None:
    print("② golden-02：单源时段判、两源时段报数")
    tf = sec["segments_tf"]
    for eid, e in tf["per_emitter"].items():
        print(f"  全程 {eid}：配上 {e['matched']} / {e['truth']}（被并掉 {e['merged']}）")
    w = window_rates(out, sec, 3.0, 4.5)
    print(f"  3.0–4.5 s 只有跳频：真值 {w['truth']}，帧级突发检出率 {w['pd_frame']}，分子带 {w['pd_tf']}，碎片 {w['fragments']}")
    check(w["truth"] > 0 and w["pd_tf"] >= w["pd_frame"] - PD_SLACK and w["frag_ratio"] <= FRAG_MAX,
          f"单源时段：分子带检出率 {w['pd_tf']:.4f} ≥ 帧级 {w['pd_frame']:.4f} − {PD_SLACK}，碎片 {w['frag_ratio']:.4f} ≤ {FRAG_MAX}")

    det = read_jsonl(os.path.join(out, "detections.jsonl"))
    truth = read_jsonl(os.path.join(out, "truth.jsonl"))
    hops = [t for t in truth if t.get("emitter_id") == "uav-2" and 5.0 <= t["t_s"] < 6.0]
    frame_segs = {r["segment_id"] for r in det if r["hit"] and 5.0 <= r["t_s"] < 6.0}
    w2 = window_rates(out, sec, 5.0, 6.0)
    e2 = w2["per_emitter"].get("uav-2", {"matched": 0, "truth": 0, "merged": 0})
    print(f"  5–6 s 两源同时出现：帧级 {len(frame_segs)} 段盖住 {len(hops)} 个跳频突发；"
          f"分子带配上 {e2['matched']} / {e2['truth']}（被并掉 {e2['merged']}）")
    # 漏的落在哪些频点：图传占 2437.5–2439.5 MHz，4 阶巴特沃斯裙边在 2440.8 MHz 处仍高出底噪约 8 dB
    d: dict = {}
    EV.tf_segments(det, truth, params_of(sec), d)
    missed: dict = {}
    for ti, t in enumerate(d["truth"]):
        if t.get("emitter_id") == "uav-2" and 5.0 <= t["t_s"] < 6.0 and ti not in d["seg_of"]:
            c = round(t["center_Hz"] / 1e6, 4)
            missed[c] = missed.get(c, 0) + 1
    print(f"  5–6 s 没配上的跳频点：{missed or '无'}（MHz：个数）")


# ---------------------------------------------------------------- ③ ④ 试样集宽带版本

def prepare_wideband(doc: dict, cell: dict) -> tuple[str, str]:
    base = os.path.join(ROOT, TMP)
    sid = S.scenario_id(doc, cell)
    scen = os.path.join(base, f"{sid}.scenario.json")
    spec_path = os.path.join(base, f"{sid}.wb.chain.json")
    diag = os.path.join(base, f"{sid}.wb.diagram.json")
    os.makedirs(base, exist_ok=True)
    with open(scen, "wb") as fh:
        fh.write(S.dumps(S.build(doc, cell)))
    spec = S.chain_spec(doc, cell, rel(scen))
    spec["diagram_id"] += "-wb-subband"
    spec["name"] += " · 宽带 · 分子带"
    spec["run"]["duration_s"] = CELL_DURATION_S
    del spec["slots"]["ddc"]                       # DDC 旁路：检测器吃 S3 的全带
    spec["slots"]["det"] = {**spec["slots"]["det"], "subband_bins": SUBBAND_BINS}
    spec["taps"] = []
    spec["iq"] = []
    spec["plan_allow"] = WB_ALLOW.get(cell["id"], [])
    with open(spec_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
    p = subprocess.run(["npx", "tsx", "src/chain/examples/_gen.ts", "eval", "--spec", rel(spec_path)],
                       cwd=os.path.join(ROOT, "web"), capture_output=True)
    if p.returncode != 0:
        raise SystemExit(f"{cell['id']}：_gen eval 失败：{p.stderr.decode('utf-8', 'replace').strip()}")
    with open(diag, "wb") as fh:
        fh.write(p.stdout)
    return rel(diag), rel(scen)


# 宽带版本的频率计划放行表：DDC 旁路后与试样集（S4）的放行表不同，缘由逐条写
# 两条都是界面那条提示性的保护带检查（|Δf| + B/2 + 5%·Fs/2 < Fs/2）；引擎的铁律 4 闸不含保护带、放行
_UPLINK = "DJI 上行跳频最低 2402.3 MHz，|Δf| + B/2 = 38.86 MHz，落进 5% 保护带（D-088 ⑩：实测就是在 80 MS/s @ 2440 MHz 下录到的）"
_FRSKY = "FrSky D16 v2 FCC 档最低信道 2404.0 MHz，|Δf| + B/2 = 36.10 MHz，落进 5% 保护带"
_SFHSS = "S-FHSS 的 0 号信道 2403.9987 MHz 离带边 4 MHz，落进 5% 保护带（D-089 ⑫）"
WB_ALLOW: dict[str, list[str]] = {
    "s03": ["edge"],          # _UPLINK
    "s04": ["edge"],          # _FRSKY
    "s05": ["edge"],          # _SFHSS
    "s07": ["edge"],          # _UPLINK（S07 里有同机的上行）
    "s10": ["edge"],          # _UPLINK
}


def part_cells(only: list[str] | None = None) -> None:
    doc = C.load("sample-v1")
    by = {c["id"]: c for c in doc["cells"]}
    print(f"③ 试样集宽带版本（DDC 旁路、{CELL_DURATION_S} s、subband_bins = {SUBBAND_BINS}）")
    for cid in only or (SINGLE + MULTI + NLOS + [NOISE]):
        cell = by[cid]
        diag, scen = prepare_wideband(doc, cell)
        fs = doc["receivers"][cell["receiver"]]["fs_Hz"]
        out, wall = run(diag, scen, f"wb-{cid}")
        sec = section(out)
        tf = sec["segments_tf"]
        near, far = false_split(out, sec)
        rtf = CELL_DURATION_S / wall
        per = "；".join(f"{e} {v['matched']}/{v['truth']}（并掉 {v['merged']}）" for e, v in tf["per_emitter"].items()) or "—"
        print(f"  {cid} {cell['title']}：段 {tf['segments']}、配上 {tf['matched']}、碎片 {tf['fragments']}、"
              f"真值部分在检测频段外 {tf['truth_partial']}、"
              f"虚警段 {tf['false_segments']}（边沿 {near} / 其余 {far}）；{per}；"
              f"帧级突发检出率 {sec['segments']['pd_segment']}；实时因子 {rtf:.3f}（{fs / 1e6:g} MS/s）")
        check(parity(out), f"{cid}：metrics.json 与 Python 参考逐值一致")
        if cid in SINGLE:
            prim = [p["primary"] for p in cell["platforms"] if p.get("primary")]
            assert len(prim) == 1
            e = tf["per_emitter"][prim[0]]
            n = e["truth"]
            frag = tf["fragments"] / n if n else 1.0
            pd_f = sec["segments"]["pd_segment"]
            check(n > 0 and e["pd_burst"] >= pd_f - PD_SLACK and frag <= FRAG_MAX,
                  f"{cid} 单源视距：分子带检出率 {e['pd_burst']:.4f} ≥ 帧级 {pd_f:.4f} − {PD_SLACK}，"
                  f"碎片 {tf['fragments']} / {n} = {frag:.4f} ≤ {FRAG_MAX}")
        if cid == NOISE:
            det = read_jsonl(os.path.join(out, "detections.jsonl"))
            ix = json.load(open(os.path.join(ROOT, out, "detections.index.json"), encoding="utf-8"))
            node = next(iter(ix["nodes"].values()))
            w = node["noise_window_frames"]
            pfa = node["pfa"]
            after = [r for r in det if r["frame_index"] >= w]
            hits = sum(1 for r in after if r.get("subband_hit"))
            rate = hits / len(after)
            print(f"  {cid} 暖机后（帧号 ≥ {w}）子带命中帧 {hits} / {len(after)} = {rate:.2e}；"
                  f"设计 pfa {pfa:g}，{node['subband']['tests']} 次检验、每次 {node['subband']['pfa_test']:.3e}")
            check(rate <= 2 * pfa, f"纯背景：子带命中帧占比 {rate:.2e} ≤ 2·pfa = {2 * pfa:g}")
        shutil.rmtree(os.path.join(ROOT, out), ignore_errors=True)


def main(argv: list[str]) -> int:
    # 调试用：--cells s03,s07 只跑第 ③ 部分的这几格（不算完整回归）
    only = argv[argv.index("--cells") + 1].split(",") if "--cells" in argv else None
    if not os.path.exists(CUAV_RUN):
        print("跳过：没有 engine/build/cuav_run")
        return 0
    shutil.rmtree(os.path.join(ROOT, TMP), ignore_errors=True)
    try:
        if only is None:
            sb, sec = part_frame_untouched()
            part_golden02(sb, sec)
            shutil.rmtree(os.path.join(ROOT, sb), ignore_errors=True)
        part_cells(only)
    finally:
        shutil.rmtree(os.path.join(ROOT, RUN_BASE), ignore_errors=True)
        shutil.rmtree(os.path.join(ROOT, TMP), ignore_errors=True)
    print(f"\n分子带回归：{'全部通过' if fails == 0 else f'{fails} 项失败'}")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
