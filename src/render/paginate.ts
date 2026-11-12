/**
 * 分页器。
 *
 * 为什么不用 CSS：`break-inside: avoid` / `orphans` / `widows` 在 Chromium 里
 * 对复杂结构支持不稳，更要紧的是**屏幕上看不到断页位置**。而这个工具的全部
 * 意义就是让用户在编辑时就知道 PDF 会断在哪。
 *
 * 所以：JS 实测每块高度 → 装箱 → 产出显式的 page 盒子。打印时 Chromium
 * 不再有自主断页空间，PDF 的断页位置结构性等于预览。见 docs/DESIGN.md §2.4。
 */

import type { Block } from './blocks'

/** 每块的实测尺寸，pt */
export interface BlockMetric {
  id: string
  /** 内容高度（不含 spaceAbove/spaceBelow） */
  height: number
}

export interface PaginateOptions {
  /** 页内容区高度，pt */
  contentHeight: number
  /** 单块超过整页高度时的告警回调 */
  onOverflow?: (block: Block, height: number) => void
}

export interface PaginatedPage {
  blocks: Block[]
  /** 本页已用高度，pt */
  used: number
  /** 填充率 0–1 */
  fill: number
}

export interface PaginateResult {
  pages: PaginatedPage[]
  /** 单块高度超过整页的块 id，UI 需要报警 */
  overflowing: string[]
}

/**
 * 一块在页内实际占用的高度 = 内容高度 + 上间距（页首时上间距归零）+ 下间距。
 *
 * 上间距在页首归零是有意的：LaTeX 的 \vspace 在页首会被吞掉，
 * 不这么做的话断页处会出现莫名的顶部空白。
 */
function occupied(metric: number, block: Block, atPageTop: boolean): number {
  return metric + (atPageTop ? 0 : block.spaceAbove) + block.spaceBelow
}

export function paginate(
  blocks: Block[],
  metrics: Map<string, number>,
  options: PaginateOptions,
): PaginateResult {
  const { contentHeight, onOverflow } = options
  const pages: PaginatedPage[] = []
  const overflowing: string[] = []

  /** 当前页的块，以及每块在当前布局下占用的高度 */
  let current: Block[] = []
  let used = 0

  const height = (b: Block) => metrics.get(b.id) ?? 0

  /** 重算一组块作为独立一页时的总高度 */
  const measurePage = (list: Block[]): number =>
    list.reduce((sum, b, idx) => sum + occupied(height(b), b, idx === 0), 0)

  const flush = () => {
    if (current.length === 0) return
    const total = measurePage(current)
    pages.push({ blocks: current, used: total, fill: total / contentHeight })
    current = []
    used = 0
  }

  for (const block of blocks) {
    const h = height(block)

    // 单块高于整页：换页也解决不了，强制独占一页并报警（不静默截断）
    if (h > contentHeight) {
      overflowing.push(block.id)
      onOverflow?.(block, h)
      flush()
      pages.push({ blocks: [block], used: h, fill: 1 })
      continue
    }

    const atTop = current.length === 0
    const need = occupied(h, block, atTop)

    if (atTop || used + need <= contentHeight) {
      current.push(block)
      used += need
      continue
    }

    // 需要断页。keep-with-next：若页尾若干块要求「不许当页尾」，把断点前移，
    // 让它们跟着 block 一起去下一页。连续块必须一起挪，否则
    // 「小节标题 + 条目标题行」这种双 keep 链只挪走一半，标题仍孤悬页尾。
    let keep = 0
    while (keep < current.length - 1 && current[current.length - 1 - keep].keepWithNext) {
      keep++
    }
    // current.length - 1 的上界保证至少留一块，不产出空页
    const carried = keep > 0 ? current.splice(current.length - keep, keep) : []

    flush()
    current = [...carried, block]
    used = measurePage(current)
  }

  flush()
  return { pages, overflowing }
}

/** mm → pt */
export function mmToPt(mm: number): number {
  return (mm / 25.4) * 72
}

/** pt → CSS px（96dpi） */
export function ptToPx(pt: number): number {
  return (pt / 72) * 96
}

export const A4 = { widthMm: 210, heightMm: 297 } as const

export interface PageGeometry {
  /** 内容区宽度，px（用于离屏测量容器） */
  contentWidthPx: number
  /** 内容区高度，pt（用于装箱） */
  contentHeightPt: number
}

export function pageGeometry(margin: {
  top: number
  right: number
  bottom: number
  left: number
}): PageGeometry {
  const widthMm = A4.widthMm - margin.left - margin.right
  const heightMm = A4.heightMm - margin.top - margin.bottom
  return {
    contentWidthPx: ptToPx(mmToPt(widthMm)),
    contentHeightPt: mmToPt(heightMm),
  }
}
