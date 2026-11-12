#!/usr/bin/env bash
#
# prepare-fonts.sh —— 下载**开源**字体并生成自托管字体子集。
#
# 仓库不分发任何字体文件（商业的、OFL 的都不分发）。这个脚本只服务于
# `oss` 档案：把 OFL 字体拉到本机 fonts/（已 gitignore），再切子集。
#
# 默认档案是 `adobe`（与参考排版完全一致：Termes + 宋体/黑体/楷体），
# 那三个 Adobe 字体是商业字体，**只能自备**，本脚本帮不上忙：
#   RESUME_FONT_SRC=<你的字体目录> pnpm run fonts
#
# 字体来源（都是 OFL-1.1，可自由使用与再分发）：
#   · TeX Gyre Termes   —— CTAN（拉丁正体/粗体/斜体/粗斜体，合计 ~600KB）
#   · Noto Serif SC     —— Google Fonts（中文正体，可变字体 ~24MB）
#   · Noto Sans SC      —— Google Fonts（中文粗体，可变字体 ~18MB）
#
# 中文字体本来就大（几十 MB），下载慢是正常的；脚本支持断点续传（curl -C -），
# 中断后重跑即可继续。已经装了系统字体（fonts-noto-cjk / tex-gyre）就会跳过下载。
#
# 用法：
#   scripts/prepare-fonts.sh              # 下载 + 用 oss 档案构建子集
#   scripts/prepare-fonts.sh --no-build   # 只下载
#   scripts/prepare-fonts.sh --force      # 重新下载（覆盖已有）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_DIR="$ROOT/fonts"
DO_BUILD=1
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --force)   FORCE=1 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（--no-build / --force / --help）" >&2; exit 2 ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1，请先安装" >&2; exit 1; }
}
need curl
need python3

mkdir -p "$FONT_DIR/tex-gyre" "$FONT_DIR/noto"

# fetch <目标文件> <url> [备用url…]
fetch() {
  local dest="$1"; shift
  if [ -f "$dest" ] && [ "$FORCE" -eq 0 ]; then
    echo "  已存在，跳过：$(basename "$dest")"
    return 0
  fi
  local url
  for url in "$@"; do
    echo "  下载 $(basename "$dest") ← $url"
    # -C - 断点续传：中文字体几十 MB，网络慢时中断不用从头再来
    if curl -fL --retry 3 --retry-delay 2 -C - --progress-bar -o "$dest.part" "$url"; then
      mv "$dest.part" "$dest"
      return 0
    fi
    echo "  该地址失败，试下一个 …"
  done
  rm -f "$dest.part"
  echo "下载失败：$(basename "$dest")" >&2
  return 1
}

# 系统里已经装了这些字体？装了就不用下载（构建脚本会优先用本目录，再搜系统目录）
have_system_font() {
  local pattern="$1"
  for d in /usr/share/fonts /usr/local/share/fonts ~/.fonts ~/.local/share/fonts \
           /usr/share/texmf/fonts/opentype/public; do
    [ -d "$d" ] || continue
    if find "$d" -iname "$pattern" -print -quit 2>/dev/null | grep -q .; then
      return 0
    fi
  done
  return 1
}

echo "==> TeX Gyre Termes（拉丁）"
TG_BASE="https://mirrors.ctan.org/fonts/tex-gyre/opentype"
for f in texgyretermes-regular.otf texgyretermes-bold.otf \
         texgyretermes-italic.otf texgyretermes-bolditalic.otf; do
  fetch "$FONT_DIR/tex-gyre/$f" "$TG_BASE/$f"
done

echo "==> Noto SC（中文）"
if have_system_font "NotoSerifSC*" || have_system_font "NotoSerifCJK*"; then
  echo "  系统已装 Noto Serif CJK，跳过下载（构建时会直接用系统字体）"
else
  # Google Fonts 仓库里的可变字体（wght 轴），构建时实例化到 400 / 700
  fetch "$FONT_DIR/noto/NotoSerifSC[wght].ttf" \
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf" \
    "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf" \
    "https://github.com/google/fonts/raw/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf"
  fetch "$FONT_DIR/noto/NotoSansSC[wght].ttf" \
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf" \
    "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf" \
    "https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf"
fi

echo "==> 字体就绪：$FONT_DIR"
ls -la "$FONT_DIR/noto" 2>/dev/null | sed 's/^/  /' || true

if [ "$DO_BUILD" -eq 1 ]; then
  echo "==> 构建字体子集（glyf 轮廓 + unicode-range 分层）…"
  python3 "$ROOT/scripts/build-fonts.py" --profile oss --src "$FONT_DIR"
  echo
  echo "注意：上面用的是 oss 档案（Noto Serif/Sans SC）。"
  echo "若要与参考排版完全一致（宋体/黑体/楷体），请自备 Adobe 字体后执行："
  echo "  RESUME_FONT_SRC=<你的字体目录> pnpm run fonts"
fi

cat <<'EOF'

下一步：
  pnpm run dev        # 打开 http://127.0.0.1:5178
  fonts/ 目录已被 .gitignore 忽略，不会被提交。

许可：
  TeX Gyre Termes —— SIL Open Font License 1.1
  Noto Serif SC / Noto Sans SC —— SIL Open Font License 1.1
EOF
