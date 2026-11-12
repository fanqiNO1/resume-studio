# 贡献指南

感谢参与。这个仓库的价值在于**排版精度**，所以贡献时请优先保证"预览 = PDF"这条不变量。

## 环境

```bash
pnpm install
pnpm run fonts     # 生成字体子集（需要 Python 3 + fonttools + brotli）
pnpm run dev       # → http://127.0.0.1:5178
```

**仓库不分发任何字体**，字体子集各人本机生成，产物只落在本机（已 gitignore）。
默认档案 `adobe`（与参考排版一致：Termes + 宋体/黑体/楷体）用的是商业字体，
需要自备：

```bash
RESUME_FONT_SRC=<你的字体目录> pnpm run fonts
```

没有这些字体、只想跑起来看效果，用 `oss` 档案（OFL，可下载到本机，同样不入库）：

```bash
bash scripts/prepare-fonts.sh        # 下载 TeX Gyre Termes + Noto Serif/Sans SC 并切子集
```

## 提交前必跑

```bash
pnpm test                # 单元测试
pnpm run typecheck       # vue-tsc
pnpm run check:fidelity  # 需要 dev server 在另一个终端跑着
```

`check:fidelity` 比对**预览环境**与**导出环境**算出的分页结果（每页的 block 序列 +
块内 y 偏移）。它失败 = 预览和 PDF 已经不一致，这是本项目唯一不能出的错。
**不要靠调容差让它变绿。**

改了 `src/render/` 或 `src/styles/` 就必须跑；改了其他部分可以不跑，但跑了更保险。

## 硬约束

摘自 [`AGENTS.md`](AGENTS.md)，摘要：

1. **不要把真实简历内容写进仓库。** `data/` 是使用者自己的数据，已被 `.gitignore` 忽略。
   测试固件只用 `data.sample/`（虚构人物「示例人」）。
2. **不要引入新依赖**，除非先开 issue 讨论。依赖清单是刻意精简的。
3. **不要分发字体文件 —— 任何字体都不分发。** 仓库里只有「字体档案」
   （`scripts/font-profiles/*.json`）描述要用哪些字重；源字体与子集产物都在
   使用者本机，不入库。
4. **预览与导出必须共用同一套渲染逻辑**（`resolve → blocks → inline → autospace →
   paginate`，同一套 CSS、同一批字体）。允许不同的只有质量档。
5. **不要在 `data/` 里就地覆盖写。** 先备份到 `data/.trash/`，再原子写（临时文件 + rename）。

## 提交信息

中文，一句话说清做了什么。示例：

- `分页器：长段落支持按行盒切分（P1）`
- `编辑器：论文条目增加 venueShort 字段`

## Pull Request

- 一个 PR 做一件事，别把重构和功能混在一起。
- 描述里写清楚**动机**与**怎么验证的**（贴 `check:fidelity` 的输出最好）。
- 改了排版观感的话，附上改动前后的 PDF 或截图。

## 路线图

未完成项见 [`docs/DESIGN.md`](docs/DESIGN.md) §12。想认领哪一项，先开 issue 认领，
避免两个人做同一件事。
