import { describe, expect, it } from 'vitest'
import { paginate, pageGeometry, mmToPt } from '@/render/paginate'
import type { Block } from '@/render/blocks'

/**
 * 分页器测试用 mock 高度，不依赖真实字体 —— 断页规则的正确性与字体无关，
 * 而依赖字体会让测试在不同机器上飘。
 */
function block(id: string, opts: Partial<Block> = {}): Block {
  return {
    id,
    kind: 'paragraph',
    itemId: '',
    sectionId: '',
    keepWithNext: false,
    spaceAbove: 0,
    spaceBelow: 0,
    text: '',
    variant: 'body',
    ...opts,
  } as Block
}

function run(blocks: Block[], heights: Record<string, number>, contentHeight: number) {
  return paginate(blocks, new Map(Object.entries(heights)), { contentHeight })
}

describe('paginate', () => {
  it('装不下时换页', () => {
    const blocks = [block('a'), block('b'), block('c')]
    const { pages } = run(blocks, { a: 40, b: 40, c: 40 }, 100)
    expect(pages.map((p) => p.blocks.map((b) => b.id))).toEqual([['a', 'b'], ['c']])
  })

  it('页首块的上间距归零（对齐 LaTeX 在页首吞掉 vspace 的行为）', () => {
    // b 高 40 + 上间距 30 = 70，与 a 的 40 相加超过 100 → b 换页
    // 换页后 b 只占 40，因此 c（40）也能进第二页
    const blocks = [block('a'), block('b', { spaceAbove: 30 }), block('c', { spaceAbove: 20 })]
    const { pages } = run(blocks, { a: 40, b: 40, c: 40 }, 100)
    expect(pages.map((p) => p.blocks.map((b) => b.id))).toEqual([['a'], ['b', 'c']])
    // 第二页用量 = 40 + (20 + 40) = 100，而不是 (30+40) + (20+40) = 130
    expect(pages[1].used).toBe(100)
  })

  it('keepWithNext 的块不会孤悬页尾', () => {
    // 小节标题（title）本来正好落在第一页末尾，必须被推到第二页
    const blocks = [
      block('body1'),
      block('title', { kind: 'sectionTitle', keepWithNext: true } as Partial<Block>),
      block('body2'),
    ]
    const { pages } = run(blocks, { body1: 60, title: 30, body2: 40 }, 100)
    expect(pages.map((p) => p.blocks.map((b) => b.id))).toEqual([['body1'], ['title', 'body2']])
  })

  it('连续的 keepWithNext 链整体挪走', () => {
    // 「小节标题 + 条目标题行」两个都 keepWithNext，只挪一个的话标题仍孤悬
    const blocks = [
      block('body1'),
      block('title', { keepWithNext: true }),
      block('entry', { keepWithNext: true }),
      block('body2'),
    ]
    const { pages } = run(blocks, { body1: 50, title: 20, entry: 20, body2: 40 }, 100)
    expect(pages.map((p) => p.blocks.map((b) => b.id))).toEqual([
      ['body1'],
      ['title', 'entry', 'body2'],
    ])
  })

  it('keepWithNext 链撑满整页时不产出空页', () => {
    // 所有块都要求 keepWithNext：必须至少留一块，否则会无限换页或产出空页
    const blocks = [
      block('a', { keepWithNext: true }),
      block('b', { keepWithNext: true }),
      block('c', { keepWithNext: true }),
    ]
    const { pages } = run(blocks, { a: 60, b: 60, c: 60 }, 100)
    expect(pages.every((p) => p.blocks.length > 0)).toBe(true)
    expect(pages.flatMap((p) => p.blocks.map((b) => b.id))).toEqual(['a', 'b', 'c'])
  })

  it('单块高于整页时报告 overflow，且不静默丢弃', () => {
    const blocks = [block('a'), block('huge'), block('b')]
    const { pages, overflowing } = run(blocks, { a: 30, huge: 250, b: 30 }, 100)
    expect(overflowing).toEqual(['huge'])
    expect(pages.flatMap((p) => p.blocks.map((b) => b.id))).toEqual(['a', 'huge', 'b'])
  })

  it('所有块都会出现在结果里，顺序不变', () => {
    const blocks = Array.from({ length: 30 }, (_, i) => block(`b${i}`, { spaceAbove: i % 3 }))
    const heights = Object.fromEntries(blocks.map((b, i) => [b.id, 10 + (i % 7) * 5]))
    const { pages } = run(blocks, heights, 120)
    expect(pages.flatMap((p) => p.blocks.map((b) => b.id))).toEqual(blocks.map((b) => b.id))
  })

  it('每页用量不超过内容区高度（除单块超高的情况）', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => block(`b${i}`, { spaceAbove: 3 }))
    const heights = Object.fromEntries(blocks.map((b, i) => [b.id, 12 + (i % 5) * 4]))
    const { pages } = run(blocks, heights, 150)
    for (const page of pages) {
      expect(page.used).toBeLessThanOrEqual(150)
    }
  })
})

describe('pageGeometry', () => {
  it('按 A4 与边距算出内容区尺寸', () => {
    const g = pageGeometry({ top: 14, right: 15, bottom: 12, left: 15 })
    // 宽 210-30=180mm，高 297-26=271mm
    expect(g.contentHeightPt).toBeCloseTo(mmToPt(271), 4)
    expect(g.contentWidthPx).toBeCloseTo((mmToPt(180) / 72) * 96, 4)
  })
})
