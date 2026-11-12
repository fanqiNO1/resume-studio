/**
 * 离屏测量：从已渲染的隐藏容器里读出每个 block 的实际高度，喂给分页器。
 *
 * 关键约束：
 *  1. 测量容器的宽度必须精确等于页内容区宽度，否则换行点不同、高度就错。
 *  2. 必须等 document.fonts.ready —— 用回退字体测出来的高度是错的，
 *     会导致断页位置漂移。字体的 font-display: block 与这里的等待配合。
 *  3. 容器必须继承与真实渲染完全相同的 CSS（所以它挂在 PreviewPane 内部，
 *     而不是 document.body 下）。
 */

/**
 * 从已渲染的 DOM 中读取每个 block 的内容高度（pt）。
 *
 * 用 getBoundingClientRect 而非 offsetHeight：前者是亚像素精度，
 * 后者取整会在十几个块上累积出可观的误差，足以改变断页位置。
 */
export function measureBlocks(root: HTMLElement): Map<string, number> {
  const result = new Map<string, number>()
  const nodes = root.querySelectorAll<HTMLElement>('[data-block-id]')
  for (const node of nodes) {
    const id = node.dataset.blockId
    if (!id) continue
    const rect = node.getBoundingClientRect()
    result.set(id, pxToPt(rect.height))
  }
  return result
}

export function pxToPt(px: number): number {
  return (px / 96) * 72
}

/** 等字体就绪。分页必须在此之后进行。 */
export async function waitForFonts(): Promise<void> {
  if (typeof document === 'undefined') return
  try {
    await document.fonts.ready
  } catch {
    // 老浏览器没有 document.fonts，退化为不等待
  }
}
