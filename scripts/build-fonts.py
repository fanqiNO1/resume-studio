#!/usr/bin/env python3
"""
字体管线：把字体切成 woff2 子集，供预览与 PDF 导出共用。

三个关键决定，都是实测出来的：

1) **必须转成 glyf（TrueType）轮廓。**
   Chromium/Skia 无法把 CFF / CID-keyed 字体嵌进 PDF，会退化成 Type3 —— 逐字形
   填充路径，没有 hinting、没有 stem darkening，屏幕分辨率下明显发虚。
   转成 glyf 后 Chromium 会正常做 Type0 子集嵌入，清晰度与 xelatex 的产物对齐。
   代价：cu2qu 三次→二次贝塞尔近似，误差 < 1/1000 em，且**不改变字宽**，
   所以排版度量完全不变（由 check:fidelity 兜底验证）。

2) **必须自托管。**
   用户可能通过端口转发在另一台机器的浏览器里编辑，那台机器不保证有这些字体。

3) **字体必须是可自由使用的。**
   仓库里不附带任何字体文件（体积大 + 许可各异），而是由「字体档案
   （font profile）」描述"要哪些字重、分别用哪个字体文件"，脚本在系统字体目录里
   找源文件。内置档案：

   - `oss`（默认）：TeX Gyre Termes（拉丁，OFL）+ Noto Serif/Sans CJK（中文，OFL）
   - `adobe`：TeX Gyre Termes + Adobe 宋体/黑体/楷体（与 resume.cls 的 xeCJK
     映射一致）。这些字体**不是自由字体**，需要自行准备，本仓库不分发。

用法：
    python3 scripts/build-fonts.py                     # 用默认档案 oss
    python3 scripts/build-fonts.py --profile oss       # 显式指定
    python3 scripts/build-fonts.py --src ~/my-fonts    # 从自定义目录找源字体
    python3 scripts/build-fonts.py --list-profiles
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    from fontTools.ttLib import TTCollection, TTFont, newTable
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.subset import main as subset_main
except ImportError:
    sys.exit("缺少 fontTools。请先 pip install fonttools brotli")

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "fonts" / "generated"
WORK_DIR = ROOT / ".dev" / "fontwork"
PROFILE_DIR = Path(__file__).resolve().parent / "font-profiles"

# 拉丁字母数字与西文标点。约 15KB，首屏即可用。CJK 标点见下方 CJK_PUNCT。
BASE_RANGES = ",".join([
    "U+0000-00FF", "U+0131", "U+0152-0153", "U+02BB-02BC", "U+02C6", "U+02DA",
    "U+02DC", "U+2000-206F", "U+2074", "U+20AC", "U+2122", "U+2191", "U+2193",
    "U+2212", "U+2215", "U+FEFF", "U+FFFD",
])

# CJK 标点与全角形式：必须由中文字体提供。
# 拉丁字体里没有全角逗号、书名号这些字形；若把 U+FF00-FFEF 声明在拉丁那一档，
# 浏览器不会继续往下找 CJK 字体，而是直接落到系统字体 —— 观感不对，
# 且 Chromium 对系统 CFF 字体只能以 Type3 嵌入。
CJK_PUNCT = set()
for _lo, _hi in ((0x3000, 0x303F), (0xFE10, 0xFE19), (0xFE30, 0xFE4F), (0xFF00, 0xFFEF)):
    CJK_PUNCT |= set(range(_lo, _hi + 1))


def gb2312_codepoints() -> set[int]:
    """
    GB2312 能编码的汉字集合（一级 3755 + 二级 3008 = 6763 字）。

    不外挂字表，直接用编解码器枚举 —— 少一个需要维护的数据文件。
    """
    out = set()
    for cp in range(0x4E00, 0xA000):
        try:
            chr(cp).encode("gb2312")
        except UnicodeEncodeError:
            continue
        out.add(cp)
    return out


def to_css_ranges(codepoints: set[int]) -> str:
    """把码位集合压成紧凑的 unicode-range 表达式"""
    parts: list[str] = []
    for cp in sorted(codepoints):
        if parts:
            last = parts[-1]
            start, _, end = last.partition("-")
            end_cp = int(end or start, 16)
            if cp == end_cp + 1:
                parts[-1] = f"{start}-{cp:X}"
                continue
        parts.append(f"{cp:X}")
    return ",".join(f"U+{p}" for p in parts)


def to_subset_unicodes(codepoints: set[int]) -> str:
    """pyftsubset 的 --unicodes 语法（不带 U+ 前缀的区间列表）"""
    return to_css_ranges(codepoints).replace("U+", "")


# 分两层：常用字先加载，生僻字按需加载。
# 浏览器按 unicode-range 只下载真正用到的那一层，所以既小又不会缺字。
_GB = gb2312_codepoints()
_ALL_CJK = set(range(0x3400, 0x4DC0)) | set(range(0x4E00, 0xA000))
CJK_TIER1 = _GB | CJK_PUNCT          # 约 6763 汉字 + CJK 标点／全角形式
CJK_TIER2 = _ALL_CJK - CJK_TIER1     # 其余，含生僻字与扩展 A

# cu2qu 的最大近似误差，单位是 em 的比例。1/1000 em 在 10pt 下约 0.01pt，
# 肉眼与度量都不可见。
CU2QU_MAX_ERR = 1.0


# ---------------------------------------------------------------------------
# 字体档案（profile）
# ---------------------------------------------------------------------------


@dataclass
class FontSpec:
    """一个"字重/字形角色" → 一个源字体文件（可选斜切、集合内某个 face）"""

    role: str                 # latin-400 / cjk-700 / ui-400 …
    files: list[str]          # 候选源文件名（按顺序找第一个存在的）
    faces: list[str] = field(default_factory=list)  # 集合字体里要挑的 family name
    slant: float = 0.0        # 合成斜体：x' = x + slant * y（0 表示不处理）
    weight: int | None = None  # 变量字体要实例化到的字重（None = 不实例化）
    optional: bool = False    # 缺了也不致命（界面字体）
    extra: dict = field(default_factory=dict)


def load_profile(profile_id: str) -> dict:
    path = PROFILE_DIR / f"{profile_id}.json"
    if not path.exists():
        sys.exit(
            f"找不到字体档案 {path}\n"
            f"可用档案：" + "、".join(sorted(p.stem for p in PROFILE_DIR.glob('*.json')))
        )
    return json.loads(path.read_text(encoding="utf8"))


# 找源字体的候选目录。覆盖 Linux / macOS / Windows 的常见安装位置。
SYSTEM_FONT_DIRS = [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    "/usr/share/texmf/fonts/opentype/public",
    "/usr/share/texlive/texmf-dist/fonts/opentype/public",
    "/opt/homebrew/share/fonts",
    "/Library/Fonts",
    "/System/Library/Fonts",
    "~/Library/Fonts",
    "~/.fonts",
    "~/.local/share/fonts",
    "C:/Windows/Fonts",
]


def find_source(name: str, extra_dirs: list[str]) -> Path | None:
    """
    按文件名（精确匹配）在自定义目录与系统字体目录里找源字体。

    用 os.walk 而不是 rglob：字体文件名里可能带 glob 特殊字符
    （Noto 的可变字体叫 `NotoSerifSC[wght].ttf`），rglob 会把它当字符类。
    """
    seen: set[str] = set()
    roots: list[Path] = []
    for d in extra_dirs:
        p = Path(d).expanduser()
        if p.is_file():
            if p.name == name:
                return p
        elif p.is_dir():
            roots.append(p)
    for root in SYSTEM_FONT_DIRS:
        p = Path(root).expanduser()
        if p.is_dir():
            roots.append(p)

    for root in roots:
        if str(root) in seen:
            continue
        seen.add(str(root))
        for dirpath, _dirnames, filenames in os.walk(root):
            if name in filenames:
                return Path(dirpath) / name
    return None


# ---------------------------------------------------------------------------
# 轮廓转换
# ---------------------------------------------------------------------------


def is_cff(font: TTFont) -> bool:
    return "glyf" not in font and ("CFF " in font or "CFF2" in font)


def cff_to_glyf(src: Path, dest: Path) -> None:
    """
    把 CFF 轮廓转成 glyf（TrueType）轮廓。

    等价于社区常用的 otf2ttf：用 Cu2QuPen 把三次贝塞尔近似成二次，写进 glyf。
    只改轮廓表示，不动 hmtx（字宽）与 cmap，所以排版度量不变。
    """
    font = TTFont(str(src))
    if not is_cff(font):
        # 已经是 glyf，直接拷过去
        shutil.copyfile(src, dest)
        return

    glyph_set = font.getGlyphSet()
    glyph_order = font.getGlyphOrder()
    glyf_glyphs = {}

    for name in glyph_order:
        pen = TTGlyphPen(glyf_glyphs)
        # reverse_direction=True：TrueType 的外轮廓方向与 CFF 相反，
        # 不翻转会让所有字形变成"空心"
        cu2qu = Cu2QuPen(pen, CU2QU_MAX_ERR, reverse_direction=True)
        glyph_set[name].draw(cu2qu)
        glyf_glyphs[name] = pen.glyph()

    glyf = newTable("glyf")
    glyf.glyphOrder = glyph_order
    glyf.glyphs = glyf_glyphs
    font["glyf"] = glyf

    # loca 由 glyf 编译时生成，但表必须存在
    font["loca"] = newTable("loca")

    # maxp 从 CFF 的 0.5 版升到 TrueType 的 1.0 版，并按 glyf 重算各项上限
    maxp = newTable("maxp")
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = 0
    maxp.maxComponentDepth = 0
    font["maxp"] = maxp

    # post 表：CFF 用 3.0（无字形名），TrueType 惯例用 2.0 携带字形名。
    # 但 2.0 的标准名索引是 unsigned short，字形数超过 65535-258 时会溢出
    # （Noto CJK 每个 face 就有 65535 个字形）—— 那种情况退回 3.0。
    if "post" in font:
        if len(glyph_order) <= 65535 - 258:
            font["post"].formatType = 2.0
            font["post"].extraNames = []
            font["post"].mapping = {}
            font["post"].glyphOrder = glyph_order
        else:
            font["post"].formatType = 3.0
            if hasattr(font["post"], "extraNames"):
                font["post"].extraNames = []
            if hasattr(font["post"], "mapping"):
                font["post"].mapping = {}

    font["head"].indexToLocFormat = 0
    font.sfntVersion = b"\x00\x01\x00\x00"  # 'true'/TrueType 标识

    for tag in ("CFF ", "CFF2", "VORG"):
        if tag in font:
            del font[tag]

    font.save(str(dest))
    # 重新加载一遍，让 maxp 的各项上限由 fontTools 按实际 glyf 重算
    reloaded = TTFont(str(dest))
    reloaded["maxp"].recalc(reloaded)
    reloaded.save(str(dest))


def slant_glyf(src: Path, dest: Path, slant: float) -> None:
    """
    给已有 glyf 轮廓加合成斜体（x' = x + slant·y）。

    用于没有斜体字重的字体（Noto CJK 只有 Regular/Bold）。浏览器对缺斜体的
    字体本来也会做同样的合成，我们提前做掉，好处是**预览与 PDF 用同一份字形**，
    不会出现"浏览器合成了、PDF 没合成"的分歧。

    只改轮廓，不动 hmtx —— 斜体不改变字宽，所以排版度量与正体一致。
    """
    font = TTFont(str(src))
    glyph_set = font.getGlyphSet()
    glyph_order = font.getGlyphOrder()
    glyf_glyphs = {}

    for name in glyph_order:
        pen = TTGlyphPen(glyf_glyphs)
        transform = TransformPen(pen, (1, 0, slant, 1, 0, 0))
        glyph_set[name].draw(transform)
        glyf_glyphs[name] = pen.glyph()

    font["glyf"].glyphs = glyf_glyphs
    # 只有"我们合成的斜体"才改名：字体本来就有斜体字重时（如楷体）不要动它的名字，
    # 否则产物与原排版基线对不上。
    _rename_italic(font)
    font.save(str(dest))
    reloaded = TTFont(str(dest))
    reloaded["maxp"].recalc(reloaded)
    reloaded.save(str(dest))


def _rename_italic(font: TTFont) -> None:
    """在名字里标出 Italic —— 合成斜体之后字体已经不是原来那一档了。

    用 name.setName 而不是直接改 record.string：后者要自己处理各平台的编码，
    很容易把 UTF-16BE 的 BOM 当成字符写进去（PDF 里会看到乱码）。
    """
    name_table = font["name"]
    family = name_table.getDebugName(1) or "Font"
    subfamily = name_table.getDebugName(2) or "Regular"
    full = name_table.getDebugName(4) or f"{family} {subfamily}"
    ps = name_table.getDebugName(6) or full.replace(" ", "")

    def with_italic(text: str) -> str:
        return text if "Italic" in text else f"{text} Italic"

    # PostScript 名（nameID 6）不能带空格：Chromium 把它写进 PDF 时会把空格
    # 变成 U+3000（中文全角空格），PDF 阅读器的字体列表里就是一片乱码。
    ps_base = re.sub(r"\s+", "", ps)
    ps_base = re.sub(
        r"-(Regular|Bold|Medium|SemiBold|Light|ExtraLight|Black|Thin|Italic)$", "", ps_base
    )
    ps_new = f"{ps_base}-Italic"

    for name_id, text in (
        (1, family),
        (2, subfamily),
        (4, full),
        (6, ps_new),
        (16, family),
        (17, subfamily),
    ):
        value = with_italic(text)
        for platform_id, encoding_id, lang_id in ((3, 1, 0x409), (1, 0, 0)):
            try:
                name_table.setName(value, name_id, platform_id, encoding_id, lang_id)
            except Exception:  # 某些平台没有这个 nameID，跳过即可
                pass


def open_font(path: Path, face_hints: list[str] | str = "") -> TTFont:
    """
    打开源字体；集合字体（.ttc/.otc）按 family name 挑出目标 face。

    Noto CJK 的 .ttc 里塞了几十个 face（SC/TC/JP/KR × 多字重），必须按名字挑，
    否则会拿到日文或港标的字形。
    """
    hints = [face_hints] if isinstance(face_hints, str) else list(face_hints)
    if path.suffix.lower() in (".ttc", ".otc"):
        collection = TTCollection(str(path), lazy=True)
        for hint in hints:
            for i, font in enumerate(collection.fonts):
                for record in font["name"].names:
                    if record.nameID in (1, 16) and hint in str(record):
                        return TTFont(str(path), fontNumber=i, lazy=False)
        # 没指定名字（或没匹配上）就用第一个
        return TTFont(str(path), fontNumber=0, lazy=False)
    return TTFont(str(path), lazy=False)


def instantiate_weight(font: TTFont, weight: int) -> TTFont:
    """把变量字体（fvar）在 wght 轴上实例化成静态字重"""
    try:
        from fontTools.varLib import instancer
    except ImportError:
        sys.exit("缺少 fontTools 的 varLib 模块，无法实例化变量字体")
    axes = {a.axisTag: a for a in font["fvar"].axes}
    if "wght" not in axes:
        return font
    # updateFontNames=True：实例化后名字跟着实例走（Regular / Bold …）。
    # Google Fonts 的可变字体默认实例是 ExtraLight（wght=200），不改名字的话
    # 嵌进 PDF 会显示成 ExtraLight，看着像字重错了。
    return instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False, updateFontNames=True)


def subset(src: Path, dest: Path, ranges: str, features: str) -> None:
    """
    切子集并压成 woff2。

    注意**不加** --no-hinting / --desubroutinize：那会去掉字形的 hint 信息，
    PDF 阅读器就无法做网格拟合，正是我们要修的"发虚"问题的一部分。
    """
    subset_main([
        str(src),
        f"--unicodes={ranges}",
        f"--layout-features={features}",
        "--flavor=woff2",
        "--drop-tables+=DSIG,FFTM",
        "--notdef-outline",
        f"--output-file={dest}",
    ])


def verify(path: Path) -> str:
    font = TTFont(str(path))
    kind = "glyf" if "glyf" in font else ("CFF" if is_cff(font) else "?")
    return kind


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------


@dataclass
class Face:
    """一个字形来源 → 一个 woff2 产物"""
    out: str
    spec: FontSpec
    ranges: str
    layout_features: str = "kern,liga,clig,calt"


def build_faces(profile: dict) -> tuple[list[Face], list[Face]]:
    """按档案产出（简历用 face 列表，界面用 face 列表）"""
    resume_faces: list[Face] = []
    ui_faces: list[Face] = []

    def as_list(v) -> list[str]:
        if v is None:
            return []
        return [v] if isinstance(v, str) else list(v)

    for role, entry in profile.get("latin", {}).items():
        spec = FontSpec(
            role=f"latin-{role}",
            files=as_list(entry["file"]),
            faces=as_list(entry.get("face")),
        )
        resume_faces.append(Face(f"serif-{role}-base.woff2", spec, BASE_RANGES))

    for entry in profile.get("cjk", []):
        role = entry["role"]
        spec = FontSpec(
            role=f"cjk-{role}",
            files=as_list(entry["file"]),
            faces=as_list(entry.get("face")),
            slant=float(entry.get("slant", 0.0)),
            weight=entry.get("weight"),
        )
        resume_faces.append(Face(f"serif-{role}-cjk1.woff2", spec, to_subset_unicodes(CJK_TIER1), "kern"))
        resume_faces.append(Face(f"serif-{role}-cjk2.woff2", spec, to_subset_unicodes(CJK_TIER2), "kern"))

    for weight, entry in profile.get("ui", {}).items():
        spec = FontSpec(
            role=f"ui-{weight}",
            files=as_list(entry["file"]),
            faces=as_list(entry.get("face")),
            weight=int(weight),
            optional=True,   # 界面字体缺失只影响观感，不影响功能
        )
        ui_faces.append(Face(f"ui-{weight}.woff2", spec, BASE_RANGES, "kern,liga,clig,calt,tnum"))

    return resume_faces, ui_faces


def prepare_work_font(spec: FontSpec, src: Path) -> Path:
    """把源字体转成 work 目录里的 glyf 版本（必要时加合成斜体）"""
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    stem = Path(src.name).stem
    base = WORK_DIR / f"{stem}.ttf"

    if not base.exists():
        font = open_font(src, spec.faces)
        # 变量字体（fvar）先实例化到目标字重，再切子集 ——
        # 否则一份可变字体会同时带 400/700 两套轮廓，子集文件白白大一倍。
        if spec.weight is not None and "fvar" in font:
            font = instantiate_weight(font, spec.weight)
        tmp = WORK_DIR / f"{stem}.raw.ttf"
        font.save(str(tmp))
        cff_to_glyf(tmp, base)
        tmp.unlink(missing_ok=True)

    if spec.slant:
        slanted = WORK_DIR / f"{stem}-slant{spec.slant}.ttf"
        if not slanted.exists():
            slant_glyf(base, slanted, spec.slant)
        return slanted
    return base


def main() -> None:
    parser = argparse.ArgumentParser(description="构建自托管字体子集")
    parser.add_argument(
        "--profile",
        default=os.environ.get("RESUME_FONT_PROFILE", "adobe"),
        help="字体档案名（scripts/font-profiles/*.json）。"
             "默认 adobe（与参考排版一致，字体需自备）；"
             "可用环境变量 RESUME_FONT_PROFILE 覆盖。",
    )
    parser.add_argument(
        "--src",
        action="append",
        default=[],
        help="额外的源字体搜索目录，可重复；默认还会搜系统字体目录。"
             "也可用环境变量 RESUME_FONT_SRC（多个目录用冒号分隔）。",
    )
    parser.add_argument(
        "--list-profiles",
        action="store_true",
        help="列出可用档案后退出",
    )
    args = parser.parse_args()

    if args.list_profiles:
        for p in sorted(PROFILE_DIR.glob("*.json")):
            data = json.loads(p.read_text(encoding="utf8"))
            print(f"{p.stem:10} {data.get('name', '')}")
            print(f"{'':10} 许可：{data.get('licenses', '未注明')}")
        return

    profile = load_profile(args.profile)
    resume_faces, ui_faces = build_faces(profile)
    extra_dirs = list(args.src)
    extra_dirs += [p for p in os.environ.get("RESUME_FONT_SRC", "").split(os.pathsep) if p]
    extra_dirs += list(profile.get("search_dirs", []))

    print(f"字体档案：{args.profile} —— {profile.get('name', '')}")
    print(f"许可：{profile.get('licenses', '未注明')}\n")

    # 先把源字体都找齐，找不齐就一次性报清楚，别做到一半才失败。
    # 每个角色有多个候选文件名（系统装的 .ttc / 下载的可变 .ttf / 单语言 .otf），
    # 按顺序取第一个能找到的。
    resolved: dict[str, Path] = {}          # spec.role → 源文件
    missing: list[str] = []
    missing_optional: list[str] = []
    for face in resume_faces + ui_faces:
        if face.spec.role in resolved:
            continue
        found = None
        for name in face.spec.files:
            hit = find_source(name, extra_dirs)
            if hit is not None:
                found = hit
                break
        if found is None:
            label = " 或 ".join(face.spec.files)
            (missing_optional if face.spec.optional else missing).append(label)
        else:
            resolved[face.spec.role] = found

    # 界面字体是可选的：缺了界面退回系统 sans，功能不受影响
    ui_faces = [f for f in ui_faces if f.spec.role in resolved]
    if missing_optional:
        print("跳过可选字体（缺失不影响使用）：" + "、".join(sorted(set(missing_optional))))

    if missing:
        sys.exit(
            "找不到源字体：\n  " + "\n  ".join(sorted(set(missing))) +
            "\n\n处理办法：\n"
            "  · 跑 scripts/prepare-fonts.sh 下载开源字体（推荐，无需 root）\n"
            "  · 或用 --src 指定字体所在目录（可重复）\n"
            "  · 或安装系统字体（Debian/Ubuntu：sudo apt install fonts-noto-cjk fonts-texgyre fonts-inter）\n"
            "  · 或换一个字体档案：--profile"
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    print("转换轮廓（CFF → glyf）并切子集…")
    total = 0
    for face in resume_faces:
        src = resolved[face.spec.role]
        ttf = prepare_work_font(face.spec, src)
        out = OUT_DIR / face.out
        subset(ttf, out, face.ranges, face.layout_features)
        size = out.stat().st_size
        total += size
        print(f"  {face.out:24} {size / 1024:8.0f} KB  轮廓={verify(out)}  ← {src.name}")

    ui_total = 0
    for face in ui_faces:
        src = resolved[face.spec.role]
        ttf = prepare_work_font(face.spec, src)
        out = OUT_DIR / face.out
        subset(ttf, out, face.ranges, face.layout_features)
        size = out.stat().st_size
        ui_total += size
        print(f"  {face.out:24} {size / 1024:8.0f} KB")
    total += ui_total

    (ROOT / "public" / "fonts" / "fonts.css").write_text(
        build_css(profile, [f.spec.weight for f in ui_faces]), encoding="utf8"
    )

    latin = sum((OUT_DIR / f.out).stat().st_size for f in resume_faces if f.out.endswith("base.woff2"))
    tier1 = sum(
        (OUT_DIR / f.out).stat().st_size
        for f in resume_faces
        if f.out.endswith("cjk1.woff2")
    )
    print(f"\n合计 {total / 1024 / 1024:.1f} MB → public/fonts/generated/")
    print(
        f"典型首屏只需 {(latin + tier1) / 1024 / 1024:.1f} MB"
        f"（拉丁 {latin / 1024:.0f} KB + 常用汉字各字重）；"
        f"生僻字才会触发第二层"
    )
    print("已写出 public/fonts/fonts.css")


def build_css(profile: dict, ui_weights: list[int]) -> str:
    """
    生成 @font-face。

    用 unicode-range 把同一个 font-family 的拉丁段与 CJK 段指向不同字体文件，
    正是 xeCJK 在做的事：拉丁走 Termes，中文走宋体/黑体/楷体。
    CJK 再按常用度分两层，浏览器只下载真正用到的那层。

    font-display: block 是有意的 —— 分页器必须在正确的字体 metrics 下测量，
    用回退字体测出来的高度会导致断页位置错误。配合 document.fonts.ready 等待。
    """
    tier1_css = to_css_ranges(CJK_TIER1)
    tier2_css = to_css_ranges(CJK_TIER2)

    def face(weight: int, style: str, variant: str, ranges: str) -> str:
        suffix = f"{weight}{'i' if style == 'italic' else ''}"
        return f"""
@font-face {{
  font-family: 'Resume Serif';
  font-style: {style};
  font-weight: {weight};
  font-display: block;
  src: url('./generated/serif-{suffix}-{variant}.woff2') format('woff2');
  unicode-range: {ranges};
}}"""

    blocks = []
    for weight in (400, 700):
        for style in ("normal", "italic"):
            blocks.append(face(weight, style, "base", BASE_RANGES))
            blocks.append(face(weight, style, "cjk1", tier1_css))
            blocks.append(face(weight, style, "cjk2", tier2_css))

    ui_blocks = [
        f"""
@font-face {{
  font-family: 'Resume UI';
  font-style: normal;
  font-weight: {weight};
  font-display: swap;
  src: url('./generated/ui-{weight}.woff2') format('woff2');
  unicode-range: {BASE_RANGES};
}}"""
        for weight in sorted(ui_weights)
    ]

    return (
        "/* 由 scripts/build-fonts.py 生成，请勿手改 */\n"
        f"/* 字体档案：{profile.get('id', 'oss')} —— {profile.get('name', '')} */\n"
        "/* 拉丁与中文分档：中文标点（U+3000-303F、U+FF00-FFEF）必须由中文字体提供 */\n"
        "/* cjk1 = GB2312 常用字（先加载），cjk2 = 生僻字与扩展 A（按需） */\n"
        + "\n".join(blocks)
        + "\n\n/* 界面字体（仅拉丁；界面中文走系统字体栈）。"
          "font-display: swap 而非 block —— 界面不参与分页测量，不需要等字体。 */"
        + "\n".join(ui_blocks)
        + "\n"
    )


if __name__ == "__main__":
    main()
