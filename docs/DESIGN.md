# 简历维护与导出系统 · 设计文档

> 状态：**v5.2**（M0–M3 已实现并跑通；运行方式见 README.md）
> 目标：本地运行的 Web 应用，表单化维护简历内容，实时预览 A4 排版，导出投递级 PDF；针对不同目标岗位维护多个版本。

变更记录：
- v1：数据布局改为**按岗位分目录**；导出改为**服务端生成 + 流式下载**（适配端口转发）；明确**渲染/导出分离的"渲染契约"**；新增**模板库**；新增**单页压缩策略**；主题微调、字号粒度降级为 TODO；取消 LaTeX 导入，改用合成测例。
- v2：引入**字段归属分级**（shared / position-local），论文的一句话展开归岗位层；**论文作者列表始终完整展示**（取消"一作简述"方案）；模板先只做 1 套，模板库机制保留但降级；文件名用岗位**简称**。
- v3（已实现并验证）：默认模板改为 `academic-serif`，**与 resume.cls 逐行对齐**（页首姓名居中 + 联系方式居中带 · 分隔、小节标题带图标与横线、论文三行式、作者名仅下划线、教育条目两行式）。字体改用 Termes + 中文宋/黑/楷三档，与 xeCJK 映射一致。**字体管线增加 CFF→glyf 转换**：Chromium 无法嵌入 CFF/CID-keyed 字体，会退化成 Type3（这是 PDF 观感不如 LaTeX 的技术原因之一）；转 glyf 后得到正常的 Type0 嵌入，文件体积减半。实测对齐结果：相邻行间距平均偏差 0.31pt、整页累计漂移 +0.01pt。
- v4 / v5：见 §3.4 内联说明（字段审计与撤回记录）。
- v5.2：新增**纯文本 / Markdown 视图**（`Ctrl+4`），供投递表单粘贴用，支持整份与分小节复制（§4.5）；新增**目标篇幅**设置（1–4 页），「压到 1 页」改为「压到 N 页」，并在末页填充率过低时提示「末页偏空」。

---

## 0. 决定摘要

| # | 决定 | 选择 |
|---|---|---|
| 1 | 渲染引擎 | HTML/CSS + 自研分页器；预览与导出共用同一套布局逻辑（§2） |
| 2 | 导出 | **服务端 Playwright 生成 → 落盘 `data/` + 流式下载**，天然支持端口转发（§5） |
| 3 | 数据模型 | 共享内容池 + **按岗位分目录**的覆盖层；复制目录 = fork（§3） |
| 4 | 排版基线 | **只保留 `academic-serif` 一套**，与 [luooofan/resume](https://github.com/luooofan/resume) 的 `resume.cls` 逐行对齐（§8） |
| 5 | 排版调节 | 不给一堆滑杆，给**密度档**（宽松/标准/紧凑/极限）（§7） |
| 7 | 字段归属 | **shared**（池）/ **position-local**（岗位层）两级；论文的一句话展开是 position-local（§3.2） |
| 6 | 技术栈 | Vue 3 + TS + Vite + Pinia + zod + Playwright |

不做英文内容双字段（你不投海外）；英文版通过**模板库里的英文模板**（英文小节标题 + 纯拉丁排版）解决。

---

## 1. 需求确认清单

| 原始需求 | 落点 |
|---|---|
| 多岗位版本，可 fork | §3 按岗位分目录 + §4.2 sidebar |
| 移除需多次确认 | §4.2 三重保护（列出损失 → 手打名称 → 软删除可撤销） |
| 双栏编辑器 + 预览（P0），仅编辑/仅预览（P1） | §4.1 §4.5 |
| 问卷式表单，不看源码，必填/选填 | §4.3 |
| 实时更新 | §2.2（DOM 预览，输入即更新） |
| 某岗位论文要能"加多一点内容" | §3.4 论文条目支持 4 档渲染密度 + bullets + 字段级覆盖 |
| PDF 文件名 `姓名-目标-手机号.pdf` | §5.3 |
| 差异视图要人类可读，不要 git diff 样 | §6 语义化差异摘要 |
| 渲染与导出分离，但观感一致 | §2.5 渲染契约 + 保真校验脚本 |
| data 按岗位分目录 | §3.1 |
| 主题微调优先级低 | §12 TODO |
| 不必 1:1 复刻，想听排版建议 | §8 §11 |
| 端口转发场景下的导出/下载 | §5.2 |
| 希望 1 页 | §11（结论：可达，且不靠缩字号） |
| 不要自由拖拽（放不准 / 强迫症内耗） | §10 非目标 + §7 密度档代偿 |
| 模板库 | §7 |
| `public` 是否公开做成单选 | §3.3 §4.3 |
| 字号间距粒度 | §12 TODO |
| 不做 LaTeX 导入，用合成测例 | §9 |
| 更新 `.gitignore`、写 `AGENTS.md` | 已随本次提交 |

---

## 2. 渲染架构

### 2.1 为什么是 HTML/CSS

关键理由两条：**输入即更新（0 延迟）**、**预览可交互**（点预览跳到表单字段；编辑字段时预览高亮对应区块）。这两点只有 DOM 预览能给。Typst(WASM) 是评估过的唯一严肃替代，作为 plan B 记录在 §13.1。

### 2.2 数据流

```
profile.json（共享内容池）┐
positions/<id>/position.json（覆盖层）├─► resolve() ─► ResolvedResume
templates/<t>.json（表现层参数）      ┘                     │
                                                            ▼
                                                    blocks()  →  Block[]
                                                            │
                                          ┌──────────── paginate() ────────────┐
                                          │ 离屏容器按内容宽度实测每块高度      │
                                          │ 应用断页规则 → pages: Block[][]     │
                                          └────────────────┬───────────────────┘
                              ┌──────────────────────────  ┴─────────────────┐
                              ▼                                             ▼
                    屏幕预览（preview profile）                /print 路由（export profile）
                    阴影 / 缩放 / 高亮 / 标尺                  Playwright → PDF → data/ + 下载
```

### 2.3 页面几何

```
A4 210×297mm
academic-serif 边距：上 21.59 右/左 20.32 下 13.97mm（沿用 resume.cls）
内容区 180mm × 271mm = 510.2pt × 768.2pt = 680.3px × 1024.3px @96dpi
（复刻模板 academic-serif 沿用 resume.cls 的几何：上 21.59 右/左 20.32 下 13.97mm）
```

### 2.4 分页器（`src/render/paginate.ts`）

CSS 的 `break-inside`/`orphans`/`widows` 在 Chromium 里对复杂结构不稳，且**无法在屏幕上显示断页位置**。自己算：

1. blocks 渲染进常驻离屏容器（`position:absolute; visibility:hidden`，宽度 = 内容区宽度）。
2. `getBoundingClientRect()` 逐块测高（含 margin 折叠后的有效值）。
3. 贪心装箱 + 断页规则。

**P0 规则（块级原子）**
- `header` 不可分割，必在第 1 页。
- `sectionTitle` **keep-with-next**：不得成为页内最后一块，至少携带后继条目的标题行 + 1 行内容。
- `entryHeader`（`标题 …… 日期`）与其后第一个内容块 keep-with-next。
- `bullet` 单项原子；`paragraph` 原子。
- 单块超过整页高 → 强制放置 + UI 报警（不静默截断）。

**P1**：用 `Range.getClientRects()` 在行盒边界切分长段落/列表项，`orphans=2 widows=2`。

**输出**：`pages: Block[][]` → 每页一个 `.page` div。打印 CSS：
```css
@page { size: A4; margin: 0; }
.page { width: 210mm; height: 296.9mm; box-sizing: border-box;
        padding: var(--m-top) var(--m-right) var(--m-bottom) var(--m-left);
        overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
```
`296.9mm` 留 0.1mm 余量：Chromium 亚像素舍入偶发多出空白页。Playwright 侧 `preferCSSPageSize: true, margin: 0`。

因为分页是**预计算 + 显式 page 盒子**，打印时 Chromium 没有自主断页空间 → PDF 断页位置结构性等于预览。

### 2.5 渲染契约（对应原始需求第 5 点：渲染与导出分离，观感一致）

**分离的是质量档，不是排版逻辑。** 强制共享的部分（任何一处分叉都视为 bug）：

- `resolve()` → `blocks()` → `inline()` → `autospace()` 同一份代码
- 同一套 CSS 与主题 CSS 变量
- 同一批字体文件（同一字形来源，metrics 必须一致）
- 同一个 `paginate()` 实现与同一份 `breaking` 参数

允许不同的部分：

| | preview profile | export profile |
|---|---|---|
| 触发 | 输入防抖 120ms，增量重排 | 一次性，等 `document.fonts.ready` + `__RESUME_READY__` |
| 字体加载 | unicode-range 分片 woff2，按需 | 完整字体，本地文件 |
| 抗锯齿 | 浏览器默认 | `--font-render-hinting=none --disable-lcd-text` |
| 输出 | 屏幕 CSS px | 矢量 PDF（tagged、链接注解、元数据） |
| 附加 | 阴影/缩放/高亮/标尺/页填充度 | 无装饰 |

**一致性怎么保证（不靠嘴说）**：`npm run check:fidelity`
同一岗位分别在 preview 与 export 环境跑 `paginate()`，比对每页的 block id 序列与页内 y 偏移；序列不同 → 失败，y 偏移超 0.5pt → 警告。接进 CI 与 `pretest`，改 CSS 时排版无声退化会被拦住。

### 2.6 已知坑与对策

| 坑 | 对策 |
|---|---|
| 中英混排缺 xeCJK 自动间距 | 渲染期 auto-space pass，在 CJK↔Latin/数字边界插 `<span class="as">`（`margin-inline:.09em`，不污染复制文本）；可全局开关 |
| CJK 标点占满宽（行首/行尾） | `text-spacing-trim: space-first`（Chromium 123+），可开关 |
| 两端对齐导致西文行过松 | 默认 `justify` + `hyphens: manual`（不断词）；模板可切 `left` |
| `em` 层层相乘舍入漂移 | 全链路 `pt`；仅密度档/auto-fit 用单一 `--scale` |
| 缩放预览改变换行 | `transform: scale()` 作用在固定尺寸 `.page` 外层，不动 `font-size` |
| CJK 字体体积（Noto SC 单字重十几 MB） | 构建期切 unicode-range woff2 分片（GB2312 常用字一层、生僻字一层）；导出用完整本地字体 |
| 图标字体在 PDF 里字距异常/缺字 | **不用图标字体**，内联 SVG（iconify 离线 JSON，构建期取，运行时零网络） |
| 预览浏览器 ≠ 导出 Chromium 的字体渲染微差 | 导出侧重跑分页器（自洽）+ `check:fidelity` 兜底；预览建议 Chromium 系 |

**字体来源用「档案」描述**（`scripts/font-profiles/*.json`）：档案写"哪个角色用哪个字体文件"，
构建脚本在 `--src` 目录与系统字体目录里找源文件。

**仓库不分发任何字体** —— 商业的、OFL 的都不分发，源字体与子集产物都只在使用者本机。
默认档案 `adobe`（与参考排版完全一致：TeX Gyre Termes + 宋体/黑体/楷体）用的是商业字体，
必须自备（`RESUME_FONT_SRC=<目录> pnpm run fonts`）；备选档案 `oss` 用 OFL 的
TeX Gyre Termes + Noto Serif/Sans SC，`scripts/prepare-fonts.sh` 可把 OFL 字体拉到本地
（同样不入库）。中文没有真斜体字重时，脚本**合成**斜体（斜切轮廓、字宽不变），
这样预览与 PDF 用的是同一份字形。

### 2.7 PDF 精校模式（P1）
开关「PDF 精校」：停止输入 600ms 后触发一次真实导出，`pdfjs-dist` 渲染在预览栏。定稿逐页核对用。日常仍用 DOM 预览。

---

## 3. 数据协议

### 3.1 目录布局（按岗位分目录）

`data/` 是使用者自己的数据，**不入库**（`.gitignore` 忽略）；仓库里只保留
`data.sample/`（虚构人物），首次启动时自动复制成 `data/`。

```
data/                                 # 使用者自己的数据（git 忽略）
├── profile.json                      # 共享内容池：唯一数据源
├── positions/
│   ├── general/                      # 目录名 = 岗位 id
│   │   ├── position.json             # 覆盖层：meta / 顺序 / 可见性 / 密度 / 字段覆盖
│   │   ├── local-items.json          # 仅本岗位使用的条目（可选，不进池）
│   │   ├── assets/                   # 本岗位专用资源（可选）
│   │   └── 示例人-通用.pdf              # 导出产物（文件名按模板生成）
│   ├── mllm/
│   └── infra-llm/
├── templates/
│   ├── academic-serif.json            # 内置（只读，随代码分发到此便于查看）
│   └── my-custom.json                # 「存为模板」产生的
├── assets/                           # 共享资源（头像等）
└── .trash/                           # 软删除归档，保留 30 天
```

**没有索引文件**（不设 `positions/_order.json`）。sidebar 直接扫 `positions/*/position.json`，按 `meta.order ?? 目录名` 排序。这样你**直接 `cp -r` 一个目录就是一次 fork**，应用下次扫描自动认领——对应你第 6 点里"直接复制文件也可以"。

- 岗位 `id` = 目录名（重命名 id = 重命名目录，应用可代劳）。
- `meta.name` = 显示名（重命名显示名只改 json，不动目录）。
- 导出 PDF 与数据同目录 → 一个目录自包含"这一版投递用的东西"，打包发给别人 / 归档都方便。

JSON 统一：UTF-8、2 空格缩进、key 顺序稳定、数组顺序即语义顺序、末尾换行。目的是让 `git diff` 可读——这是私有 git 仓库，diff 就是修改历史。

### 3.2 字段归属分级：shared vs position-local

内容只有一份（`profile.json`），但**不是所有字段都该共享**。分两级：

| 级别 | 存哪 | 含什么 | 岗位间关系 |
|---|---|---|---|
| **shared** | `data/profile.json` | 客观事实：论文标题/会议/作者/年份、学校/学位/专业/GPA、公司/职位/起止、项目名称/起止 | 所有岗位共用一份；改一处全局生效 |
| **position-local** | `data/positions/<id>/position.json` | **叙述与取舍**：论文的一句话展开（`pitch`）、论文的补充要点、条目可见性、顺序、密度档 | 各岗位独立，互不影响；池里根本不存这些字段 |

这直接对应当时的判断："履历和论文可以 share，但论文的一句话展开是岗位 specific 的"。

`pitch` 不是"覆盖"某个池里的默认值——**池里没有这个字段**。所以编辑器里它就是一个普通的空输入框，不带"已覆盖 / 恢复继承"那套负担。岗位 A 给某篇论文写一句"提出人类对齐的可解释推理框架，在 4 个 benchmark 上超越 SOTA"，岗位 B 对同一篇论文可以留空或写完全不同的一句——两者毫无耦合。

**项目 / 实习的 bullets 仍是 shared + 岗位级勾选**（`bullets.include`）：这些要点写一次就够用，岗位间的差异主要是"展示哪几条"而非"重写"。真需要改措辞时用 `overrides` 兜底。

三个逃生口，避免"共享"变成束缚：
1. **字段级覆盖** `overrides`：任意 shared 字段都能被某岗位覆盖，其余字段仍继承池。
2. **`local-items.json`**：只在这个岗位有意义的条目（临时为某公司写的项目），不污染池。
3. **`固化`命令**：把某岗位当前解析结果整份物化进它自己的目录，从此与池脱钩（用于"这版已投出去，冻结"或长期归档）。

### 3.3 `profile.json`

```jsonc
{
  "schemaVersion": 1,
  "basics": {
    "name": "示例人",
    "nameEn": "Sample Person",
    "aliases": ["Sample Person", "示例人"],          // 论文作者列表里自动加粗/下划线的匹配名
    "photo": "assets/avatar.jpg",
    "contacts": [
      { "id": "c_phone", "type": "phone",    "value": "000-0000-0000", "sensitive": true },
      { "id": "c_mail",  "type": "email",    "value": "sample@example.com", "sensitive": true },
      { "id": "c_gh",    "type": "github",   "value": "sample", "url": "https://github.com/sample" },
      { "id": "c_home",  "type": "homepage", "value": "sample.github.io", "url": "https://sample.github.io" }
    ]
  },
  "sections": [
    { "id": "sec_edu", "kind": "education",   "title": "教育背景", "icon": "fa6-solid:graduation-cap", "itemIds": ["itm_ms", "itm_bs"] },
    { "id": "sec_pub", "kind": "publication", "title": "论文成果", "icon": "fa6-solid:file-lines",     "itemIds": ["…"] },
    { "id": "sec_prj", "kind": "project",     "title": "项目经历", "icon": "fa6-solid:flask",          "itemIds": ["…"] },
    { "id": "sec_exp", "kind": "experience",  "title": "实习经历", "icon": "fa6-solid:building-user",  "itemIds": ["…"] },
    { "id": "sec_award", "kind": "award",   "title": "获奖情况", "icon": "fa6-solid:trophy", "itemIds": ["…"] }
  ],
  "items": { /* 扁平 map，见 3.4 */ }
}
```

`items` 用扁平 map（而非嵌在 section 内）：稳定 id 是覆盖层、跨 section 复用、差异视图的前提；section 只持有 `itemIds` 顺序。

### 3.4 条目类型（必填 `*`）

| kind | shared 必填 `*` / 选填 | position-local |
|---|---|---|
| `education` | school\*, degree\*, start\*, end\* / major, gpa | visible, order |
| `publication` | title\*, venue\* / venueShort, authors[], links[]（URL 数组）, bullets | visible, order, render, **pitch**, **extraBullets** |
| `project` | name\* / role, start, end, summary, bullets | visible, order, detail, bulletInclude, overrides |
| `experience` | company\*, start\*, end\* / department, team, role, summary, bullets | visible, order, detail, bulletInclude, overrides |
| `award` | name\* / date, level, issuer | visible, order |
| `custom` | title\* / subtitle, dateRight, summary, bullets | visible, order, detail, bulletInclude, overrides |

> **v5 字段审计**：删掉了一批"定义了但不进 PDF"的字段。原则是**编辑器里能填的，就必须能在预览里看到效果** —— 否则用户填了半天没反应，比没有这个字段更糟。
> - 真死字段（无渲染、无 UI、无计划）：`basics.nameEn`、`basics.headline`、`ParagraphBlock.muted`（所有调用点都传 false 且无人读）、`template.builtin`、`breaking.atomicBullets`（分页器里 bullet 本就原子）
> - 能填但不渲染：`education.location/courses/thesis`、`experience.location`、`publication.year`（会议名已含年份）、`publication.links`/`project.links`（连同 `Link` 类型）、`project.tech`
> - `award` 是单行内容，不给 `bullets`：要点入口反而误导。`skill`（category/items 的单行技能行）后来整体移除，不再存在
> - v5.1 追加删除：`education.rank`、`education.bullets`（教育条目不需要子要点）、`publication.status`（三档里只有 `underReview` 会渲染出「(在投)」，而会议名本身已说明状态 —— `arXiv preprint, 2026` 就是预印本）
> - v5.1 追加实现：`publication.links`（纯 URL 数组）渲染成**会议名后的链接图标**。位置与形式的理由见下方说明
> - 保留：`photo` + `layout.showPhoto`、`layout.pageNumber`、`templateOverrides` —— 都是有明确计划的 TODO（§12）；`aliases` 在用（作者名标记），只是暂无编辑器入口

**论文渲染模式（作者列表始终完整展示）**

原始需求第 2 点否掉了"缩成一作简述"的方案，所以三档都保留完整作者，自己的名字加粗 + 下划线（`aliases` 匹配）：

| `render` | 输出 | 行数 |
|---|---|---|
| `tight` | 第 1 行 `**标题**` …右对齐… `会议简称`；第 2 行 完整作者列表 | 2 |
| `standard` | 标题 / 会议全称（斜体）/ 完整作者列表 —— 即 `参考 LaTeX 工程` 的版式 | 3 |
| `expanded` | `standard` + **pitch**（一句话展开）+ `extraBullets` | 3+n |

**论文链接的位置**（v5.1）：**紧跟会议名**，两档一致 —— `standard` 档跟在会议全称后，`tight` 档跟在标题行右端的会议简称后。链接属于"出处信息"，理应与会议名同组，不该漂到作者行。

渲染成**链接图标**而非文字标签：图标自带"这是链接"的语义，也省掉维护标签的负担（会议名往往已经写了 arXiv，再标一个 `[arXiv]` 是冗余）。数据结构相应地是纯 URL 数组，不是 `{label, url}`。

实现上，`blocks.ts` 用占位字符 `\u29c9` 生成行内 link 节点，渲染层识别后换成 SVG —— 保持 Block 是纯数据，不在里面塞 DOM。会议名的斜体标记只包住会议名，图标不被斜体化。

实测 Chromium 会生成 PDF 链接注解（可点区域约 9×9pt）。注意：**链接注解不进文本提取层**，ATS 拿不到 URL，也看不到图标。所以这是纯粹给人看的电子版功能，不是 ATS 优化手段。空字符串链接会被跳过。

`tight` 是把会议名挪到标题行右端（复用 `datedsubsection` 的两端对齐布局），比 `standard` 省一行而不丢任何信息——这是单页压缩里唯一"不删内容"的论文瘦身手段。
`status`: `accepted` / `underReview` / `preprint` → 渲染成 `(在投)` / `(Preprint)` 标注。
**同一份工作不要写两遍**：某篇论文同时有同名项目时，在项目摘要里手写一句「成果发表于某某会议 2026」，把论文区那条设为 `visible:false`。这是单页压缩的一大来源（§11）。

> **v4 撤回**：这里原本设计了 `relatedProjectId` / `relatedPubIds` 双向关联字段，由渲染层自动拼接会议名。实现后发现收益不抵成本 —— 反方向（论文→项目）根本没有展示需求，属于对称性带来的冗余，只写不读；正方向自动省下的只是一句话，却要求用户在编辑器里手打内部 id（违背「不看源码」的前提），做成勾选控件又要为一句话新增一套 UI。改为手写在摘要里，顺带还能自己控制措辞。

### 3.5 行内标记（最小语法，不是让你写源码）

| 写法 | 渲染 | 对应 LaTeX |
|---|---|---|
| `**文本**` | 加粗 | `\textbf` |
| `==文本==` | 主色加粗 | `\texthl` |
| `` `文本` `` | 等宽 | `\texttt` |
| `_文本_` | 下划线 | `\underline` |
| `*文本*` | 斜体 | `\textit` |
| `[文本](url)` | 链接（PDF 可点） | `\href` |
| `\` 前缀 | 转义 | — |

每个文本框上方一排按钮（选中文字点按钮插标记）+ `?` 帮助浮层。刻意不做富文本 contenteditable：纯文本字段 git diff 干净、复制粘贴无隐藏样式。解析器自己写（~80 行），不引 Markdown 库——能精确控制输出 DOM，对像素级排版很重要。

### 3.6 `positions/mllm/position.json`

```jsonc
{
  "schemaVersion": 1,
  "meta": {
    "name": "示例岗位",
    "order": 2,
    "targetPosition": "示例岗位全称",
    "note": "投递用；强调某篇论文与某个项目",
    "public": false,                                   // 是否为可公开版
    "filenameTemplate": "{name}-{positionName}-{phone}",   // positionName = 岗位简称
    "updatedAt": "2026-07-28T12:00:00+08:00"
  },
  "template": "academic-serif",
  "density": "standard",                               // loose | standard | compact | extreme
  "templateOverrides": {},                             // 优先级低，见 §12 TODO
  "layout": { "showPhoto": false, "pageNumber": false, "targetPages": 1 },
  "contacts": { "include": ["c_phone", "c_mail", "c_gh"] },
  "sections": [
    {
      "ref": "sec_pub", "visible": true, "titleOverride": null,
      "items": [
        // 论文：pitch 与 extraBullets 是 position-local，池里没有这两个字段
        { "ref": "itm_pub_a", "visible": true, "render": "expanded",
          "pitch": "面向 AI 生成图像检测，提出人类对齐的可解释推理框架，在 4 个 benchmark 上超越 SOTA。",
          "extraBullets": [
            { "id": "pb1", "text": "负责 ==grounded reasoning== 数据构造与评测协议设计" }
          ] },
        { "ref": "itm_pub_b", "visible": false, "note": "已在项目经历中体现" },
        { "ref": "itm_pub_c", "visible": true, "render": "tight" }
      ]
    },
    {
      "ref": "sec_prj", "visible": true,
      "items": [
        // 项目：bullets 是 shared，岗位层只勾选 + 必要时 overrides
        { "ref": "itm_safety", "visible": true, "detail": "full",
          "bullets": { "include": ["b1", "b2"] },
          "overrides": { "summary": "…（该岗位口径改写）" },
          "spacingAfter": -3 }
      ]
    }
  ],
  "pendingItems": ["itm_new_paper"]                    // 池里新增、本岗位尚未表态的条目
}
```

**语义**
- `sections` / `items` 数组顺序即渲染顺序 → 每个岗位独立排序（"某类内容相关置前"天然满足）。
- `visible: false` → 保留但不渲染（不是删除，随时切回）。
- `detail`：`titleOnly` / `summary` / `full` / `expanded`，对论文映射到 §3.4 的 4 档。预设是快捷方式，勾选框（`bullets.include`）是真相。
- `overrides`：字段级覆盖，未覆盖字段实时继承池。编辑器显示「已覆盖」徽标 + hover 看原值 + `↺` 恢复继承。
- `spacingAfter`：pt，可负，对应你 `\vspace{-3pt}` 的手动微调习惯。
- `pendingItems`：新条目在创建它的那个岗位默认可见；其他岗位进待处理队列，sidebar 打角标逼你表态。**既不静默泄漏也不静默遗漏。**

### 3.7 Schema 版本与迁移
zod 定义 schema + `schemaVersion` + `src/schema/migrations/00x.ts` 顺序迁移。启动校验；需迁移时**先备份到 `.trash/`**。数据要活好几年，这个不能省。

---

## 4. UI

### 4.1 布局

```
┌────────────┬──────────────────────────────────────────────────────────────┐
│ 岗位       │ ┌ toolbar ─────────────────────────────────────────────────┐ │
│ ─────────  │ │ [双栏][仅编辑][仅预览] │ 1 页 · 填充 92% │ 密度[紧凑▾]   │ │
│ ● 通用     │ │ 模板[academic-serif▾]  │ 缩放[—100%+] │ □PDF精校       │ │
│ ○ 示例岗 3 │ │ [校验 2] [压到 1 页] [导出 ⤓]                            │ │
│ ○ 另一岗   │ └──────────────────────────────────────────────────────────┘ │
│            │ ┌──────────────────────────┬─────────────────────────────┐   │
│ [+ 新建 ▾] │ │ 编辑器                    │ 预览                        │   │
│            │ │ ▸ 基本信息  是否公开:○是●否│  ┌───────────────────────┐  │   │
│ ─────────  │ │ ▾ 论文成果  5/8 可见      │  │ 示例人   ☎ · ✉ · gh     │  │   │
│ 模板库     │ │  ┌ ⣿ 示例论文 ─────────┐ │  │ ▍论文成果             │  │   │
│ 岗位对比   │ │  │ 标题* [……]           │ │  │ 示例论文: … 会议'26 │  │   │
│ 校验       │ │  │ 会议* [会议 2026]    │ │  │ …                     │  │   │
│            │ │  │ 密度 (单行|两行|完整|展开)│  │                     │  │   │
│            │ │  │ ▸ 更多选填字段 (5)   │ │  └───────────────────────┘  │   │
│            │ │  └───────── 👁 ⧉ ⋮ ────┘ │                             │   │
└────────────┴──────────────────────────────────────────────────────────────┘
```

### 4.2 岗位 sidebar
- 列表项：名称、色标、页数、`N 待处理`角标、未保存圆点。拖拽排序（写回 `meta.order`）。
- `[+ 新建 ▾]`：`空白新建` / `基于「通用」fork` / `基于「示例岗」fork`。fork 只复制覆盖层，**不复制内容**。
- 重命名：双击行内编辑显示名；`⋮ → 重命名 id` 才动目录。
- **删除（三重保护）**：
  1. 一级对话框：列出该岗位独有的东西会丢什么（`3 处字段覆盖`、`1 个本地条目`、`上次导出 2026-07-20`），按钮 `取消` / `继续删除`。
  2. 二级对话框：**手工输入岗位名称**才解锁删除按钮（GitHub 删库式）。
  3. 执行 = 整目录移到 `data/.trash/<ts>-<id>/`，底部出 `已删除「示例岗」 [撤销]` 10s toast。
- 右键：复制、导出、在文件管理器中显示、与其他岗位对比、固化。

### 4.3 编辑器（问卷式）
- 按 section 折叠；标题右侧显示 `5/8 可见`。
- 条目卡片：拖拽手柄（本岗位内排序）、👁 可见性、⧉ 复制、⋮（移到其他 section / 从池删除 / 看哪些岗位引用了它）。
- `detail` segmented control（论文是 4 档，其他 3 档）。
- 必填字段直接展开 + 红 `*`；选填折叠在 `▸ 更多选填字段 (5)`，已填的自动展开。
- bullets 子列表：自适应高度 textarea + 拖拽 + 👁（**per-position** 开关，这是"展开程度"的真实载体）。
- override 的字段：左侧橙色竖条 + hover 显示继承值 + `↺` 恢复继承。
- 日期：`YYYY` / `YYYY.MM` / `至今` 宽松输入 + 校验提示，不用 date picker（粒度粗，picker 更慢）。
- **是否公开**：基本信息区顶部单选。选「是」后校验器对任何 `sensitive: true` 的联系方式、身份证/生日等字段主动告警（对应你第 13 点）。
- 自动保存：防抖 400ms → `PUT /api/…`（原子写：临时文件 + rename）。`Ctrl+S` 立即保存。
- 撤销/重做：`Ctrl+Z` / `Ctrl+Shift+Z`，store 快照环形缓冲 100 步（数据量小，直接存 JSON 快照）。

### 4.4 预览联动
- 编辑字段 → 预览对应区块淡黄高亮 1.2s，必要时滚动到可视区。
- 点预览区块 → 编辑器展开并聚焦对应条目（`data-block-id` → item id）。
- 状态栏 `1 页 · 填充 92%` —— 决定"还能不能塞一条"的关键指标。
- 溢出到第 2 页时页边画警示线 + 提示"隐藏 2 条 bullet 即可回到 1 页"。

### 4.5 视图模式
`双栏`（P0，默认，分隔条可拖、比例记忆）/ `仅编辑器` / `仅预览`（P1）/ `纯文本`（v5.2）。`Ctrl+1/2/3/4`。

**纯文本视图**（v5.2）：投递表单（公司自建 ATS）大多不收 PDF，要手敲或粘贴。这个视图把简历转成可复制的纯文本或 Markdown。

三个关键决定：
- **建在 `Block[]` 之上，不另起一套遍历**。岗位层的取舍（可见性、顺序、展开档、pitch、要点勾选）自动生效。若直接读 `profile`，迟早出现「预览里有、复制出来没有」的分叉 —— 这与 §2.5 渲染契约是同一个理由。附带好处：**脱敏也自动生效**（`public` 岗位过滤掉 `sensitive` 联系方式），复制路径不会绕过它。已加测试锁住。
- **复制粒度对齐表单字段的粒度**，切成 `小节 → 条目 → 字段` 三层：
  - 字段：手机 / 邮箱 / 主页各一栏；论文的标题 / 会议 / 链接 / 作者各一栏；经历的标题 / 时间 / 内容各一栏。
  - 条目：每段经历、每篇论文可「复制整条」。
  - 小节：「复制本段」；顶部「复制全文」。

  只做到小节级是没有意义的 —— 表单里手机、邮箱、主页是三个输入框，整段复制过去还得手工再切一次。**摘要与要点合并成一个「内容」**，因为表单里它们本来就填在同一个多行框。
  链接要从会议名里**拆出来**：`*会议 2026* [⧉](url)` 是给 PDF 排版拼的，表单里链接是独立一栏。
  条目切分按 `Block.itemId` 分组（同一条目的块必然连续），不另立规则。
- **中英加空格是可选的**。PDF 里靠 `.as` 的 `margin-inline` 实现（§2.6：刻意不用空格字符，免得污染复制文本），纯文本没有这个手段，只能插真空格。默认开（「负责 PyTorch」比「负责PyTorch」易读），但保留关掉的开关，以防目标表单会二次处理空白。

字段的行数跟着模板走，不自己另立规则：`academic-serif` 的教育条目是两行式（专业与 GPA 独立成行，切出「内容」栏）。切分跟随渲染，才不会出现第三套语义。

悬停某个复制按钮时，它对应的范围会轻微高亮。三级按钮挨得近，光看位置说不清「复制标题 / 复制整条 / 复制本段」各自覆盖到哪，点下去才知道就晚了。用 CSS `:has()` 反向选中祖先，不进 Vue 响应式 —— 纯悬停反馈，不必让每次鼠标移动都触发组件更新；不支持 `:has()` 的浏览器只是没有高亮，不影响功能。

踩过的坑：论文链接在 `Block` 里是 `[⧉](url)`，`⧉`（U+29C9）只是给预览层换成 SVG 图标用的**内部占位符**。它漏进复制内容就是个乱码方块。已加测试锁住（`plaintext.test.ts`）。

剪贴板另有一处兜底：`navigator.clipboard` 只在安全上下文可用，通过端口转发用 `http://<内网 IP>` 访问时它是 `undefined`（只有 localhost 被当作安全来源），所以保留 `execCommand('copy')` 兜底，并在失败时提示手动选中。

---

## 5. 导出

### 5.1 主路径：服务端 Playwright
```
POST /api/positions/:id/export
  → 复用常驻 Chromium（首次冷启 ~800ms，之后 ~200ms）
  → goto http://127.0.0.1:<vitePort>/print?position=:id     // 服务端本机回环，与端口转发无关
  → waitForFunction(() => window.__RESUME_READY__)          // 字体 ready + 分页完成后置位
  → page.pdf({ preferCSSPageSize: true, printBackground: true, margin: 0, tagged: true })
  → pdf-lib 补写元数据（Title/Author/Subject/Keywords）
  → 原子写入 data/positions/:id/<渲染后的文件名>.pdf
  → 返回 { ok, filename, pages, bytes, ms }

前端拿到响应后立刻触发
GET /api/positions/:id/pdf?download=1   →  Content-Disposition: attachment
```

浏览器优先复用**本机已装 Chrome**（`channel:'chrome'` / `executablePath` 探测），失败再回落 Playwright 自带 Chromium（避免 ~300MB 下载）。

批量：`npm run export -- --all`。

### 5.2 端口转发场景（原始需求第 9 点）
你的架构是：这台机器起服务 → 端口转发 → 另一台机器浏览器访问。**服务端导出在这个场景下严格优于浏览器打印**：

| | 服务端导出 | 浏览器 `window.print()` |
|---|---|---|
| 字体/渲染环境 | 服务端，可控、固定 | 取决于远端那台机器装了什么字体 ← **致命** |
| PDF 落盘归档到 `data/` | 自动 | 做不到（落在远端下载目录） |
| 拿到文件 | 响应流式下载，一次点击 | 需手动关"页眉页脚"、选纸张 |
| 端口转发是否有影响 | 无（Playwright 走服务端回环） | 无 |

所以「导出 ⤓」一个按钮同时完成**归档到 `data/`** 和**下载到你手上**。`window.print()` 仅作为服务端 Chromium 不可用时的降级提示（并明确警告字体可能不一致）。

### 5.3 文件名模板
默认 `{name}-{positionName}-{phone}` → `示例人-示例岗-0000000000.pdf`。用**岗位简称**（`meta.name`）而非岗位全称（原始需求第 4 点）。
占位符：`{name} {positionName} {targetPosition} {phone} {email} {date} {pages}`。
- `{phone}` 渲染时**去掉连字符与空格**（`000-0000-0000` → `0000000000`），HR 系统更好处理。
- 占位符取不到值（例如公开版没勾选手机号）→ **静默省略该段并清理多余连字符**，不产出 `示例人-通用-.pdf`。
- 文件名清洗：去掉 `/ \ : * ? " < > |` 与首尾空白；默认覆盖同名旧文件（git 已存历史）。

---

## 6. 岗位差异视图（人类可读，非 git diff）

按 section 聚合的**语义摘要**，不做行级 diff：

```
通用  ⇄  示例岗                                             1 页 ⇄ 1 页

论文成果      5 条可见 ⇄ 8 条可见
              岗位 B 增加：某篇论文、某篇论文、某技术报告
              该论文密度：单行 ⇄ 展开（+2 条要点）

项目经历      顺序不同：示例岗版把「某项目」提到第 1 位
              某项目要点：2 条 ⇄ 3 条
              「某项目」摘要被改写（示例岗版）                    [并排查看]

联系方式      仅 GitHub ⇄ 手机 / 邮箱 / GitHub
是否公开      是 ⇄ 否
模板/密度     academic-serif·标准 ⇄ academic-serif·紧凑
```

规则：只报**影响 PDF 观感的差异**；`overrides` 的文本差异折叠成一行 + `[并排查看]` 才展开该字段的两个版本对照（这时才用轻量高亮，且是并排而非 `+/-`）。支持任选两个岗位对比，也支持"某岗位 vs 内容池原始值"。

---

## 7. 模板与密度档

模板 = **表现层**参数包，不含内容。应用模板只改观感，不动数据。

**只保留 1 套模板**：`academic-serif`（对齐 resume.cls，§8）。模板机制（`data/templates/*.json` + `存为模板`）保留 —— 加第二套模板的成本是写一个 JSON，不是改代码。原先的 `industry-compact`（互联网·紧凑）已移除：它的排版建议保留在 §8 作为「想更紧凑时怎么调」的参考。

```jsonc
{
  "id": "academic-serif", "name": "学术·复刻 resume.cls",
  "page": { "size": "A4", "margin": { "top": 21.59, "right": 20.32, "bottom": 13.97, "left": 20.32, "unit": "mm" } },
  "font": { "body": ["Resume Serif"], "mono": ["Resume Serif"], "baseSize": 10.95, "baseLineHeight": 13.6 },
  "scale": { "name": 24.88, "contact": 12, "sectionTitle": 14.4, "entryTitle": 12, "body": 10.95 },
  "color": { "accent": "#01408f", "fg": "#000000", "rule": "#01408f" },
  "sectionTitleStyle": "rule",
  "entry": { "educationLayout": "twoLine", "accentSchool": true, "selfAuthorBold": false },
  "spacing": { "sectionAbove": 12.0, "sectionBelow": 9.05, "entryAbove": 9.1, "entryBelow": 0 },
  "publicationRender": "standard",
  "text": { "align": "justify", "autoSpaceCJKLatin": true, "punctuationTrim": true },
  "breaking": { "keepSectionTitleWithNext": true, "keepEntryHeaderWithNext": true }
}```

**密度档**（`loose` / `standard` / `compact` / `extreme`）是叠在模板上的一个乘子包，同时缩放字号与所有间距（等比，不破坏垂直节奏）。**这是替代一堆滑杆的关键设计**——你选一个词，而不是纠结 0.05pt（对应你第 11、14 点：避免强迫症内耗）。`extreme` 会明确标注"可读性已接近下限"。

---

## 8. 排版建议：为互联网企业改什么（原始需求第 8 点）

`resume.cls`（[luooofan/resume](https://github.com/luooofan/resume)，MIT）是学术风格，几处对互联网投递不划算：

| 现状 | 问题 | 建议 |
|---|---|---|
| 正文 Times + Noto Serif CJK | 衬线在 10pt 屏幕/低分打印下发虚；国内互联网简历几乎全是无衬线 | 改**无衬线**（Noto Sans CJK SC + 拉丁无衬线） |
| 边距 0.80in 侧 / 0.85in 上 | 每行少约 6% 字符，纵向白吃 8mm | 15mm 侧 / 14mm 上 / 12mm 下（仍在所有打印机安全区内） |
| 小节标题 14.4pt + 横线 + 上下各 1.8× | 每个小节约吃 42pt≈3 行，5 个小节 = 15 行 | 12.5pt bold + **左侧 3pt 色条**（省掉横线的垂直占用）+ 上 9 / 下 4pt |
| 论文 3 行式（标题 / 会议全称 / 作者） | 每篇吃掉 4~5 行 | 默认 `tight`：**会议简称挪到标题行右端**，作者独占第 2 行 → 2 行。**作者列表完整保留**（原始需求第 2 点） |
| 论文与项目重复描述同一份工作 | 同一份工作在论文区和项目区各写一遍 | 项目摘要里手写「成果发表于某某会议 2026」，论文区那条隐藏 |
| 姓名 24.88pt（`\Huge`）居中 + 联系方式独占一行 | 页首约吃 60pt | 姓名 20pt，**姓名与联系方式同一行**（左名右联系）或两行紧排；省 ~20pt |
| 教育每条 2 行（标题行 + 专业/GPA 行） | 4 行 | 专业与 GPA 并入标题行左段：`示例大学 / 硕士 · 示例专业 · GPA 3.9/4.0 ······ 2021–2025`，2 条 = 2 行 |
| 行距 13.6pt（1.242） | 偏松 | 12.7pt（1.245 on 10.2pt）视觉相当但绝对值省 |
| 无「技能」小节 | 互联网 HR / ATS 关键词匹配靠这块 | 加一条紧凑的技能行（2–3 行，两栏），关键词密度高 |

另外两条与排版无关但影响命中率的建议：
- 项目要点尽量**一条一行**。要点写到第 2 行通常是废话（"针对…问题，探索…"这类铺垫可以并进 summary 或删）。量化结果前置（"显存下降 40%"比"显存占用明显下降"强）。
- PDF 用 `tagged: true` + 逻辑 DOM 顺序，文本能被 ATS 正确提取；不要把关键信息放进图片。

---

## 9. 工程结构

```
├── package.json / vite.config.ts / tsconfig.json / index.html
├── AGENTS.md                     # 给后续 AI / 人类维护者
├── docs/DESIGN.md                # 本文档
├── src/
│   ├── main.ts  App.vue
│   ├── schema/            zod schema、类型、migrations/
│   ├── stores/            pinia: profile / positions / template / ui / history
│   ├── render/
│   │   ├── resolve.ts     池 + local-items + 覆盖层 → ResolvedResume
│   │   ├── blocks.ts      ResolvedResume → Block[]
│   │   ├── inline.ts      行内标记 → AST
│   │   ├── autospace.ts   CJK/Latin 间距 pass
│   │   ├── paginate.ts    测量 + 装箱 + 断页规则
│   │   ├── plaintext.ts   Block[] → 可复制的纯文本 / Markdown
│   │   └── autofit.ts     密度二分，压到目标页数
│   ├── components/
│   │   ├── sidebar/       PositionList, DeleteDialog, ForkMenu
│   │   ├── editor/        SectionAccordion, ItemCard, fields/*, MarkupToolbar
│   │   ├── preview/       PreviewPane, PageBox, TextView, blocks/*
│   │   └── compare/       DiffSummary
│   ├── styles/            tokens.css resume.css page.css print.css
│   └── pages/             AppView.vue, PrintView.vue
├── server/
│   ├── vite-plugin-data.ts   REST + fs.watch → SSE（外部改动提醒）
│   └── export.ts             常驻 Chromium + pdf-lib
├── scripts/
│   ├── prepare-fonts.sh      下载开源字体（TeX Gyre + Noto SC）到 fonts/
│   ├── build-fonts.py        otf → unicode-range 分片 woff2（+ CFF→glyf + 变量字体实例化）
│   ├── font-profiles/*.json  字体档案（要哪些字重 / 取自哪个字体文件）
│   ├── check-fidelity.ts     §2.5 保真校验
│   └── export-all.ts
├── public/fonts/             自托管字体（源文件与分片产物都不入库）
├── data.sample/              示例简历（虚构人物，仓库里唯一的数据）
├── assets/                   README 用的图片
├── docs/DESIGN.md            本文档
└── data/ …                   使用者自己的数据（git 忽略）
```

依赖（刻意精简）：运行时 `vue` `pinia` `@vueuse/core` `zod`；开发期 `vite` `@vitejs/plugin-vue` `vue-tsc` `typescript` `vitest` `playwright-core` `pdf-lib` `tsx` `@iconify-json/*`。
不引 Markdown 库 / 富文本编辑器 / CSS 框架 / UI 组件库 —— 对话框与下拉都是手写的，
避免第三方样式污染像素级预览。

一条命令启动：`pnpm run dev`（Vite 插件内置 data API 与导出端点；`data/` 不存在时自动用 `data.sample/` 初始化）。

**测例**：`data.sample/` 是合成的**虚构人物**简历（覆盖所有 kind、中英混排、长短条目、多页/单页两组数据），既是仓库示例也是测试固件 —— 只有一份假数据。理由：真实简历含手机号邮箱，不该进测试固件；虚构数据还能刻意造边界（无作者的论文、只有公司名的实习、被覆盖的字段、隐藏的小节、只留 GitHub 的公开版）。真实内容由使用者在 UI 里录入。

三个岗位各担一件事：`general` 完整版、`research` 演示取舍（隐藏、展开档、要点勾选、字段覆盖、间距）、`public` 可公开版（只留 GitHub）。

测试：`vitest` 覆盖 `resolve()` 语义、`inline.ts` 解析、`paginate()` 在 mock 高度下的断页规则；`check:fidelity` 防排版无声退化；P2 视觉回归（fixture → PDF → PNG → 与基线比对）。

---

## 10. 非目标
- 不做多用户 / 云同步 / 账号（本地单人工具，git 就是同步与历史）。
- 不做投递进度追踪 / JD 匹配打分 / AI 改写。
- 不做移动端适配。
- **不做像素级自由拖拽**。当时的顾虑（放不准很难看 / 想放准就强迫症浪费时间）正是自由拖拽的必然结果。代偿：结构化字段 + **密度档**（一次选一个词）+ **模板库**（换一整套观感）+ 条目级 `spacingAfter`（真需要微调时的唯一逃生口）。
- 不做 LaTeX 输出（如需归档退路，见 §14）。

---

## 11. 怎么压到 1 页（原始需求第 10 点）

按示例数据的内容量（2 教育 / 7 论文 / 3 项目 / 2 实习）估算，`academic-serif` 下约 **990pt ≈ 1.34 页**（单页容量 741pt）。需要砍约 250pt。

| 手段 | 省下 | 代价 |
|---|---|---|
| 论文改 `tight`（会议简称移到标题行右端，作者独占 1 行；每篇从 59pt → 32pt） | **~135pt** | 无（作者列表完整保留） |
| 边距收窄（侧 20.3→15mm，上 21.6→14mm，下 14→12mm） | ~55pt（含行宽增加带来的换行减少） | 无 |
| 小节标题紧凑化（4–5 个 × ~12pt） | ~48pt | 视觉留白减少 |
| 论文/项目去重（同一份工作合并） | ~32pt | 无（本来就是重复） |
| 行距 13.6 → 12.7pt | ~27pt | 无（相对行距不变） |
| 页首紧排（姓名 20pt + 联系方式同行） | ~20pt | 姓名不那么醒目 |
| 教育两行并一行 | ~27pt | 无 |
| 要点一条一行封顶 | ~40pt（视内容） | 需要删废话 |
| **合计** | **~384pt** | |

结论：**目标 250pt，可省 384pt——1 页可达，且既不缩小正文字号，也不删减论文作者列表。** 前三项（论文 `tight` + 边距 + 标题紧凑）合计 238pt，几乎单独就够。

`[压到 1 页]` 按钮对密度做二分兜底（`--scale` ∈ [0.90, 1.00]，步长 0.005，每次重跑分页；低于 0.94 时警告可读性，并优先建议"隐藏 N 条要点"而不是继续缩）。

---

## 12. TODO / 降级项
- 模板字段级微调 UI（`templateOverrides`）——数据结构留好，UI 后做（原始需求第 7 点）。
- 字号 / 间距滑杆粒度（拟：字号 0.05pt、间距 0.5pt）——先用密度档顶（原始需求第 14 点）。
- 行级切分分页（P1）。
- PDF 精校模式（P1）。
- 视觉回归基线（P2）。
- 页面缩略图导航（P2）。
- 导出归档（`exports/archive/<ts>-*.pdf`，默认关闭）。
- 自动 `git commit`（默认不做，可做成显式按钮）。

---

## 13. 里程碑

| M | 内容 | 验收 |
|---|---|---|
| **M0** | 骨架、zod schema、`data/` 读写 API、合成 fixture | fixture 能被解析与校验 |
| **M1** | 渲染 + 分页 + `academic-serif` 模板 + 服务端导出 + 下载 | 拿 fixture 导出 PDF **给你验收排版**；`check:fidelity` 通过 |
| **M2** | 表单编辑器 + 双栏实时预览 + 自动保存 + 撤销 | 你能录入真实内容并脱离 LaTeX |
| **M3** | 岗位 sidebar（fork / 重命名 / 三重确认删除）+ 覆盖层 UI + `pendingItems` + 是否公开校验 | 多岗位维护成立 |
| **M4** | 视图模式、压到 1 页、模板库、差异视图、校验面板 | 好用 |

**M1 是唯一的真风险点**（排版精度），建议先做 M0+M1 让你验收 PDF，再投入编辑器 UI。

---

## 14. 备选方案记录

### 14.1 Typst(WASM) — plan B
优点：真排版引擎（更好的两端对齐/避头尾）、原生 PDF、`typst.ts` 增量编译 30–200ms、预览即 PDF（零一致性风险）。
缺点：预览是 SVG/canvas → 失去"点预览跳字段"和 DOM 高亮；需维护一层 Typst 源码生成模板；WASM + 字体 ~30MB 冷启动；断页定制（标题不孤悬）要靠 `block(breakable:false)` 拼，可控性反而不如自研分页器。
结论：不选。若 M1 验收时 CSS 在中英混排精度上过不了关，切换成本可控（数据层不变，只换渲染层）。

### 14.2 其他
- `paged.js`：断页规则表达力不足、性能一般 → 自研分页器。
- `pdfmake` / `react-pdf` / `pdf-lib` 手工排版：预览与 PDF 两套实现必然发散 → 否。
- LaTeX 反向输出：把 `ResolvedResume` 生成 `sections.tex`，保留用 `参考 LaTeX 工程` 编译的归档能力。工作量约 1 天，但要维护第二套模板 → 放 TODO，你需要再说。
- Electron/Tauri 打包：现阶段没必要，`npm run dev` + 浏览器足够，且你的端口转发场景下浏览器访问才是对的形态。

---

## 15. 已定案 / 待观察

**已定案**（第二轮讨论）：字段归属分级（论文 pitch 归岗位层）；论文作者完整展示；先做 1 套模板；文件名用岗位简称；共享池 + 三个逃生口。

**等实现出来看效果再定**（原始表述：先做，看到效果才好判断）：
1. `academic-serif` 的具体观感——姓名与联系方式分两行是否太占竖向空间、论文是否默认 tight 档。
2. `tight` 论文式（会议简称在标题行右端）看起来舒服吗。
3. ~~要不要加「技能」小节~~（已定案：不加。技能整体移除，改为「获奖情况」小节，条目类型用已有的 `award`）。
4. `data/` 里的 PDF 入不入 git（开源版：不入 —— `data/` 整体忽略；私有版曾按入 git 处理，单份约 100KB）。
