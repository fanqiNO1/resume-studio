/**
 * 中英混排自动间距。
 *
 * LaTeX 的 xeCJK 会在 CJK 与拉丁/数字之间自动插入约 1/4 em 的间距，
 * 少了它中英混排会显得挤（「使用CUDA算子」vs「使用 CUDA 算子」）。
 * CSS 的 text-autospace 尚未稳定可用，所以在渲染期自己插。
 *
 * 用带 margin 的 span 而不是真实空格字符：
 *   - 真实空格会进入 PDF 文本层，复制出来多出空格
 *   - margin 方案视觉正确、复制干净，代价是 PDF 文本提取时中英之间无分隔
 *     （对 ATS 无实质影响：中文分词本来不依赖空格）
 *
 * 用户已经手打了空格的地方不再插入，避免双倍间距。
 */

import type { InlineNode } from './inline'

const CJK = /[⺀-⿿぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/
/** 拉丁字母、数字，以及会紧贴单词的符号 */
const LATIN = /[A-Za-z0-9@#$%&]/
/** CJK 标点：这些符号自带足够的视觉留白，两侧不应再插间距 */
const CJK_PUNCT = /[　-〿！-＠［-｀｛-･]/

export interface SpacedSegment {
  text: string
  /** 该段之前是否需要插入一个间距 span */
  gapBefore: boolean
}

/** 判断两个相邻字符之间是否需要间距 */
function needsGap(left: string, right: string): boolean {
  if (!left || !right) return false
  if (left === ' ' || right === ' ') return false
  if (CJK_PUNCT.test(left) || CJK_PUNCT.test(right)) return false
  return (CJK.test(left) && LATIN.test(right)) || (LATIN.test(left) && CJK.test(right))
}

/**
 * 把一段文本切成若干片段，标出哪些片段前面要插间距。
 * 返回的片段拼起来等于原文，不增删任何字符。
 */
export function splitForAutoSpace(text: string): SpacedSegment[] {
  const cuts: number[] = []
  for (let i = 1; i < text.length; i++) {
    if (needsGap(text[i - 1], text[i])) cuts.push(i)
  }
  if (cuts.length === 0) return [{ text, gapBefore: false }]

  const segments: SpacedSegment[] = []
  let start = 0
  for (const cut of cuts) {
    segments.push({ text: text.slice(start, cut), gapBefore: segments.length > 0 })
    start = cut
  }
  segments.push({ text: text.slice(start), gapBefore: true })
  return segments
}

/**
 * 跨节点边界的间距处理。
 *
 * 「使用 **CUDA** 算子」里 `使用` 与 `CUDA` 分属不同节点，
 * 逐节点独立处理会漏掉边界上的间距。所以需要知道前一个节点的末字符
 * 和后一个节点的首字符。
 */
export function lastChar(nodes: InlineNode[]): string {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    const s = n.type === 'text' || n.type === 'code' ? n.value : lastChar(n.children)
    if (s) return s.slice(-1)
  }
  return ''
}

export function firstChar(nodes: InlineNode[]): string {
  for (const n of nodes) {
    const s = n.type === 'text' || n.type === 'code' ? n.value : firstChar(n.children)
    if (s) return s.slice(0, 1)
  }
  return ''
}

export function gapBetween(left: string, right: string): boolean {
  return needsGap(left, right)
}
