# 复制自用户级 skill「formal-tech-report」的 scripts/report_kit.py（正式技术报告的单文件 HTML 生成工具），供 Q-7 交付文档使用（D-106）。
# 只改了这两行注释；更新时整份重新复制。
"""正式技术报告（单文件 HTML）的生成工具。只依赖 Python 标准库；作图辅助另需 matplotlib（按需导入）。

用法：把本文件拷进项目（或把本目录加进 sys.path），由项目自己的报告脚本调用。完整示例见 example_report.py。

    from report_kit import Report, table, figure, finding, verdict, grade, e

    rpt = Report("某模块精度验证报告", subtitle="…", short_title="精度验证报告",
                 info=[("版本", "v1.0"), ("日期", "2026-10-10"), ("数据状态", "原型阶段验证结果")])
    T, F, R = rpt.tables, rpt.figures, rpt.refs
    R.add("iso5725", "ISO 5725-2:2019, Accuracy of measurement methods and results, Part 2.")
    rpt.abstract("第一段……", "第二段……")
    rpt.section("s1", "1　目的与范围", f"<p>验证目标见{T.ref('obj')}。</p>" + table(f"{T.new('obj')}　验证目标", …))
    rpt.section("sb", "附录 B　参考文献", R.list_html())
    rpt.write("out/report.html")

设计要点：
- 表、图、参考文献的编号在全文生成之后统一解析。正文可以先引用、后建表；引用了不存在的键即报错。
- 参考文献按正文首次引用的顺序编号（顺序编码制）；登记了却未引用的条目即报错。
- 判定词、归因等级、结论分级各只有一套固定词，传入其它词即报错，防止同一报告里混用两套说法。
- 输出确定：不写时间戳，图片不写软件元数据，换行固定为 LF。同一输入两次生成逐字节相同。
"""
from __future__ import annotations

import base64
import html
import io
import os
import re

__all__ = [
    "e", "num", "Chapters", "Counter", "Refs", "Report", "table", "figure", "finding", "verdict", "matrix_cell", "grade",
    "VERDICTS", "LEVELS", "GRADES", "CSS", "mpl", "png", "jpg", "COLORS", "SERIES",
]

_OPEN, _CLOSE = "⟦", "⟧"  # 占位符括号 ⟦ ⟧：正文里不会自然出现，残留即可查出


def e(s) -> str:
    """把纯文本转成可放进 HTML 的文本。占位符括号不受影响。"""
    return html.escape(str(s))


# ---------------------------------------------------------------- 固定用语

VERDICTS = {
    "符合": "满足判定准则",
    "不符合": "不满足判定准则",
    "不可判定": "任一侧没有可用样本，或比较对象不可比",
    "仅列出": "不设判定准则，只给出数值供参考",
}

LEVELS = {
    "已确认": "由模型定义或直接测量得出",
    "推断": "有间接证据支持，尚未直接验证",
    "未查明": "现有数据不足以确定原因",
}

GRADES = ("充分验证", "初步支持", "未验证")


def grade(ok: int, n: int, full: float = 0.8, partial: float = 0.5) -> str:
    """结论分级：可判定项中符合的比例 ≥ full 为「充分验证」，≥ partial 为「初步支持」，否则「未验证」。

    n = 0（没有可判定项）返回「未验证」：没有证据就不能声称已验证。阈值须在报告的方法章写明。"""
    if n <= 0:
        return GRADES[2]
    r = ok / n
    return GRADES[0] if r >= full else GRADES[1] if r >= partial else GRADES[2]


def verdict(v: str) -> str:
    """单元格里的判定徽标。只接受 VERDICTS 里的四个词。"""
    if v not in VERDICTS:
        raise ValueError(f"判定词只能是 {'/'.join(VERDICTS)}，收到「{v}」")
    if v == "符合":
        return '<span class="badge ok">✓ 符合</span>'
    if v == "不符合":
        return '<span class="badge gap">✗ 不符合</span>'
    if v == "不可判定":
        return '<span class="badge na">— 不可判定</span>'
    return '<span class="sub">仅列出</span>'


def matrix_cell(v: str | None) -> str:
    """汇总矩阵里的单字符：✓ 符合、✗ 不符合、— 不可判定，其它（含「仅列出」）留空。"""
    if v is not None and v not in VERDICTS:
        raise ValueError(f"判定词只能是 {'/'.join(VERDICTS)}，收到「{v}」")
    sym = {"符合": "✓", "不符合": "✗", "不可判定": "—"}.get(v or "", "")
    return f'<span class="c">{sym}</span>'


def num(x: float | None, nd: int = 2, unit: str = "", signed: bool = False) -> str:
    """数值格式：负号用「−」（U+2212）；signed=True 时正数带「+」（差值列用）；None 写「—」；单位前留空格。"""
    if x is None:
        return "—"
    s = f"{x:+.{nd}f}" if signed else f"{x:.{nd}f}"
    s = s.replace("-", "\u2212")
    return f"{s} {unit}" if unit and unit != "%" else s + unit


# ---------------------------------------------------------------- 编号

class Chapters:
    """章序表：章号只在这里定义一次，标题与正文里的「第 n 章 / 第 n.m 节」都由它生成。

        C = Chapters([("scope", "目的与范围"), ("method", "方法"), ("concl", "结论")])
        C.ch("method", 2)   # '2.2'
        rpt.section(C.sid("method"), C.title("method"), C.h3("method", 1, "试验程序") + f"<p>见第 {C.ch('concl')} 章。</p>")
    """

    def __init__(self, items):
        self.items = list(items)
        self.no = {k: i + 1 for i, (k, _) in enumerate(self.items)}
        if len(self.no) != len(self.items):
            raise ValueError("章序表里有重复的键")

    def ch(self, key: str, sub: int | None = None) -> str:
        return f"{self.no[key]}" if sub is None else f"{self.no[key]}.{sub}"

    def sid(self, key: str) -> str:
        return f"s{self.no[key]}"

    def title(self, key: str) -> str:
        return f"{self.no[key]}　{dict(self.items)[key]}"

    def h3(self, key: str, sub: int, title: str) -> str:
        return f"<h3>{self.ch(key, sub)}　{e(title)}</h3>"


class Counter:
    """表或图的编号。new() 取号并返回占位符；ref() 返回同一键的占位符；resolve() 在全文生成后统一换成「表 n」「图 n」。

    取号顺序必须等于版面顺序：各节按版面顺序生成，节内先调用 new() 的表排在前面。"""

    def __init__(self, prefix: str, tag: str):
        self.prefix, self.tag, self.n, self.keys = prefix, tag, 0, {}

    def _ph(self, key: str) -> str:
        return f"{_OPEN}{self.tag}:{key}{_CLOSE}"

    def new(self, key: str | None = None) -> str:
        self.n += 1
        key = key or f"#{self.n}"
        if key in self.keys:
            raise ValueError(f"编号键重复：{self.tag}:{key}")
        self.keys[key] = f"{self.prefix} {self.n}"
        return self._ph(key)

    def ref(self, key: str) -> str:
        return self._ph(key)

    def resolve(self, text: str) -> str:
        def sub(m):
            if m.group(1) not in self.keys:
                raise ValueError(f"引用了不存在的编号：{self.tag}:{m.group(1)}")
            return self.keys[m.group(1)]
        return re.sub(_OPEN + re.escape(self.tag) + ":([^" + _CLOSE + "]+)" + _CLOSE, sub, text)


class Refs:
    """参考文献。add() 登记；cite() 在正文里引用；list_html() 放在参考文献一节。

    编号按正文首次引用的顺序分配（顺序编码制）。登记了却未被引用的条目即报错：编号列表里不该有正文没提到的文献。"""

    tag = "R"
    _LIST = "#list"

    def __init__(self, sep: str = "，"):
        self.items: dict[str, str] = {}
        self.sep = sep
        self.order: list[str] = []

    def add(self, key: str, text: str) -> None:
        if key.startswith("#") or _CLOSE in key:
            raise ValueError(f"文献键不能以 # 开头或含占位符括号：{key}")
        if key in self.items:
            raise ValueError(f"文献键重复：{key}")
        self.items[key] = text

    def _ph(self, key: str) -> str:
        return f"{_OPEN}{self.tag}:{key}{_CLOSE}"

    def cite(self, *keys: str) -> str:
        for k in keys:
            if k not in self.items:
                raise KeyError(f"未登记的文献：{k}")
        return "[" + self.sep.join(self._ph(k) for k in keys) + "]"

    def list_html(self) -> str:
        return self._ph(self._LIST)

    def resolve(self, text: str) -> str:
        pat = re.compile(_OPEN + self.tag + ":([^" + _CLOSE + "]+)" + _CLOSE)
        order: list[str] = []
        for m in pat.finditer(text):
            k = m.group(1)
            if k != self._LIST and k not in order:
                order.append(k)
        unused = [k for k in self.items if k not in order]
        if unused:
            raise ValueError(f"登记了却未在正文引用的文献：{', '.join(unused)}")
        if self.items and self._ph(self._LIST) not in text:
            raise ValueError("有参考文献，但正文里没有放 Refs.list_html()")
        self.order = order
        no = {k: str(i + 1) for i, k in enumerate(order)}
        lst = "<ol class=refs>" + "".join(f"<li>{e(self.items[k])}</li>" for k in order) + "</ol>"
        return pat.sub(lambda m: lst if m.group(1) == self._LIST else no[m.group(1)], text)


# ---------------------------------------------------------------- 页面元件

def table(caption: str, head: list[str], rows: list[list[str]], num_cols=frozenset(), nowrap_cols=frozenset(),
          cls: str = "") -> str:
    """表格。caption 写「{T.new(key)}　标题」，标题在表上方。单元格内容是 HTML（纯文本先过 e()）。

    num_cols：等宽数字列（列序号从 0 起）；nowrap_cols：不换行的短列（编号、判定）。外层包滚动容器，窄屏不撑破页面。
    列多、单元格是长句的表加 cls="wide"（最小宽 760 px）：手机上在容器里横向滚动，不把各列压成两三个字一行。"""
    def cell(tag: str, i: int, c: str) -> str:
        cl = " ".join(x for x in ("num" if i in num_cols else "", "nw" if i in nowrap_cols else "") if x)
        attr = ' class="' + cl + '"' if cl else ""
        return f"<{tag}{attr}>{c}</{tag}>"
    th = "".join(cell("th", i, h) for i, h in enumerate(head))
    body = "".join("<tr>" + "".join(cell("td", i, c) for i, c in enumerate(r)) + "</tr>" for r in rows)
    cap = f"<caption>{caption}</caption>" if caption else ""
    return f'<div class="scroll"><table{f" class={cls}" if cls else ""}>{cap}<tr>{th}</tr>{body}</table></div>'


def figure(data: str | None, label: str, caption: str, source: str, narrow: bool = False) -> str:
    """插图。label 写 F.new(key)；data 是 png()/jpg() 的返回值。图题在图下方，第二行写数据来源。

    data 为 None 时仍占一个编号并照实写「无可绘制的数据」，使编号与正文引用保持一致。"""
    cls = " class=narrow" if narrow else ""
    if not data:
        return (f"<figure{cls}><figcaption><b>{label}</b>　{caption}（无可绘制的数据）"
                f"<br>数据来源：{source}</figcaption></figure>")
    return (f'<figure{cls}><img alt="{label}" src="data:{data}">'
            f"<figcaption><b>{label}</b>　{caption}<br>数据来源：{source}</figcaption></figure>")


def finding(title: str, obs: str, ana: str, attr: str, level: str, html_ok: bool = False) -> str:
    """一个不符合项：观测（测得的事实）/ 分析（机理与证据）/ 归因（一句话原因）+ 归因等级。

    缺省把四段都当纯文本转义；html_ok=True 时原样放入（调用方负责转义，用于含链接等标记的分析段）。
    引用占位符（T.ref、R.cite）不受转义影响，可直接写进纯文本。"""
    if level not in LEVELS:
        raise ValueError(f"归因等级只能是 {'/'.join(LEVELS)}，收到「{level}」")
    f = (lambda s: s) if html_ok else e
    return (f'<div class="finding"><p><strong>{f(title)}</strong></p>'
            f'<p><span class=lab>观测</span>{f(obs)}</p>'
            f'<p><span class=lab>分析</span>{f(ana)}</p>'
            f'<p><span class=lab>归因</span>{f(attr)}归因等级：{level}。</p></div>')


CSS = """
:root{--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9;--axis:#c3c2b7;--surface:#fcfcfb;--plane:#f9f9f7;
--ok:#0ca30c;--gap:#d03b3b;--accent:#2a78d6}
*{box-sizing:border-box}
html{color-scheme:light}
body{margin:0;background:var(--plane);color:var(--ink);font:15px/1.7 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",
system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:36px 16px 64px;background:var(--surface)}
h1{font-size:26px;line-height:1.3;margin:0 0 4px}
.subtitle{font-size:17px;color:var(--ink2);margin:0 0 18px}
h2{font-size:20px;margin:44px 0 10px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:28px 0 8px}
h4{font-size:15px;margin:20px 0 6px}
p,li{max-width:80ch}
table.info td:first-child{color:var(--ink2);width:9em}
.abstract{background:var(--plane);border:1px solid var(--line);padding:12px 16px;margin:16px 0}
.abstract p{margin:6px 0}
table{border-collapse:collapse;width:100%;margin:6px 0 18px;font-size:13.5px}
caption{caption-side:top;text-align:left;font-weight:600;font-size:13.5px;color:var(--ink);padding:4px 0}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--ink2);font-weight:600;background:var(--plane)}
td.num{font-variant-numeric:tabular-nums}
.nw{white-space:nowrap}
table.wide{min-width:760px}
.c{display:block;text-align:center}
.sub{color:var(--muted);font-size:12px}
.badge{display:inline-block;font-size:12.5px;font-weight:600;white-space:nowrap}
.badge.ok::first-letter{color:var(--ok)}
.badge.gap::first-letter{color:var(--gap)}
.badge.na{color:var(--muted)}
.finding{margin:10px 0 14px;padding-left:12px;border-left:3px solid var(--line)}
.finding p{margin:4px 0}
.lab{display:inline-block;min-width:3.2em;font-weight:600;color:var(--ink2)}
figure{margin:12px 0 22px}
figure.narrow{max-width:560px}
figure img{width:100%;height:auto;display:block;border:1px solid var(--line)}
figcaption{font-size:13px;color:var(--ink2);margin-top:6px}
figcaption b{color:var(--ink)}
details{margin:6px 0}
summary{cursor:pointer;color:var(--ink2)}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.ids{font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink2);word-break:break-all}
.toc{columns:2;font-size:14px}
.toc a,.xref{color:var(--accent);text-decoration:none}
.scroll{overflow-x:auto}
ol.refs li{margin:2px 0}
@media (max-width:640px){.toc{columns:1}}
@media print{body{background:#fff}main{max-width:none;padding:0}h2{break-before:page}figure,table,.finding{break-inside:avoid}}
"""


class Report:
    """报告骨架：封面信息、摘要、目录、各节。write() 统一解析编号并检查占位符残留。"""

    def __init__(self, title: str, subtitle: str = "", short_title: str | None = None,
                 info: list[tuple[str, str]] | tuple = (), css: str = CSS, lang: str = "zh-CN"):
        self.title, self.subtitle = title, subtitle
        self.short_title = short_title or title
        self.info = list(info)
        self.css, self.lang = css, lang
        self.tables, self.figures, self.refs = Counter("表", "T"), Counter("图", "F"), Refs()
        self._abstract = ""
        self._sections: list[tuple[str, str, str, bool]] = []

    def abstract(self, *paras: str, heading: str = "摘要") -> None:
        """摘要段落（HTML）。第一段说做了什么、怎么做；第二段给结果与分级；末段写数据状态声明。"""
        self._abstract = (f'<div class="abstract"><p><strong>{e(heading)}</strong></p>'
                          + "".join(f"<p>{p}</p>" for p in paras) + "</div>")

    def section(self, sid: str, title: str, body: str, toc: bool = True) -> None:
        """一章。title 写「3　方法」「附录 A　样本清单」（编号与标题之间用全角空格）。必须按版面顺序调用。"""
        if any(s[0] == sid for s in self._sections):
            raise ValueError(f"章节 id 重复：{sid}")
        self._sections.append((sid, title, body, toc))

    def html(self) -> str:
        info = table("", ["项目", "内容"], [[e(k), v] for k, v in self.info], cls="info") if self.info else ""
        toc_items = [(sid, t) for sid, t, _, show in self._sections if show]
        toc = ("<h2>目录</h2><nav class=toc>" + "".join(f'<div><a href="#{sid}">{e(t)}</a></div>' for sid, t in toc_items)
               + "</nav>") if toc_items else ""
        body = "\n".join(f"<h2 id={sid}>{e(t)}</h2>\n{b}" for sid, t, b, _ in self._sections)
        page = (f'<!doctype html>\n<html lang="{self.lang}"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                f"<title>{e(self.short_title)}</title><style>{self.css}</style></head><body><main>\n"
                f"<h1>{e(self.title)}</h1>" + (f'<p class="subtitle">{e(self.subtitle)}</p>' if self.subtitle else "")
                + f"\n{info}\n{self._abstract}\n{toc}\n{body}\n</main></body></html>\n")
        page = self.refs.resolve(self.figures.resolve(self.tables.resolve(page)))
        if _OPEN in page or _CLOSE in page:
            raise ValueError("报告里还有未替换的占位符")
        return page

    def write(self, path: str) -> str:
        page = self.html()
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(page)
        return path


# ---------------------------------------------------------------- 作图（需要 matplotlib）

# 浅色底上的参考色：前三个系列色依次给「主要比较对象 / 被测对象 / 参照」，次序固定，不随数据增减而轮换
COLORS = {"ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781", "grid": "#e1e0d9", "axis": "#c3c2b7",
          "surface": "#fcfcfb"}
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#8a5cd6", "#d6a12a"]
FONTS = ["PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", "SimHei", "Arial Unicode MS"]


def mpl(salt: str = "report"):
    """返回配置好的 matplotlib.pyplot：中文字体回退、浅色网格、无上右边框、SVG 哈希盐固定（输出可复现）。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    c = COLORS
    plt.rcParams.update({
        "font.family": "sans-serif", "font.sans-serif": FONTS + ["DejaVu Sans"], "axes.unicode_minus": False,
        "font.size": 9, "axes.edgecolor": c["axis"], "axes.labelcolor": c["ink2"], "xtick.color": c["muted"],
        "ytick.color": c["muted"], "axes.grid": True, "grid.color": c["grid"], "grid.linewidth": 0.6,
        "axes.facecolor": c["surface"], "figure.facecolor": c["surface"], "legend.frameon": False,
        "axes.spines.top": False, "axes.spines.right": False, "svg.hashsalt": salt,
    })
    return plt


def png(fig, dpi: int = 110) -> str:
    """线图用 PNG，不写软件元数据（否则版本号进文件，换机器即不逐字节相同）。返回「媒体类型;base64,数据」。"""
    import matplotlib.pyplot as plt
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, metadata={"Software": None})
    plt.close(fig)
    return "image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def jpg(fig, dpi: int = 110, quality: int = 85) -> str:
    """热图、时频图等噪声纹理多的图用 JPEG（按 PNG 存常大十倍）。Pillow 对同一输入编码结果逐字节相同。"""
    import matplotlib.pyplot as plt
    buf = io.BytesIO()
    fig.savefig(buf, format="jpg", dpi=dpi, pil_kwargs={"quality": quality, "optimize": True})
    plt.close(fig)
    return "image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# ---------------------------------------------------------------- 自检

def _selftest() -> None:
    T = Counter("表", "T")
    text = f"见{T.ref('b')}与{T.ref('a')}。" + T.new("a") + T.new("b") + T.new()
    assert T.resolve(text) == "见表 2与表 1。表 1表 2表 3", T.resolve(text)
    try:
        T.resolve(T.ref("none"))
        raise AssertionError("未报出不存在的编号")
    except ValueError:
        pass
    R = Refs()
    R.add("a", "文献甲")
    R.add("b", "文献乙")
    out = R.resolve(f"先引{R.cite('b')}，再引{R.cite('a', 'b')}。" + R.list_html())
    assert out.startswith("先引[1]，再引[2，1]。<ol class=refs><li>文献乙</li><li>文献甲</li></ol>"), out
    R2 = Refs()
    R2.add("a", "甲")
    R2.add("b", "乙")
    try:
        R2.resolve(R2.cite("a") + R2.list_html())
        raise AssertionError("未报出未引用的文献")
    except ValueError:
        pass
    assert (num(-0.034, 3, signed=True), num(3.2, 1, "%", signed=True), num(5, 0, "mm"), num(None)) == (
        "\u22120.034", "+3.2%", "5 mm", "—")
    C = Chapters([("a", "甲"), ("b", "乙")])
    assert (C.ch("b"), C.ch("b", 3), C.title("b"), C.sid("a")) == ("2", "2.3", "2　乙", "s1")
    assert [grade(k, n) for k, n in ((4, 5), (3, 5), (2, 5), (0, 0))] == ["充分验证", "初步支持", "未验证", "未验证"]
    for bad in (lambda: verdict("一致"), lambda: finding("t", "o", "a", "r", "可能")):
        try:
            bad()
            raise AssertionError("未拒绝非固定用语")
        except ValueError:
            pass
    rpt = Report("测试报告", info=[("版本", "v0")])
    rpt.section("s1", "1　测试", f"<p>见{rpt.tables.ref('x')}。</p>" + table(f"{rpt.tables.new('x')}　测试表", ["a"], [["1"]]))
    page = rpt.html()
    assert "<caption>表 1　测试表</caption>" in page and "见表 1。" in page and _OPEN not in page
    assert page == rpt.html(), "同一输入两次生成不相同"
    print("report_kit 自检通过")


if __name__ == "__main__":
    _selftest()
