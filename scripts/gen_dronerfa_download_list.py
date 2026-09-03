"""按本地实际文件重新生成 DroneRFa 补数清单。首版生成脚本见 WORKLOG 2026-09-03 第三条日志。"""
import os, glob

ROOT = "/Users/zhiyu/CC/804 C-UAV"
DIR = os.path.join(ROOT, "Datasets2-DroneRFa")
OUT = os.path.join(ROOT, "data/iq/measured/dronerfa/download-list.md")

files = sorted(glob.glob(os.path.join(DIR, "*.mat")))
local = [os.path.basename(f)[:-4] for f in files]
localset = set(local)
sizes = [os.path.getsize(f) for f in files]
tot = sum(sizes)

S24 = [f"S0{i:03b}" for i in range(8)]      # 高位 0：915 MHz 或 2.4 GHz
S58 = [f"S1{i:03b}" for i in range(8)]      # 高位 1：2.4 GHz 或 5.8 GHz
D = ["D00", "D01", "D10"]
DRONES = {"T0000": "背景(含蓝牙、WiFi)", "T0001": "DJI Phantom 3", "T0010": "DJI Phantom 4 Pro",
          "T0011": "DJI MATRICE 200", "T0100": "DJI MATRICE 100", "T0101": "DJI Air 2S",
          "T0110": "DJI Mini 3 Pro", "T0111": "DJI Inspire 2", "T1000": "DJI Mavic Pro",
          "T1001": "DJI Mini 2", "T1010": "DJI Mavic 3", "T1011": "DJI MATRICE 300",
          "T1100": "DJI Phantom 4 Pro RTK", "T1101": "DJI MATRICE 30T", "T1110": "DJI AVATA",
          "T1111": "DJI通信模块自组机", "T10000": "DJI MATRICE 600 Pro"}
CTRL = {"T10001": "VBar 飞控器", "T10010": "FrSky X20 飞控器", "T10011": "Futaba T6IZ 飞控器",
        "T10100": "Taranis Plus 飞控器", "T10101": "RadioLink AT9S 飞控器",
        "T10110": "Futaba T14SG 飞控器", "T10111": "云卓 T12 飞控器", "T11000": "云卓 T10 飞控器"}


def gap(names):
    return [x for x in names if x not in localset]


def count(prefix, ds, ss):
    """本地已有的、符合 (机型, 距离档集合, S 集合) 的片数。"""
    return sum(1 for n in local
               if n.startswith(prefix + "_")
               and (not ds or any(f"_{d}_" in n for d in ds))
               and any(n.endswith("_" + s) for s in ss))


L = []
counts = {}


def sec(num, title, names, note=""):
    counts[num] = len(names)
    L.append(f"\n### 优先级 {num} · {title}（{len(names)} 片，约 {len(names)} GB）\n")
    if note:
        L.append(note + "\n")
    L.append("```\n" + "\n".join(n + ".mat" for n in names) + "\n```\n")


L.append(f"""# DroneRFa 下载清单（按命名规则枚举）

首次生成 2026-09-03，同日按本地实际文件重新生成。**本清单是命名空间的完整枚举，不是"确认存在"的
文件列表。** 每个户外机型的命名空间是 3 档距离 × 2 种频段状态 × 8 个片段序号 = 48 种组合，而论文
只承诺每类不少于 12 片，所以 SciDB 上实际提供的片段序号是稀疏的。下载时用本清单与 SciDB 的实际
文件列表取交集即可。

摸底与路损验证的完整结论见项目根目录 `WORKLOG.md` 的 2026-09-03 第三条日志；接入步骤见
`06.首期实施备忘录_v1.0.md` §11.5 的 DA-1 至 DA-7。

## 命名规则

```
户外飞行类：T<机型码>_D<距离码>_S<频段状态+片段序号>.mat
室内固定类：T<机型码>_S<频段状态+片段序号>.mat        ← 无 D 字段
```

| 字段 | 取值 | 含义 |
|---|---|---|
| `D` | `00` / `01` / `10` | 20–40 m / 40–80 m / 80–150 m，**是区间不是点值** |
| `S` 最高位 | `0` | 初始通信在 915 MHz 或 2.4 GHz |
| `S` 最高位 | `1` | 切换至 2.4 GHz 或 5.8 GHz |
| `S` 低 3 位 | `000`–`111` | 片段序号，同一 (机型, 距离, 频段状态) 下最多 8 片 |

**两条不能混的规则**：一是做距离对照必须固定 `S` 最高位，否则频段状态变了、对照不成立；
二是 `T10010`(FrSky X20) 与 `T10100`(Taranis Plus) 的通道映射与其余文件相反，
它们是 RF0=915 MHz、RF1=2440 MHz，其余是 RF0=2440 MHz、RF1=5800 MHz。

## 本地已有（{len(local)} 片，{tot / 2**30:.0f} GB，单片 {min(sizes) / 2**30:.2f}–{max(sizes) / 2**30:.2f} GB）

```
""" + "\n".join(n + ".mat" for n in local) + f"""
```

2026-09-03 曾误删 `T10010_S0000.mat` 与 `T10110_S0000.mat`（过程与由此确立的纪律见 WORKLOG
同日第三条日志第 7 节），当日已重新下载，**现无缺口**。`data/iq/measured/dronerfa/` 下那份
2000 万点的 `T10010_S0000_RF1_excerpt.iq` 是格式预演产物，不再充当原文件的替代品，去留待确认。

## 距离阶梯的当前完整度

| 机型 | `D00` 20–40 m | `D01` 40–80 m | `D10` 80–150 m | 可做什么 |
|---|---|---|---|---|
| `T0010` DJI Phantom 4 Pro，`S0xxx` | {count("T0010", ["D00"], S24)} 片 | {count("T0010", ["D01"], S24)} 片 | {count("T0010", ["D10"], S24)} 片 | **路损指数的误差范围现在可以算**（DA-6） |
| `T0011` DJI MATRICE 200，`S0xxx` | {count("T0011", ["D00"], S24)} 片 | {count("T0011", ["D01"], S24)} 片 | {count("T0011", ["D10"], S24)} 片 | 三档齐全，可做跨机型一致性（相邻档比较仍受区间宽度限制） |
| `T0000` 背景，`S0xxx` | {count("T0000", ["D00"], S24)} 片 | — | — | 虚警率标定与混合增强的背景源；`D` 对背景无实义 |
""")

sec(1, "背景 T0000 补满",
    gap([f"T0000_D00_{s}" for s in S24] + [f"T0000_D00_{s}" for s in S58]),
    "背景类无人机不存在，`D` 与频段状态均无实义，但采集时接收机仍按某一配置工作，故两种 `S` 高位都列。\n"
    "背景片解锁虚警率标定与混合增强，且**已实测验证**可用于独立校验底噪估计：三片背景给出\n"
    "−24.3 / −24.2 / −24.3 dB，与用含无人机片估出的 −24.3 / −24.3 / −24.1 / −24.2 dB 完全一致。\n"
    "注意背景片不是纯噪声，含 WiFi 与蓝牙，突发帧占比 0.0%（`S0111`，最干净）到 2.5%（`S0000`，最脏），\n"
    "做虚警率标定要按干净程度分别处理，不能混成一批。")

sec(2, "T0010 DJI Phantom 4 Pro，2.4 GHz 状态补满",
    gap([f"T0010_{d}_{s}" for d in D for s in S24]),
    "已验证的主力机型。三档距离齐全，**实测路损指数 n = 1.90**（自由空间 2.00，跨 30 至 115 m），\n"
    "片间重复性 0.3–1.3 dB。三档现各有两片，误差范围已可计算（DA-6）；继续补片可收窄区间，供 P3\n"
    "版本冻结。注意相邻档之间的比较不可靠——距离标注是区间，`D01` 与 `D10` 的中点比只有 1.9 倍，\n"
    "而区间自身宽度就有 2 倍。")

sec(3, "T0011 DJI MATRICE 200，2.4 GHz 状态补满",
    gap([f"T0011_{d}_{s}" for d in D for s in S24]),
    "第二机型，用于验证路损指数与机型无关。**`D00` 已于 2026-09-03 补入，该机型确属户外 9 类**，\n"
    "原先「须先在 SciDB 列表确认是否存在 `D00`」这一条已解决。注意本地的 `T0011_D10_S1100` 是\n"
    "5.8 GHz 状态，不参与距离对照。")

sec(4, "遥控器 8 类（室内，文件名无 D 字段）",
    gap([f"{t}_{s}" for t in CTRL for s in S24[:2] + S58[:2]]),
    "波形模板通用性。每类取 4 片（两种频段状态各 2 片），本地已有的不再列出。\n"
    "`T10010` 与 `T10100` 的中心频率是 915 + 2440 MHz，元数据须单独标。\n"
    "`T10010` 的 RF1 实测峰值高出底噪 50.8 dB、突发帧占比 40%，是两个数据集里信号最强最活跃的通道，\n"
    "是观测量提取与波形模板调试的首选样本。")

L.append("""
### 优先级 5 · 其余户外机型（需先确认）

论文称 24 类中只有 **9 类为城市户外运动采集**，带有效距离标注；其余 15 类为室内固定约 2 m。
论文未给出这 9 类的名单。判定方法：**在 SciDB 文件列表中看该机型是否同时出现 `D00`、`D01`、`D10`**。

已确认属户外的：`T0010` DJI Phantom 4 Pro（三档齐）、`T0011` DJI MATRICE 200（三档齐）。

待确认的 DJI 机型码与型号：

| 机型码 | 型号 | 机型码 | 型号 |
|---|---|---|---|
""" + "\n".join(f"| `{a}` | {DRONES[a]} | `{b}` | {DRONES[b]} |"
                for a, b in zip(list(DRONES)[1:9], list(DRONES)[9:17])) + """

确认属户外后，按优先级 2 的模式补三档 × 8 片。

### 已确认无价值 · T0010 / T0011 的 5.8 GHz 状态（S1xxx）

**不建议下载。理由是数据本身没有内容，不是省存储。** 实测 7 个文件、每个 6 个抽样位置，
5.8 GHz 通道（RF1）突发帧占比全部为 0.0%，**含最近的 20–40 m 档**。峰值高出底噪 32–36 dB
但不随时间变化，是本振泄漏或杂散，不是通信信号。

实测过的 7 个文件：`T0010_D00_S1000`、`T0010_D00_S1111`、`T0010_D01_S1010`、`T0010_D01_S1110`、
`T0010_D10_S0100`、`T0010_D10_S1111`、`T0011_D10_S1100`。（本清单首版写的是"6 个文件"，
按会话记录逐一核对后应为 7 个。）

证据边界：实测覆盖 `T0010` 六片与 `T0011` 一片。推断到其他 DJI 机型属推断而非实测。
若要复核，最省的做法是取任一其他机型的 `D00` + `S1xxx` 单片验证。

工程后果：**转换脚本只转 RF0**，每片从约 1.2 GB 降到约 600 MB。原始文件一律保留不动。

## 汇总

""")
L.append("| 优先级 | 内容 | 片数 |\n|---|---|---|\n")
NAMES = {1: "背景 T0000 补满", 2: "T0010 的 2.4 GHz 状态补满", 3: "T0011 的 2.4 GHz 状态补满",
         4: "遥控器 8 类各 4 片"}
for k in sorted(counts):
    L.append(f"| {k} | {NAMES[k]} | {counts[k]} |\n")
L.append("| 5 | 其余户外机型 | 待确认后定 |\n")
L.append(f"| | **合计（优先级 1–4）** | **{sum(counts.values())} 片，约 {sum(counts.values())} GB** |\n")
L.append(f"""
每片压缩后 {min(sizes) / 2**30:.2f}–{max(sizes) / 2**30:.2f} GB（本地 {len(local)} 片实测），解压约 4.8 GB。
按 DA-2 只转 RF0，转换后每片约 600 MB。
""")

open(OUT, "w", encoding="utf-8").write("".join(L))
print("已写", OUT)
print("本地", len(local), "片，", round(tot / 2**30), "GB")
print("枚举缺口（优先级 1–4）:", sum(counts.values()), counts)
