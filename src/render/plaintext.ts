/**
 * 纯文本 / Markdown 视图。
 *
 * 建在 Block[] 之上而不是直接读 profile —— 与 PDF 渲染共用同一个中间表示，
 * 岗位层的取舍（可见性、顺序、展开档、pitch、要点勾选）自动生效。
 * 若另起一套遍历逻辑，迟早会出现「预览里有、复制出来没有」的分叉。
 *
 * 用途：投递表单（BOSS、智联、公司自建 ATS）大多不收 PDF，要手敲或粘贴。
 */

import { parseInline, type InlineNode } from './inline'
import { splitForAutoSpace } from './autospace'
import { LINK_ICON_MARK, type Block } from './blocks'

export type TextFormat = 'plain' | 'markdown'

export interface PlainTextOptions {
  format: TextFormat
  /**
   * 在中英之间补真实空格。
   *
   * PDF 里靠 CSS margin 实现（不污染复制文本），纯文本没有这个手段，
   * 只能插真空格 —— 「负责PyTorch」读起来比「负责 PyTorch」差。
   * 关掉则严格保留你输入的原文。
   */
  autoSpace: boolean
  /** 要点符号。表单里 • 通用性最好，- 更像 markdown 源码 */
  bulletMark: string
  /** 条目标题与右侧日期之间的分隔 */
  dateSeparator: string
}

export const DEFAULT_TEXT_OPTIONS: PlainTextOptions = {
  format: 'plain',
  autoSpace: true,
  bulletMark: '•',
  dateSeparator: '  ',
}

/** 把行内标记 AST 转成目标格式的文本 */
function renderInline(nodes: InlineNode[], opts: PlainTextOptions): string {
  const md = opts.format === 'markdown'
  return nodes
    .map((node): string => {
      switch (node.type) {
        case 'text':
          return opts.autoSpace ? addRealSpaces(node.value) : node.value
        case 'code':
          return md ? `\`${node.value}\`` : node.value
        case 'strong':
          return md
            ? `**${renderInline(node.children, opts)}**`
            : renderInline(node.children, opts)
        case 'highlight':
          // == 不是标准 markdown，降级成加粗；纯文本直接去掉标记
          return md
            ? `**${renderInline(node.children, opts)}**`
            : renderInline(node.children, opts)
        case 'underline':
          // markdown 没有下划线，且这里主要用于标记自己的名字 —— 加粗更通用
          return md
            ? `**${renderInline(node.children, opts)}**`
            : renderInline(node.children, opts)
        case 'em':
          return md ? `*${renderInline(node.children, opts)}*` : renderInline(node.children, opts)
        case 'link': {
          const raw = renderInline(node.children, opts)
          // 链接图标是渲染层的内部占位符（U+29C9），绝不能漏进复制内容
          const label = raw.split(LINK_ICON_MARK).join('').trim()
          if (md) return label ? `[${label}](${node.href})` : node.href
          return label ? `${label} (${node.href})` : node.href
        }
      }
    })
    .join('')
}

/** 在 CJK 与拉丁/数字边界插入真实空格 */
function addRealSpaces(text: string): string {
  return splitForAutoSpace(text)
    .map((seg, i) => (i > 0 && seg.gapBefore ? ' ' + seg.text : seg.text))
    .join('')
}

function text(src: string, opts: PlainTextOptions): string {
  return renderInline(parseInline(src), opts)
}

/**
 * Block[] → 可复制的文本。
 *
 * 段落之间的空行规则：小节之间空一行，条目之间空一行，条目内部不空 ——
 * 粘进表单后这个层次仍然读得出来，又不会因为空行太多而显得松散。
 */
export function blocksToText(blocks: Block[], options?: Partial<PlainTextOptions>): string {
  const opts = { ...DEFAULT_TEXT_OPTIONS, ...options }
  const md = opts.format === 'markdown'
  const lines: string[] = []

  /** 上一个块的种类，用来决定要不要空行 */
  let prevKind: Block['kind'] | null = null

  for (const block of blocks) {
    const needsBlankBefore =
      prevKind !== null &&
      (block.kind === 'sectionTitle' ||
        // 条目起始块之前空一行，但小节标题刚过去时不空
        ((block.kind === 'entryHeader' ||
          block.kind === 'pubTight' ||
          block.kind === 'pubTitle') &&
          prevKind !== 'sectionTitle'))

    if (needsBlankBefore) lines.push('')

    switch (block.kind) {
      case 'header': {
        lines.push(md ? `# ${block.name}` : block.name)
        const contacts = block.contacts
          .map((c) => (c.url && c.url !== c.value ? `${c.value} (${c.url})` : c.value))
          .filter(Boolean)
        if (contacts.length) lines.push(contacts.join(md ? ' · ' : ' · '))
        break
      }

      case 'sectionTitle':
        lines.push(md ? `## ${block.title}` : block.title)
        break

      case 'entryHeader': {
        const left = text(block.left, opts)
        const right = text(block.right, opts)
        lines.push(right ? `${left}${opts.dateSeparator}${right}` : left)
        break
      }

      case 'pubTight': {
        // 标题与会议简称在 PDF 里同一行两端对齐，文本里保持同一行
        const title = text(block.title, opts)
        const venue = text(block.venueShort, opts)
        lines.push(venue ? `${title}${opts.dateSeparator}${venue}` : title)
        break
      }

      case 'pubTitle':
        lines.push(text(block.title, opts))
        break

      case 'paragraph':
        lines.push(text(block.text, opts))
        break

      case 'bullet':
        lines.push(`${md ? '-' : opts.bulletMark} ${text(block.text, opts)}`)
        break

    }

    prevKind = block.kind
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * 切成「小节 → 条目 → 字段」三层，供逐级复制。
 *
 * 复制的粒度必须对齐**表单字段的粒度**，否则复制按钮没有意义 ——
 * 表单里手机、邮箱、主页是三个输入框，一次把整段基本信息复制过去，
 * 还得手工再切一次。论文同理：标题、会议、链接、作者各是一栏。
 */

/** 一个可独立复制的字段 */
export interface TextUnit {
  /** 字段名，如「手机」「会议」「内容」 */
  label: string
  content: string
}

/** 一个条目：一段经历、一篇论文、一条教育背景 */
export interface TextEntry {
  /** 条目抬头（公司名 / 论文标题），本身也可复制；页首没有抬头 */
  head: TextUnit | null
  units: TextUnit[]
  /** 整条的文本，供「复制整条」 */
  content: string
}

export interface TextSection {
  /** 小节标题；页首那段为空字符串 */
  title: string
  entries: TextEntry[]
  /** 整段文本，供「复制本段」 */
  content: string
}

const CONTACT_LABEL: Record<string, string> = {
  phone: '手机',
  email: '邮箱',
  github: 'GitHub',
  homepage: '主页',
  wechat: '微信',
  linkedin: 'LinkedIn',
  location: '所在地',
  other: '联系方式',
}

/** 这几类联系方式复制链接更有用；其余复制字面值（手机号不该带 tel:） */
const LINK_CONTACTS = new Set(['github', 'homepage', 'linkedin'])

/**
 * 把纯图标链接从文本里抽出来，单独成字段。
 *
 * 会议名在 Block 里是 `*AAAI 2026* [⧉](url)` —— 拼在一起是给 PDF 排版用的。
 * 表单里链接是独立一栏，所以这里拆开。带文字的链接不动（那是正文的一部分）。
 */
function splitLinks(src: string, opts: PlainTextOptions): { text: string; urls: string[] } {
  const urls: string[] = []
  const keep = parseInline(src).filter((node) => {
    if (node.type !== 'link') return true
    const label = renderInline(node.children, opts).split(LINK_ICON_MARK).join('').trim()
    if (label) return true
    urls.push(node.href)
    return false
  })
  return { text: renderInline(keep, opts).trim(), urls }
}

/** 同一条目的块是连续的，按 itemId 切分即可 */
function groupEntries(blocks: Block[]): Block[][] {
  const groups: Block[][] = []
  let key: string | null = null
  for (const block of blocks) {
    const id = block.kind === 'header' ? ' header' : block.itemId
    if (groups.length === 0 || id !== key) {
      groups.push([block])
      key = id
    } else {
      groups[groups.length - 1].push(block)
    }
  }
  return groups
}

function buildEntry(blocks: Block[], opts: PlainTextOptions): TextEntry {
  let head: TextUnit | null = null
  const units: TextUnit[] = []
  /** 摘要与要点合并成一个「内容」—— 表单里它们本来就填在同一个多行框 */
  const body: string[] = []

  const push = (label: string, content: string): void => {
    if (content) units.push({ label, content })
  }
  const pushLinks = (urls: string[]): void => {
    urls.forEach((url, i) => push(urls.length > 1 ? `链接 ${i + 1}` : '链接', url))
  }

  for (const block of blocks) {
    switch (block.kind) {
      case 'header':
        push('姓名', block.name)
        for (const c of block.contacts) {
          push(
            CONTACT_LABEL[c.type] ?? CONTACT_LABEL.other,
            LINK_CONTACTS.has(c.type) ? c.url || c.value : c.value,
          )
        }
        break

      case 'sectionTitle':
        break

      case 'entryHeader': {
        const left = text(block.left, opts)
        if (left) head = { label: '标题', content: left }
        push('时间', text(block.right, opts))
        break
      }

      case 'pubTitle':
        head = { label: '标题', content: text(block.title, opts) }
        break

      case 'pubTight': {
        head = { label: '标题', content: text(block.title, opts) }
        const venue = splitLinks(block.venueShort, opts)
        push('会议', venue.text)
        pushLinks(venue.urls)
        break
      }

      case 'paragraph':
        if (block.variant === 'venue') {
          const venue = splitLinks(block.text, opts)
          push('会议', venue.text)
          pushLinks(venue.urls)
        } else if (block.variant === 'authors') {
          push('作者', text(block.text, opts))
        } else {
          body.push(text(block.text, opts))
        }
        break

      case 'bullet':
        body.push(`${opts.format === 'markdown' ? '-' : opts.bulletMark} ${text(block.text, opts)}`)
        break

    }
  }

  if (body.length) units.push({ label: '内容', content: body.join('\n') })

  return { head, units, content: blocksToText(blocks, opts).trimEnd() }
}

export function blocksToSections(
  blocks: Block[],
  options?: Partial<PlainTextOptions>,
): TextSection[] {
  const opts = { ...DEFAULT_TEXT_OPTIONS, ...options }
  const out: TextSection[] = []
  let current: Block[] = []
  let title = ''

  const flush = () => {
    // 小节标题本身不重复进正文，标题已经在 TextSection.title 里
    const body = title ? current.slice(1) : current
    current = []
    if (body.length === 0) return
    out.push({
      title,
      entries: groupEntries(body).map((g) => buildEntry(g, opts)),
      content: blocksToText(body, opts).trimEnd(),
    })
  }

  for (const block of blocks) {
    if (block.kind === 'sectionTitle') {
      flush()
      title = block.title
    }
    current.push(block)
  }
  flush()
  return out
}
