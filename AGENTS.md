# AGENTS.md

给后续维护此仓库的 AI 或人类的说明。**动手前请完整读一遍本文件，以及 `docs/DESIGN.md`。**

---

## 1. 这是什么

一个**开源**仓库（MIT），是一个本地运行的 Vue 3 + TS + Vite Web 应用：
表单化编辑简历 → 实时 A4 预览 → 服务端导出投递用 PDF。

包含三部分：
- `data/` — **使用者自己的**简历内容（JSON）与导出产物。已被 `.gitignore` 忽略，
  不随仓库分发，也不该被提交。
- `data.sample/` — 仓库里唯一的示例数据（虚构人物「示例人」）。首次启动时若
  `data/` 不存在，应用会自动复制一份过去。
- 其余 — 工具本体：渲染管线、分页器、服务端 PDF 导出、岗位 sidebar、表单编辑器。

**当前状态：M0–M3 已实现并跑通**（渲染管线、分页器、服务端 PDF 导出、岗位 sidebar、
表单编辑器、压到 N 页）。运行方式见 `README.md`。尚未做的见 `docs/DESIGN.md` §12 TODO。

---

## 2. 最高优先约束

按重要性排序。冲突时上位覆盖下位。

1. **不得损坏 `data/`。** 任何对 `data/` 的写操作必须：先备份到 `data/.trash/<timestamp>-*/`，
   再原子写入（写临时文件 + `rename`）。不要用 `>` 重定向、不要就地截断、不要批量 `sed -i`。
   删除一律是"移到 `.trash/`"。这是**使用者不可再生的数据**。
2. **PDF 排版精度是产品的全部意义。** 用户最终交付物是 PDF，不是网页。任何让预览与 PDF
   产生偏差的改动都是 P0 bug，即使 UI 看起来更好。
3. **预览与导出必须共用同一套布局逻辑。** 见 §4「渲染契约」。
4. **不要引入新依赖**，除非在 issue/对话里明确讨论过。依赖清单是刻意精简的，理由见
   `docs/DESIGN.md` §9。特别地：不要引入 Markdown 库、富文本编辑器、CSS 框架、
   UI 组件库（`reka-ui` 是无样式原语，不算）。
5. **不要把真实简历内容写进仓库。** `data/` 里是使用者的手机号、邮箱、论文与经历。
   它们不进 `data.sample/`、不进测试、不进示例、不进 commit message、不进 PR 描述。
   测试固件一律用 `data.sample/`（虚构人物）。
6. **不要分发字体文件 —— 任何字体都不分发。** 仓库里只有「字体档案」
   （`scripts/font-profiles/*.json`），源字体与子集产物都在使用者本机
   （`fonts/`、`public/fonts/generated/`，均已 gitignore）。
   默认档案 `adobe`（与参考排版一致）用的是商业字体，必须使用者自备；
   `oss` 档案的 OFL 字体由 `scripts/prepare-fonts.sh` 拉到本地，同样不入库。

---

## 3. 目录导航

```
docs/DESIGN.md          设计文档（先读这个）
AGENTS.md               本文件
CONTRIBUTING.md         贡献流程
assets/                 README 用的图片
data.sample/            示例简历（虚构人物，唯一入库的数据）
src/schema/             zod schema + 类型 + migrations/
src/render/             resolve → blocks → inline/autospace → paginate → autofit
src/components/         sidebar/ editor/ preview/ compare/
src/styles/             tokens.css(主题变量) resume.css page.css print.css
src/pages/PrintView.vue 导出用的无装饰路由（/print?position=<id>）
server/                 Vite 插件：data REST API + 服务端 PDF 导出
scripts/                字体分片（+ 字体档案 + 开源字体下载脚本）、保真校验、批量导出
public/fonts/           自托管字体（源文件不入库，分片产物不入库）
```

---

## 4. 渲染契约（改动 render/ 或 styles/ 前必读）

预览和 PDF 导出**必须**共享：`resolve()` → `blocks()` → `inline()` → `autospace()`、
同一套 CSS 与主题变量、同一批字体文件、同一个 `paginate()` 与同一份 `breaking` 参数。

允许不同的只有质量档：触发时机（防抖 vs 等 `fonts.ready`）、字体加载方式（分片 woff2 vs 完整字体）、
抗锯齿参数、屏幕装饰（阴影/缩放/高亮，导出侧无）。

**分页是 JS 预计算的**，产出显式 `.page` 盒子；打印时 Chromium 不做自主断页。不要试图用
`break-inside: avoid` 之类的 CSS 替代分页器——那会重新引入预览与 PDF 的偏差。

改完 `render/` 或 `styles/` 后**必须**跑：
```bash
pnpm run dev &              # check:fidelity 需要 server 在跑
pnpm run check:fidelity     # 比对 preview/export 两个环境的分页结果与 y 偏移
pnpm test
```
`check:fidelity` 失败意味着预览与 PDF 已经不一致，**不要跳过、不要调容差绕过**。

**已知陷阱（别再踩）**：

1. 不要给导出用的 Chromium 加 `--disable-font-subpixel-positioning`。它会改变行盒高度
   （实测 32 个块里改掉 8 个，页底累计漂移 1.31pt），导出结果就不再等于用户浏览器里的
   预览。`--font-render-hinting=none` 与 `--disable-lcd-text` 是安全的（漂移为 0）。
2. **字体必须是 glyf（TrueType）轮廓**。Chromium/Skia 无法把 CFF / CID-keyed 字体嵌进
   PDF，会退化成 Type3：没有字体名、无法 hinting、体积翻倍。`scripts/build-fonts.py`
   已用 cu2qu 做 CFF→glyf 转换，**不要为了省时间跳过这一步**。改字体后用
   `python3 -c "import fitz;print({f[2] for f in fitz.open('xx.pdf')[0].get_fonts()})"`
   确认结果是 `{'Type0'}`。
3. 不要给字体子集加 `--no-hinting` / `--desubroutinize`：那会去掉 hint 信息。
4. **CJK 标点（U+3000-303F、U+FF00-FFEF 等）必须归到中文字体那一档**。若声明在拉丁档，
   浏览器不会继续往下找中文字体，而是落到系统字体，全角逗号括号会变形。

---

## 5. 数据协议要点

完整定义见 `docs/DESIGN.md` §3。这里只列容易踩的：

- **共享内容池 + 按岗位目录覆盖**。`data/profile.json` 是唯一内容源；
  `data/positions/<id>/position.json` 只存"选哪些 / 什么顺序 / 展开到什么程度 / 覆盖哪些字段"。
- **没有索引文件**。岗位列表靠扫 `data/positions/*/position.json` 得到，排序按
  `meta.order ?? 目录名`。这样用户 `cp -r` 一个目录就是一次 fork——**不要为了方便而引入
  `positions.json` 索引**，那会破坏这个性质。
- 目录名 = 岗位 `id`；`meta.name` = 显示名。改显示名不动目录。
- `items` 是扁平 map，`id` 稳定。**永远不要重排或重新生成 item id**，覆盖层、`pendingItems`、
  差异视图全靠它。
- 所有 JSON：UTF-8、2 空格缩进、**key 顺序稳定**、数组顺序即语义顺序、末尾换行。
  目的是 `git diff` 可读。写入前请用统一的序列化函数，不要各处 `JSON.stringify` 各写一套。
- `schemaVersion` + `src/schema/migrations/`。改 schema 必须配迁移函数，迁移前备份。
- `pendingItems` 的语义：池里新增的条目，在**创建它的那个岗位**默认可见，其他岗位进待处理
  队列等用户表态。不要为了"省事"改成默认可见（通用版会泄漏细节）或默认隐藏（用户会忘记投）。

### 5.0 字段纪律

**编辑器里能填的字段，必须在预览里看得到效果。** 加字段时三处要同时改：
`src/schema/profile.ts`（定义 + `FIELD_ORDER` + `createEmptyItem`）、
`src/render/blocks.ts`（渲染）、必要时 `ItemCard.vue` 的 `LABELS`。
只做前两步会得到一个"填了没反应"的字段 —— 比没有这个字段更糟，用户会以为坏了。

不要为了"对称"或"将来可能有用"添加字段。已经因此删过两批：
双向关联字段（`relatedPubIds`/`relatedProjectId`，v4）和一批只写不读的字段（v5，
详见 `docs/DESIGN.md` §3.4 的审计记录）。

### 5.1 测试纪律

**行为断言必须基于 `data.sample/`，不能基于 `data/` 里的真实简历。** 两条都是踩过的坑：

1. 真实简历是用户随时会改的。断言"通用版小节顺序是 edu/exp/prj/pub"这类具体值，
   用户在 UI 里挪一下小节，测试就红 —— 那不是回归，是正常使用。
2. 岗位会被删除。硬编码 `data/positions/mllm/position.json` 在用户删掉该岗位后
   会直接崩掉整个测试文件。

`data.sample/` 是自足的固件，刻意造了边界条件（无作者的论文、只有公司名的实习、
被覆盖的字段、隐藏的小节、只留 GitHub 的公开版）。三个岗位分别是：
`general`（完整版）、`research`（演示取舍）、`public`（可公开版）。
真实数据只在 `describe('data/ 结构体检')` 里做"能解析、引用不悬空、block id 唯一"的检查。

> 为什么只有一份假数据：曾经 `fixtures/`（测试夹具）与 `data.sample/`（仓库示例）
> 是两套独立的假简历，改一处文案要同步改两个目录 + 两套断言。现在合并成一份。

---

## 6. 常见任务怎么做

| 任务 | 入口 |
|---|---|
| 改排版观感 | 优先改 `data/templates/*.json` 或新增模板，**不要**直接改 `resume.css` 里的硬编码值 |
| 加一种条目类型 | `src/schema/` 定义 → `src/render/blocks.ts` 产出 block → `src/components/preview/blocks/` 渲染 → `src/components/editor/` 表单 → 更新 fixture 与测试 |
| 加一个行内标记 | `src/render/inline.ts`（解析器是手写的，~80 行）+ `MarkupToolbar` 按钮 + 测试 + `docs/DESIGN.md` §3.5 的表格 |
| 调断页规则 | `src/render/paginate.ts` + 模板的 `breaking` 字段；必须补 `paginate` 的单测（用 mock 高度，不依赖真实字体） |
| 换字体 | `scripts/font-profiles/*.json`（字体档案）+ `scripts/build-fonts.py`；源字体用 `RESUME_FONT_SRC=<目录>` 或 `--src` 指给脚本；**不要**把任何字体文件提交进仓库 |
| 改导出 | `server/export.ts`。注意 Playwright 访问的是**服务端回环** `127.0.0.1:<vitePort>`，与用户的端口转发无关，不要改成外部可见地址 |
| 排查"PDF 和预览不一样" | 先跑 `check:fidelity`；再确认两侧字体文件是否同一字形来源；再看是否有人在 print.css 里加了只对打印生效的规则 |
| 排查 `npm run dev` 起不来 | 若报 `ENOSPC: System limit for number of file watchers reached`，那是系统的 inotify **instance** 配额（`/proc/sys/fs/inotify/max_user_instances`，常见默认 128）被机器上所有常驻进程分光了，不是本仓库出了问题。`vite.config.ts` 已把 `data/.trash/**` 排除出监听（那里每次保存都会新增一个备份文件，几天就是几百个）；仍然不够就关掉别的 watch 型进程，或 `sudo sysctl fs.inotify.max_user_instances=512` |
| 加一种"复制出去"的格式 | `src/render/plaintext.ts`。**必须建在 `Block[]` 上**，不要直接遍历 `profile` —— 否则岗位层的取舍与 `sensitive` 脱敏都会被绕过（见 `docs/DESIGN.md` §4.5） |

---

## 7. 使用场景约束（会影响设计决策）

- 用户可能**在这台机器起服务，端口转发到另一台机器的浏览器**访问。因此：
  - PDF **必须服务端生成**（远端机器的字体环境不可控），然后既落盘 `data/` 又流式下载给浏览器。
  - 不要把 `window.print()` 当主路径，它只是服务端 Chromium 不可用时的降级。
  - 不要假设浏览器和文件系统在同一台机器上（比如"在文件管理器中显示"这类功能要优雅降级）。
- 桌面双栏使用，不需要移动端适配。
- 单人单机，不需要账号 / 并发 / 云同步。git 就是同步与历史。

---

## 8. 明确的非目标

不要"顺手"加这些：

- 像素级自由拖拽排版。用户明确否决过（放不准难看 / 想放准就内耗）。替代手段是密度档 +
  模板库 + 条目级 `spacingAfter`。
- 投递进度追踪、JD 匹配打分、AI 自动改写简历。
- 多用户 / 云同步 / 账号体系。
- 英文内容双字段（`{zh, en}`）。英文需求由模板库里的英文模板（英文小节标题 + 拉丁排版）解决。
- LaTeX 输出。除非用户明确要归档退路。

---

## 9. 提交约定

- 中文 commit message，一句话说清做了什么。
- **`data/` 永远不提交**（`.gitignore` 已忽略，且 §2 第 5 条禁止把真实简历写进仓库）。
- 不自动 `git commit`（尤其不要在导出 PDF 后自动提交）。用户没要求就不要动 git 状态。
- 不要 `git push` / 建 PR，除非用户明确要求。

---

## 10. 遇到分歧时

`docs/DESIGN.md` 的 §15「还需要你确认的」记录了尚未定案的问题。如果你的任务撞上其中之一，
**先问用户，不要自己替他定**。已定案的决策记在 §0，不要重新推翻（除非用户主动提出）。

如果你发现设计文档与实际代码不一致，说明有人漏了同步——修正文档，并在回复里指出来。
