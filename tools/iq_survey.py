#!/usr/bin/env python3
"""DS-5 / DA-5：IQ 摸底工具，落地 04 §10.6 的八项质检。

规范：`docs/iq-format.md` 第 4.4 节（八项键名与取最差规则）、第 7 节（四态）。
步骤：06 备忘录 §11.4 DS-5、§11.5 DA-5。

铁律 15 在本工具里的具体含义：**元数据缺失判 degraded，既不崩溃也不拿默认值顶替**。
两个公开数据集文件内零元数据，正是这条路径的测试用例。

样点侧的统计一律单遍流式完成（内存占用与文件大小无关），频谱按窗口抽样。

用法：
    uv run --project tools python tools/iq_survey.py <某个.iq 或目录> [--report out.md]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from dataclasses import dataclass, field

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from iq_format import manifest as M          # noqa: E402
from iq_format.writer import BYTES_PER_SAMPLE, FULL_SCALE   # noqa: E402

VERSION = "0.1.0"

# ---- 判据阈值。每条都写清依据，改动须同步改 docs/iq-format.md 与本注释 ----
DC_RATIO_DEGRADED = 0.01        # 直流偏置超过均方根的 1% 判 degraded
IQ_STD_RATIO_TOL = 0.05         # I/Q 标准差比偏离 1 超过 5% 判 degraded
IQ_XCORR_DEGRADED = 0.05        # I 与 Q 互相关绝对值超过 0.05 判 degraded
# 上面三条是固定阈值，但短文件上这三个量本身就有统计涨落：零直流假设下样本均值的标准差是
# sigma/sqrt(N)，互相关的是 1/sqrt(N)，标准差比的是 1/sqrt(2N)。因此实际判据取「固定阈值」
# 与「5 倍统计标准差」中较宽的一个，避免把短窗的正常涨落误报成设备缺陷。文件越长下限越小，
# 到真实数据的量级（1e8 样点）下限约为万分之零点五，判据实际就是上面的固定阈值。
SIGMA_GUARD = 5.0
CLIP_RATIO_DEGRADED = 1e-6      # 削顶样点占比超过百万分之一判 degraded
CLIP_RATIO_INVALID = 1e-3       # 超过千分之一判 invalid
ZERO_RUN_MIN = 1024             # 连续全零样点达到该长度算一处时间空洞
NFFT = 8192                     # 与 DA-6 的口径一致（WORKLOG 2026-09-03 第四条 4.1 节）
PSD_WINDOWS = 8                 # 频谱抽样窗口数
PSD_WINDOW_SAMPLES = 2_000_000
NOISE_FLOOR_PCT = 10            # 底噪取平均功率谱在频率维的第 10 百分位，不用时间维中位数
QUIET_FRAME_PCT = 10            # 帧功率最低的这一成算"安静帧"，用于把噪声路径与信号路径分开看
OCCUPANCY_DB = 6                # 高出底噪 6 dB 的频点算被占用
HASH_CHUNK = 32 << 20


@dataclass
class FileResult:
    stem: str
    checks: dict[str, str]
    reasons: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    @property
    def status(self) -> str:
        return M.worst(*self.checks.values())


def _segment_paths(iq_path: str, man: dict) -> list[str]:
    d = os.path.dirname(os.path.abspath(iq_path))
    segs = man.get("segments") or []
    if segs:
        return [os.path.join(d, s["file"]) for s in segs]
    return [iq_path]


def _stream_stats(paths: list[str]) -> dict:
    """单遍流式统计：均值、均方、极值、削顶数、全零段、样点数。"""
    n = 0
    sum_i = sum_q = 0.0
    sq_i = sq_q = 0.0
    cross = 0.0
    clip = 0
    zeros = 0
    peak = 0
    zero_runs: list[int] = []
    run = 0
    for p in paths:
        mm = np.memmap(p, dtype="<i2", mode="r")
        for start in range(0, mm.size, 2 * PSD_WINDOW_SAMPLES):
            blk = np.asarray(mm[start:start + 2 * PSD_WINDOW_SAMPLES], dtype=np.int64)
            if blk.size % 2:
                blk = blk[:-1]
            i = blk[0::2]
            q = blk[1::2]
            n += i.size
            sum_i += float(i.sum()); sum_q += float(q.sum())
            sq_i += float((i * i).sum()); sq_q += float((q * q).sum())
            cross += float((i * q).sum())
            clip += int(np.count_nonzero((np.abs(blk) >= FULL_SCALE - 1)))
            peak = max(peak, int(np.abs(blk).max()) if blk.size else 0)
            z = (i == 0) & (q == 0)
            zeros += int(np.count_nonzero(z))
            # 跨块延续的全零游程
            idx = np.flatnonzero(~z)
            if idx.size == 0:
                run += z.size
            else:
                run += int(idx[0])
                if run >= ZERO_RUN_MIN:
                    zero_runs.append(run)
                if idx.size > 1:
                    gaps = np.diff(idx) - 1
                    for g in gaps[gaps >= ZERO_RUN_MIN]:
                        zero_runs.append(int(g))
                run = int(z.size - 1 - idx[-1])
        del mm
    if run >= ZERO_RUN_MIN:
        zero_runs.append(run)

    if n == 0:
        return {"sample_count": 0}
    mi, mq = sum_i / n, sum_q / n
    vi = max(sq_i / n - mi * mi, 0.0)
    vq = max(sq_q / n - mq * mq, 0.0)
    rms = math.sqrt(max((sq_i + sq_q) / n, 0.0))
    denom = math.sqrt(vi * vq)
    xcorr = ((cross / n) - mi * mq) / denom if denom > 0 else 0.0
    return {
        "sample_count": n,
        "mean_i": mi, "mean_q": mq,
        "std_i": math.sqrt(vi), "std_q": math.sqrt(vq),
        "std_ratio": (math.sqrt(vi) / math.sqrt(vq)) if vq > 0 else float("nan"),
        "iq_xcorr": xcorr,
        "rms_code": rms,
        "rms_dBFS": 20 * math.log10(rms / FULL_SCALE) if rms > 0 else float("-inf"),
        "peak_code": peak,
        "peak_dBFS": 20 * math.log10(peak / FULL_SCALE) if peak > 0 else float("-inf"),
        "clip_samples": clip,
        "zero_samples": zeros,
        "zero_runs": len(zero_runs),
        "longest_zero_run": max(zero_runs) if zero_runs else 0,
        "dc_ratio": math.sqrt(mi * mi + mq * mq) / rms if rms > 0 else float("nan"),
    }


def _psd(paths: list[str], fs: float) -> dict:
    """按窗口抽样的平均功率谱、底噪与占用带宽。口径与 DA-6 一致。"""
    total = sum(os.path.getsize(p) for p in paths) // BYTES_PER_SAMPLE
    if total < NFFT:
        return {}
    win_n = min(PSD_WINDOW_SAMPLES, total)
    starts = np.linspace(0, max(total - win_n, 0), PSD_WINDOWS).astype(np.int64)
    acc = None
    frames = 0
    burst = []
    frame_pw = []      # 每帧总功率
    frame_i2 = []      # 每帧 I 平方和
    frame_q2 = []      # 每帧 Q 平方和
    for s in starts:
        x = _read_samples(paths, int(s), int(win_n))
        k = x.size // NFFT
        if k == 0:
            continue
        blk = x[:k * NFFT].reshape(k, NFFT)
        X = blk * np.hanning(NFFT)
        S = np.abs(np.fft.fftshift(np.fft.fft(X, axis=1), axes=1)) ** 2
        acc = S.sum(0) if acc is None else acc + S.sum(0)
        frames += k
        fp = 10 * np.log10(S.sum(1) + 1e-30)
        burst.append(fp)
        i2 = np.sum(blk.real.astype(np.float64) ** 2, axis=1)
        q2 = np.sum(blk.imag.astype(np.float64) ** 2, axis=1)
        frame_i2.append(i2)
        frame_q2.append(q2)
        frame_pw.append(i2 + q2)
    if acc is None:
        return {}
    psd = 10 * np.log10(acc / frames + 1e-30)
    nf = float(np.percentile(psd, NOISE_FLOOR_PCT))
    occupied = psd > nf + OCCUPANCY_DB
    fr = np.fft.fftshift(np.fft.fftfreq(NFFT, 1 / fs))
    bw = float(np.count_nonzero(occupied)) / NFFT * fs
    fp_all = np.concatenate(burst)
    # 安静帧（功率最低的一成）上的 I/Q 标准差比。整片统计量会被信噪比污染：
    # 实测 DroneRFa 的幅度不平衡在噪声路径上、信号路径是平的，所以文件越"响"整片比值越接近 1
    # （WORKLOG 2026-09-03 第五条日志）。判定必须在安静帧上做。
    i2 = np.concatenate(frame_i2)
    q2 = np.concatenate(frame_q2)
    pw = np.concatenate(frame_pw)
    quiet = pw <= np.percentile(pw, QUIET_FRAME_PCT)
    sq = float(q2[quiet].sum())
    quiet_ratio = float(np.sqrt(i2[quiet].sum() / sq)) if sq > 0 else float("nan")
    loud = pw >= np.percentile(pw, 100 - QUIET_FRAME_PCT)
    sql = float(q2[loud].sum())
    loud_ratio = float(np.sqrt(i2[loud].sum() / sql)) if sql > 0 else float("nan")
    return {
        "std_ratio_quiet": quiet_ratio,
        "std_ratio_loud": loud_ratio,
        "noise_floor_dB": nf,
        "peak_above_noise_dB": float(psd.max() - nf),
        "occupied_bandwidth_Hz": bw,
        "occupied_span_Hz": (float(fr[occupied].max() - fr[occupied].min())
                             if occupied.any() else 0.0),
        "burst_frame_ratio": float(np.mean(fp_all > np.median(fp_all) + 6)),
        "frame_power_span_dB": float(fp_all.max() - fp_all.min()),
        "frames": int(frames),
    }


def _read_samples(paths: list[str], start: int, count: int) -> np.ndarray:
    """跨段读取 count 个复样点，返回 complex64。"""
    out_i = []
    remaining = count
    pos = start
    offset = 0
    for p in paths:
        n_p = os.path.getsize(p) // BYTES_PER_SAMPLE
        if pos >= offset + n_p:
            offset += n_p
            continue
        local = pos - offset
        take = min(n_p - local, remaining)
        raw = np.fromfile(p, dtype="<i2", count=2 * take, offset=2 * local * 2)
        out_i.append(raw)
        remaining -= take
        pos += take
        offset += n_p
        if remaining <= 0:
            break
    if not out_i:
        return np.empty(0, dtype=np.complex64)
    raw = np.concatenate(out_i).astype(np.float32)
    return (raw[0::2] + 1j * raw[1::2]).astype(np.complex64)


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(HASH_CHUNK)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def survey_file(iq_path: str, seen_hashes: dict[str, str] | None = None,
                write_back: bool = True) -> FileResult:
    """对一个数据产物跑完八项质检。缺元数据不崩溃，判 degraded。"""
    stem = os.path.basename(iq_path)
    stem = stem[:-3] if stem.endswith(".iq") else stem
    stem_base = stem.rsplit("_seg", 1)[0] if "_seg" in stem else stem
    man_path = os.path.join(os.path.dirname(os.path.abspath(iq_path)),
                            f"{stem_base}.manifest.json")
    checks = {k: M.NOT_APPLICABLE for k in M.CHECK_KEYS}
    reasons: list[str] = []

    # ---- 第 7 项：元数据必填项、单位与取值范围 ----
    man = None
    if not os.path.exists(man_path):
        checks["metadata_required_units"] = M.DEGRADED
        reasons.append(f"没有旁挂清单 {os.path.basename(man_path)}，"
                       "采集参数完全未知；按铁律 15 判 degraded，不拿默认值顶替")
    else:
        try:
            with open(man_path, encoding="utf-8") as fh:
                man = json.load(fh)
        except (json.JSONDecodeError, OSError) as e:
            checks["metadata_required_units"] = M.INVALID
            reasons.append(f"清单无法解析：{e}")
    if man is not None:
        problems = M.validate(man)
        paper_fields = [k for k, v in man.get("field_sources", {}).items()
                        if v in ("paper", "absent", "assumed")]
        if problems:
            checks["metadata_required_units"] = M.INVALID
            reasons += [f"清单校验：{p}" for p in problems]
        elif paper_fields:
            checks["metadata_required_units"] = M.DEGRADED
            reasons.append(f"{len(paper_fields)} 个采集类字段不是设备记录"
                           f"（来源为 paper/absent/assumed）：{', '.join(sorted(paper_fields))}")
        else:
            checks["metadata_required_units"] = M.VALID

    paths = _segment_paths(iq_path, man or {})
    paths = [p for p in paths if os.path.exists(p)]
    if not paths:
        checks["length_format_metadata"] = M.INVALID
        reasons.append("样点文件不存在")
        return FileResult(stem_base, checks, reasons, {})

    # ---- 第 1 项：文件长度、格式与元数据一致性 ----
    total_bytes = sum(os.path.getsize(p) for p in paths)
    n_samples = total_bytes // BYTES_PER_SAMPLE
    if total_bytes % BYTES_PER_SAMPLE:
        checks["length_format_metadata"] = M.INVALID
        reasons.append(f"文件长度 {total_bytes} 不是每样点 4 字节的整数倍")
    elif man is None:
        checks["length_format_metadata"] = M.DEGRADED
        reasons.append("无清单可比对文件长度")
    elif man.get("sampling", {}).get("sample_count") != n_samples:
        checks["length_format_metadata"] = M.INVALID
        reasons.append(f"清单声明 {man['sampling']['sample_count']} 样点，"
                       f"实际 {n_samples} 样点")
    else:
        checks["length_format_metadata"] = M.VALID

    fs = float(man.get("sampling", {}).get("sample_rate_Hz", 0)) if man else 0.0

    # ---- 样点侧统计（单遍流式）----
    st = _stream_stats(paths)
    if st.get("sample_count", 0) == 0:
        checks["length_format_metadata"] = M.INVALID
        reasons.append("文件为空，没有样点")
        return FileResult(stem_base, checks, reasons, st)
    ps = _psd(paths, fs) if fs > 0 else {}
    stats = {**st, **ps}

    # ---- 第 2 项：I/Q 顺序、字节序与数值范围 ----
    if man and man.get("sampling", {}).get("byte_order") != "little":
        checks["iq_order_endian_range"] = M.INVALID
        reasons.append("清单字节序不是 little，本规范固定小端")
    elif st.get("peak_code", 0) > FULL_SCALE - 1:
        checks["iq_order_endian_range"] = M.INVALID
        reasons.append("样点超出 int16 值域")
    elif st.get("peak_code", 0) == 0:
        checks["iq_order_endian_range"] = M.INVALID
        reasons.append("全零文件")
    else:
        checks["iq_order_endian_range"] = M.VALID
        if man is None:
            reasons.append("I/Q 顺序无法独立验证（无清单），只验证了数值范围")

    # ---- 第 3 项：直流偏置、IQ 交换与幅相异常 ----
    dc = st.get("dc_ratio", float("nan"))
    ratio = st.get("std_ratio", float("nan"))
    xc = st.get("iq_xcorr", float("nan"))
    n_s = max(st.get("sample_count", 0), 1)
    dc_lim = max(DC_RATIO_DEGRADED, SIGMA_GUARD / math.sqrt(n_s))
    ratio_lim = max(IQ_STD_RATIO_TOL, SIGMA_GUARD / math.sqrt(2 * n_s))
    xc_lim = max(IQ_XCORR_DEGRADED, SIGMA_GUARD / math.sqrt(n_s))
    stats_limits = {"dc_limit": dc_lim, "std_ratio_limit": ratio_lim, "xcorr_limit": xc_lim}
    # 幅度不平衡以安静帧的比值为准；整片比值随信噪比变化，只作参考量报出
    ratio_quiet = ps.get("std_ratio_quiet", float("nan"))
    judge_ratio = ratio_quiet if not math.isnan(ratio_quiet) else ratio
    judge_label = "安静帧" if not math.isnan(ratio_quiet) else "整片"
    bad3 = []
    if not math.isnan(dc) and dc > dc_lim:
        bad3.append(f"直流偏置占均方根 {dc:.2%}，超过判据 {dc_lim:.2%}")
    if not math.isnan(judge_ratio) and abs(judge_ratio - 1.0) > ratio_lim:
        bad3.append(f"{judge_label} I/Q 标准差比 {judge_ratio:.4f}，偏离 1 超过判据 "
                    f"{ratio_lim:.2%}（整片 {ratio:.4f}；整片值随信噪比变化，不作判据）")
    if not math.isnan(xc) and abs(xc) > xc_lim:
        bad3.append(f"I 与 Q 互相关 {xc:+.4f}，绝对值超过判据 {xc_lim:.4f}")
    if bad3:
        checks["dc_swap_imbalance"] = M.DEGRADED
        reasons += bad3
    else:
        checks["dc_swap_imbalance"] = M.VALID

    # ---- 第 4 项：削顶、过载、丢样、全零与时间空洞 ----
    clip_ratio = st["clip_samples"] / max(st["sample_count"] * 2, 1)
    bad4 = []
    state4 = M.VALID
    if clip_ratio > CLIP_RATIO_INVALID:
        state4 = M.INVALID
        bad4.append(f"削顶样点占比 {clip_ratio:.2e}，超过 {CLIP_RATIO_INVALID:.0e}")
    elif clip_ratio > CLIP_RATIO_DEGRADED:
        state4 = M.DEGRADED
        bad4.append(f"削顶样点占比 {clip_ratio:.2e}，超过 {CLIP_RATIO_DEGRADED:.0e}")
    if st["zero_runs"]:
        state4 = M.worst(state4, M.DEGRADED)
        bad4.append(f"{st['zero_runs']} 处连续全零段（最长 {st['longest_zero_run']} 样点），"
                    "按 04 §10.6 视为丢样或时间空洞")
    checks["clip_dropout_zero_gap"] = state4
    reasons += bad4

    # ---- 第 5 项：频谱占用、噪声底与带宽 ----
    if not ps:
        checks["spectrum_noise_bandwidth"] = M.DEGRADED
        reasons.append("无法计算频谱：样点不足或采样率未知")
    else:
        declared = float(man.get("frequency", {}).get("effective_bandwidth_Hz", 0)) if man else 0.0
        if declared and ps["occupied_span_Hz"] > declared * 1.001:
            checks["spectrum_noise_bandwidth"] = M.INVALID
            reasons.append(f"占用频谱跨度 {ps['occupied_span_Hz']/1e6:.1f} MHz "
                           f"超过声明的有效带宽 {declared/1e6:.1f} MHz")
        else:
            checks["spectrum_noise_bandwidth"] = M.VALID

    # ---- 第 6 项：多通道样本数与时间对齐 ----
    # 单通道产物「不适用」，与「通过」不是一回事（docs/iq-format.md 第 4.4 节）
    checks["multichannel_alignment"] = M.NOT_APPLICABLE
    reasons.append("单通道数据，多通道对齐项不适用（not_applicable，非 valid）")

    # ---- 第 8 项：文件哈希与重复数据 ----
    digests = {os.path.basename(p): _sha256(p) for p in paths}
    stats["sha256"] = digests
    state8 = M.VALID
    if man and man.get("segments"):
        for seg in man["segments"]:
            want = seg.get("sha256")
            got = digests.get(seg["file"])
            if got and want and got != want:
                state8 = M.INVALID
                reasons.append(f"{seg['file']} 哈希与清单不符，数据已被改动")
    elif man is None:
        state8 = M.DEGRADED
        reasons.append("无清单可比对哈希")
    if seen_hashes is not None:
        for name, dg in digests.items():
            prev = seen_hashes.get(dg)
            if prev and prev != name:
                state8 = M.worst(state8, M.DEGRADED)
                reasons.append(f"内容与 {prev} 完全重复")
            seen_hashes.setdefault(dg, name)
    checks["hash_duplicate"] = state8

    stats.update(stats_limits)
    res = FileResult(stem_base, checks, reasons, stats)

    # ---- 回填清单 ----
    if write_back and man is not None and os.path.exists(man_path):
        man["quality"]["checks"] = dict(checks)
        merged = list(dict.fromkeys(list(man["quality"].get("reasons", [])) + reasons))
        man["quality"]["reasons"] = merged
        man["quality"]["status"] = res.status
        man.setdefault("survey", {})
        man["survey"] = {"tool": f"tools/iq_survey.py {VERSION}", "at": M.utc_now(),
                         "stats": {k: v for k, v in stats.items() if k != "sha256"}}
        with open(man_path, "w", encoding="utf-8") as fh:
            json.dump(man, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    return res


def _fmt(v) -> str:
    if isinstance(v, float):
        if math.isnan(v):
            return "nan"
        if math.isinf(v):
            return "-inf"
        return f"{v:.4g}"
    return str(v)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DS-5 / DA-5 摸底工具：04 §10.6 八项质检")
    ap.add_argument("target", help=".iq 文件或目录")
    ap.add_argument("--report", default=None, help="汇总报告输出路径（Markdown）")
    ap.add_argument("--no-write-back", action="store_true", help="不回填清单的质检结论")
    args = ap.parse_args(argv)

    if os.path.isdir(args.target):
        targets = sorted(os.path.join(args.target, f) for f in os.listdir(args.target)
                         if f.endswith(".iq") and "_seg" not in f)
        targets += sorted(os.path.join(args.target, f) for f in os.listdir(args.target)
                          if f.endswith("_seg000.iq"))
    else:
        targets = [args.target]
    if not targets:
        print("没有找到 .iq 文件", file=sys.stderr)
        return 2

    seen: dict[str, str] = {}
    results = []
    for t in targets:
        r = survey_file(t, seen_hashes=seen, write_back=not args.no_write_back)
        results.append(r)
        print(f"{r.stem}: {r.status}")
        for k in M.CHECK_KEYS:
            print(f"    {k:<28} {r.checks[k]}")
        for why in r.reasons:
            print(f"    · {why}")

    if args.report:
        lines = ["# IQ 摸底报告（04 §10.6 八项质检）", "",
                 f"工具：`tools/iq_survey.py {VERSION}`　生成于 {M.utc_now()}", "",
                 "| 数据产物 | 总状态 | " + " | ".join(k[:12] for k in M.CHECK_KEYS) + " |",
                 "|---|---|" + "---|" * len(M.CHECK_KEYS)]
        for r in results:
            lines.append(f"| `{r.stem}` | **{r.status}** | "
                         + " | ".join(r.checks[k] for k in M.CHECK_KEYS) + " |")
        lines += ["", "## 每个产物的结论与实测统计", ""]
        for r in results:
            lines.append(f"### `{r.stem}` — {r.status}")
            lines.append("")
            if r.stats:
                keep = [("sample_count", "样点数"), ("peak_dBFS", "峰值 dBFS"),
                        ("rms_dBFS", "有效值 dBFS"), ("dc_ratio", "直流占均方根"),
                        ("std_ratio", "I/Q 标准差比（整片，参考）"),
                        ("std_ratio_quiet", "I/Q 标准差比（安静帧，判据）"),
                        ("std_ratio_loud", "I/Q 标准差比（强帧）"),
                        ("iq_xcorr", "I/Q 互相关"),
                        ("clip_samples", "削顶样点"), ("zero_runs", "全零段数"),
                        ("noise_floor_dB", "底噪 dB"), ("peak_above_noise_dB", "峰-底噪 dB"),
                        ("occupied_span_Hz", "占用跨度 Hz"),
                        ("burst_frame_ratio", "突发帧占比"),
                        ("frame_power_span_dB", "帧功率跨度 dB")]
                lines.append("| 量 | 值 |")
                lines.append("|---|---|")
                for k, label in keep:
                    if k in r.stats:
                        lines.append(f"| {label} | {_fmt(r.stats[k])} |")
                lines.append("")
            for why in r.reasons:
                lines.append(f"- {why}")
            lines.append("")
        with open(args.report, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        print(f"\n报告已写 {args.report}")

    worst = M.worst(*(r.status for r in results))
    return 0 if worst in (M.VALID, M.DEGRADED, M.NOT_APPLICABLE) else 1


if __name__ == "__main__":
    raise SystemExit(main())
