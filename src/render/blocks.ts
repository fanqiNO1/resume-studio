/**
 * blocks：ResolvedResume → 扁平的 Block 序列。
 *
 * Block 是分页器的原子单元。把树状结构拍平成线性序列，是因为分页本质上是
 * 一维装箱问题；保留树结构只会让断页规则难写。
 *
 * `keepWithNext` 表达「这一块不能是页内最后一块」——小节标题、条目标题行
 * 都需要它。CSS 表达不了这个，所以由分页器执行。
 */

import type { Item } from '@/schema'
import type { ResolvedItem, ResolvedResume } from './resolve'

export type BlockKind =
  | 'header'
  | 'sectionTitle'
  | 'entryHeader'
  | 'paragraph'
  | 'bullet'
  | 'pubTight'
  | 'pubTitle'

export interface BlockBase {
  /** 稳定 id：预览↔编辑器互相定位、check:fidelity 比对都靠它 */
  id: string
  kind: BlockKind
  /** 归属的条目 id（header/sectionTitle 为空），用于点预览跳字段 */
  itemId: string
  sectionId: string
  /** 不得成为页内最后一块 */
  keepWithNext: boolean
  /** 块上方额外间距，pt */
  spaceAbove: number
  /** 块下方额外间距，pt */
  spaceBelow: number
}

export interface HeaderBlock extends BlockBase {
  kind: 'header'
  name: string
  contacts: { type: string; value: string; url: string }[]
}

export interface SectionTitleBlock extends BlockBase {
  kind: 'sectionTitle'
  title: string
  icon: string
}

/** 「标题 …右对齐… 日期」两端对齐布局 */
export interface EntryHeaderBlock extends BlockBase {
  kind: 'entryHeader'
  /** 左侧主文本，含行内标记 */
  left: string
  /** 右侧文本（日期等），含行内标记 */
  right: string
}

export interface ParagraphBlock extends BlockBase {
  kind: 'paragraph'
  text: string
  /**
   * 段落变体，决定字号与字形：
   *   body    正文
   *   venue   会议名（斜体）
   *   authors 作者列表
   * 论文的会议名与作者列表刻意做成独立的 paragraph block，而不是塞在
   * pubTitle 内部 —— 内部 margin 与块间 margin 的折叠行为不同，会差 0.75pt，
   * 让同一个 paragraphGap 参数对两处产生不同效果。
   */
  variant: 'body' | 'venue' | 'authors'
}

export interface BulletBlock extends BlockBase {
  kind: 'bullet'
  text: string
}

/** tight 档：标题在左、会议简称右对齐同一行，作者独占第二行 */
export interface PubTightBlock extends BlockBase {
  kind: 'pubTight'
  title: string
  /**
   * 已是完整的行内标记（含斜体与链接图标）。
   * 由 blocks 拼好而不是渲染层补 `*`：链接图标不该被斜体化。
   */
  venueShort: string
}

/** standard/expanded 档的标题行（会议名与作者是独立的 paragraph block） */
export interface PubTitleBlock extends BlockBase {
  kind: 'pubTitle'
  title: string
}

export type Block =
  | HeaderBlock
  | SectionTitleBlock
  | EntryHeaderBlock
  | ParagraphBlock
  | BulletBlock
  | PubTightBlock
  | PubTitleBlock

/**
 * 把作者列表拼成一行，自己的名字加下划线。
 *
 * resume.cls 用的是 `\underline{作者名}` —— 只有下划线，**不加粗**。
 * 模板可通过 entry.selfAuthorBold 改成下划线 + 加粗。
 *
 * 用行内标记而不是预先生成 DOM：保持 Block 是纯数据，便于序列化与测试。
 *
 * 匹配用「归一化后相等」而不是原样比较：作者列表里写的是 "Qi Fan"，
 * 而用户填的可能是 "Qi  Fan"、"Q.Fan" 或大小写不同 —— 这些都该认成同一个人。
 * 但只比归一化后的**整体**，不做子串匹配：作者 "Qi Fanqi" 不该被 "Qi Fan" 命中。
 */
function formatAuthors(authors: string[], selfNames: string[], bold: boolean): string {
  if (authors.length === 0) return ''
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\s.·\-_'’]/g, '')
  const selfSet = new Set(selfNames.filter(Boolean).map(norm))
  const mark = (a: string) => (bold ? `**_${a}_**` : `_${a}_`)
  return authors.map((a) => (selfSet.has(norm(a)) ? mark(a) : a)).join(', ')
}

/**
 * 把论文链接拼成行内标记，紧跟在**会议名**之后。
 *
 * 用链接图标而不是 [arXiv] 之类的文字标签：图标自带"这是链接"的语义，
 * 也省掉维护标签的负担（会议名往往已经写了 arXiv，标签是冗余的）。
 * 用 ⧉ 这个占位字符触发行内 link 节点，渲染层会把它换成 SVG 图标 ——
 * 保持 Block 是纯数据，不在这里塞 DOM。
 */
export const LINK_ICON_MARK = '\u29c9'

function formatLinks(links: string[]): string {
  const usable = links.map((u) => u.trim()).filter(Boolean)
  if (usable.length === 0) return ''
  return usable.map((url) => ` [${LINK_ICON_MARK}](${url})`).join('')
}

/** 日期区间：起止相同或缺一则退化为单值 */
function formatRange(start: string, end: string): string {
  if (start && end) return start === end ? start : `${start} – ${end}`
  return start || end || ''
}

export interface BuildBlocksInput {
  resume: ResolvedResume
  /**
   * 「自己」的名字候选集合：中文名、英文名、别名。
   * 作者列表里命中任何一个就加下划线。
   */
  selfNames: string[]
}

export function buildBlocks({ resume, selfNames }: BuildBlocksInput): Block[] {
  const blocks: Block[] = []
  const { spacing } = resume.metrics

  blocks.push({
    id: 'header',
    kind: 'header',
    itemId: '',
    sectionId: '',
    keepWithNext: true,
    spaceAbove: 0,
    spaceBelow: spacing.headerBelow,
    name: resume.name,
    contacts: resume.contacts.map((c) => ({ type: c.type, value: c.value, url: c.url ?? '' })),
  })

  for (const section of resume.sections) {
    blocks.push({
      id: `sec:${section.id}`,
      kind: 'sectionTitle',
      itemId: '',
      sectionId: section.id,
      keepWithNext: resume.template.breaking.keepSectionTitleWithNext,
      spaceAbove: spacing.sectionAbove,
      spaceBelow: spacing.sectionBelow,
      title: section.title,
      icon: section.icon,
    })

    section.items.forEach((ri, idx) => {
      const produced = buildItemBlocks(ri, section.id, resume, selfNames, idx === 0)
      blocks.push(...produced)
    })
  }

  return blocks
}

function buildItemBlocks(
  ri: ResolvedItem,
  sectionId: string,
  resume: ResolvedResume,
  selfNames: string[],
  isFirstInSection: boolean,
): Block[] {
  const { spacing } = resume.metrics
  const { breaking } = resume.template
  const out: Block[] = []
  const item = ri.item
  const base = {
    itemId: item.id,
    sectionId,
    keepWithNext: false,
    spaceAbove: 0,
    spaceBelow: 0,
  }
  // 小节内第一个条目不再叠加 entryAbove：sectionBelow 已经提供了间距
  const entryAbove = isFirstInSection ? 0 : spacing.entryAbove

  const pushBullets = (bullets: { id: string; text: string }[], keyPrefix: string) => {
    bullets.forEach((b, i) => {
      out.push({
        ...base,
        id: `${item.id}:${keyPrefix}:${b.id}`,
        kind: 'bullet',
        keepWithNext: false,
        spaceAbove: i === 0 ? spacing.listTop : spacing.listItemGap,
        spaceBelow: 0,
        text: b.text,
      })
    })
  }

  switch (item.kind) {
    case 'education': {
      const { educationLayout, accentSchool } = resume.template.entry
      // ==...== 渲染成主色加粗，对应 resume.cls 的 \texthl
      const school = accentSchool ? `==${item.school}==` : `**${item.school}**`
      const detailParts = [item.major, item.gpa ? `GPA: ${item.gpa}` : ''].filter(Boolean)

      if (educationLayout === 'merged') {
        // 专业与 GPA 并入标题行，省一整行（单页向）
        const detail = detailParts.join(' · ')
        out.push({
          ...base,
          id: `${item.id}:head`,
          kind: 'entryHeader',
          keepWithNext: breaking.keepEntryHeaderWithNext && ri.bullets.length > 0,
          spaceAbove: entryAbove,
          spaceBelow: 0,
          left: `${school} / *${item.degree}*${detail ? ` · ${detail}` : ''}`,
          right: formatRange(item.start, item.end),
        })
      } else {
        // resume.cls 的做法：标题行 + 专业/GPA 独立一行
        out.push({
          ...base,
          id: `${item.id}:head`,
          kind: 'entryHeader',
          keepWithNext: breaking.keepEntryHeaderWithNext && detailParts.length > 0,
          spaceAbove: entryAbove,
          spaceBelow: 0,
          left: `${school} / *${item.degree}*`,
          right: formatRange(item.start, item.end),
        })
        if (detailParts.length > 0) {
          out.push({
            ...base,
            id: `${item.id}:detail`,
            kind: 'paragraph',
            variant: 'body',
            spaceAbove: spacing.paragraphGap,
            spaceBelow: 0,
            // 中文用顿号式逗号连接，与参考一致：「示例专业，GPA: 3.9/4.0」
            text: detailParts.join('，'),
          })
        }
      }
      break
    }

    case 'experience': {
      const right = formatRange(item.start, item.end)
      /*
       * 分隔符有两套，对应两种不同的语义关系：
       *   ` · `  组织包含链：公司 ⊃ 部门 ⊃ 团队
       *   ` / `  并列维度：组织 vs 角色
       *
       * `/` 的用法与 resume.cls 的「某大学 / 硕士」一致 —— 那里分隔的是
       * "哪个学校"和"什么学位"两个正交维度，不是层级。若层级也用 `/`，
       * 「某公司 / 某部门 / 某团队 / 某职位」会拉平成四个并列项，
       * 读不出包含关系。
       *
       * `·` 两侧留空格是必要的：团队名本身可能含紧排的间隔号（如「某某·某项目」），
       * 带空格的分隔符才能与词内的点区分开。
       */
      const org = [item.company ? `**${item.company}**` : '', item.department, item.team]
        .filter(Boolean)
        .join(' · ')
      const left = [org, item.role ? `*${item.role}*` : ''].filter(Boolean).join(' / ')
      out.push({
        ...base,
        id: `${item.id}:head`,
        kind: 'entryHeader',
        keepWithNext: breaking.keepEntryHeaderWithNext,
        spaceAbove: entryAbove,
        spaceBelow: 0,
        left,
        right,
      })
      if (ri.detail !== 'titleOnly' && item.summary) {
        out.push({
          ...base,
          id: `${item.id}:summary`,
          kind: 'paragraph',
            variant: 'body',
          spaceAbove: spacing.paragraphGap,
          spaceBelow: 0,
          text: item.summary,
        })
      }
      if (ri.detail === 'full') pushBullets(ri.bullets, 'b')
      break
    }

    case 'project': {
      out.push({
        ...base,
        id: `${item.id}:head`,
        kind: 'entryHeader',
        keepWithNext: breaking.keepEntryHeaderWithNext,
        spaceAbove: entryAbove,
        spaceBelow: 0,
        left: `**${item.name}**${item.role ? ` / *${item.role}*` : ''}`,
        right: formatRange(item.start, item.end),
      })
      if (ri.detail !== 'titleOnly' && item.summary) {
        out.push({
          ...base,
          id: `${item.id}:summary`,
          kind: 'paragraph',
          variant: 'body',
          spaceAbove: spacing.paragraphGap,
          spaceBelow: 0,
          text: item.summary,
        })
      }
      if (ri.detail === 'full') pushBullets(ri.bullets, 'b')
      break
    }

    case 'publication': {
      const authors = formatAuthors(item.authors, selfNames, resume.template.entry.selfAuthorBold)
      const linkText = formatLinks(item.links)

      if (ri.render === 'tight') {
        // 链接紧跟会议简称，两者同在标题行右端
        out.push({
          ...base,
          id: `${item.id}:pub`,
          kind: 'pubTight',
          keepWithNext: breaking.keepEntryHeaderWithNext && Boolean(authors),
          spaceAbove: entryAbove,
          spaceBelow: 0,
          title: item.title,
          venueShort: `*${item.venueShort || item.venue}*${linkText}`,
        })
        if (authors) {
          out.push({
            ...base,
            id: `${item.id}:authors`,
            kind: 'paragraph',
            variant: 'authors',
            spaceAbove: spacing.paragraphGap,
            spaceBelow: 0,
            text: authors,
          })
        }
      } else {
        // resume.cls 的三行式：标题 / 会议全称（斜体）/ 完整作者列表
        out.push({
          ...base,
          id: `${item.id}:pub`,
          kind: 'pubTitle',
          keepWithNext: breaking.keepEntryHeaderWithNext,
          spaceAbove: entryAbove,
          spaceBelow: 0,
          title: item.title,
        })
        out.push({
          ...base,
          id: `${item.id}:venue`,
          kind: 'paragraph',
          variant: 'venue',
          keepWithNext: breaking.keepEntryHeaderWithNext && Boolean(authors),
          spaceAbove: spacing.paragraphGap,
          spaceBelow: 0,
          text: `*${item.venue}*${linkText}`,
        })
        if (authors) {
          out.push({
            ...base,
            id: `${item.id}:authors`,
            kind: 'paragraph',
            variant: 'authors',
            spaceAbove: 0,
            spaceBelow: 0,
            text: authors,
          })
        }
      }

      if (ri.render === 'expanded') {
        if (ri.pitch) {
          out.push({
            ...base,
            id: `${item.id}:pitch`,
            kind: 'paragraph',
            variant: 'body',
            spaceAbove: spacing.paragraphGap,
            spaceBelow: 0,
            text: ri.pitch,
          })
        }
        pushBullets([...ri.bullets, ...ri.extraBullets], 'b')
      }
      break
    }

    case 'award': {
      out.push({
        ...base,
        id: `${item.id}:head`,
        kind: 'entryHeader',
        spaceAbove: entryAbove,
        spaceBelow: 0,
        left: [`**${item.name}**`, item.level, item.issuer].filter(Boolean).join(' · '),
        right: item.date,
      })
      break
    }

    case 'custom': {
      out.push({
        ...base,
        id: `${item.id}:head`,
        kind: 'entryHeader',
        keepWithNext: breaking.keepEntryHeaderWithNext,
        spaceAbove: entryAbove,
        spaceBelow: 0,
        left: `**${item.title}**${item.subtitle ? ` / ${item.subtitle}` : ''}`,
        right: item.dateRight,
      })
      if (ri.detail !== 'titleOnly' && item.summary) {
        out.push({
          ...base,
          id: `${item.id}:summary`,
          kind: 'paragraph',
            variant: 'body',
          spaceAbove: spacing.paragraphGap,
          spaceBelow: 0,
          text: item.summary,
        })
      }
      if (ri.detail === 'full') pushBullets(ri.bullets, 'b')
      break
    }
  }

  // 条目级手动微调，落在最后一块的下方
  if (out.length > 0) {
    const last = out[out.length - 1]
    last.spaceBelow += spacing.entryBelow + ri.spacingAfter
    // 最后一块不能要求 keep-with-next，否则会把下一个条目粘过来
    last.keepWithNext = false
  }

  return out
}

/** 供 check:fidelity 与测试比对用的稳定摘要 */
export function blockSignature(blocks: Block[]): string {
  return blocks.map((b) => `${b.kind}#${b.id}`).join('\n')
}

export type { Item }
