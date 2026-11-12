/**
 * 保真校验：确认「预览」与「导出」两个环境算出的分页结果一致。
 *
 * 这是渲染契约的执行者（docs/DESIGN.md §2.5、AGENTS.md §4）。
 * 改动 src/render/ 或 src/styles/ 之后必须跑。失败意味着预览与 PDF 已经不一致，
 * 不要调阈值绕过 —— 那正是这个工具唯一不能出的错。
 *
 * 做法：用两组不同的浏览器参数（模拟用户预览环境 vs 导出环境）加载同一个
 * /print 页面，比对每页的 block id 序列与页内 y 偏移。
 */
import { chromium, type Browser } from 'playwright-core'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const PORT = Number(process.env.PORT ?? 5178)
const ORIGIN = `http://127.0.0.1:${PORT}`
/** y 偏移允许的差异，pt。超过说明排版真的漂了。 */
const Y_TOLERANCE_PT = 0.5

interface Layout {
  pages: { blockIds: string[]; offsets: number[] }[]
}

/**
 * 两组参数必须与 server/export.ts 里实际使用的保持一致。
 * preview 代表用户浏览器（无特殊参数），export 代表导出环境。
 */
const PROFILES = {
  preview: [] as string[],
  export: ['--font-render-hinting=none', '--disable-lcd-text'],
}

async function launch(args: string[]): Promise<Browser> {
  for (const channel of ['chrome', 'msedge', 'chromium'] as const) {
    try {
      return await chromium.launch({ channel, args })
    } catch {
      /* 试下一个 */
    }
  }
  return chromium.launch({ args })
}

async function captureLayout(browser: Browser, positionId: string): Promise<Layout> {
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } })
  try {
    await page.goto(`${ORIGIN}/print?position=${encodeURIComponent(positionId)}`, {
      waitUntil: 'load',
    })
    await page.waitForFunction(
      () => (window as unknown as { __RESUME_READY__?: boolean }).__RESUME_READY__ === true,
      undefined,
      { timeout: 30_000 },
    )
    return page.evaluate(() => {
      const pages = [...document.querySelectorAll('.page')]
      return {
        pages: pages.map((pageEl) => {
          const top = pageEl.getBoundingClientRect().top
          const blocks = [...pageEl.querySelectorAll('[data-block-id]')].filter(
            // 只取 block 根元素，不取嵌套的（目前没有嵌套，防御性过滤）
            (el) => el.parentElement === pageEl,
          )
          return {
            blockIds: blocks.map((el) => (el as HTMLElement).dataset.blockId ?? ''),
            offsets: blocks.map(
              (el) => ((el.getBoundingClientRect().top - top) / 96) * 72,
            ),
          }
        }),
      }
    })
  } finally {
    await page.close()
  }
}

function compare(id: string, a: Layout, b: Layout): string[] {
  const problems: string[] = []

  if (a.pages.length !== b.pages.length) {
    problems.push(`页数不同：预览 ${a.pages.length} 页，导出 ${b.pages.length} 页`)
    return problems
  }

  a.pages.forEach((pa, i) => {
    const pb = b.pages[i]
    const sa = pa.blockIds.join('|')
    const sb = pb.blockIds.join('|')
    if (sa !== sb) {
      problems.push(
        `第 ${i + 1} 页断页位置不同：\n` +
          `    预览: ${pa.blockIds.join(', ')}\n` +
          `    导出: ${pb.blockIds.join(', ')}`,
      )
      return
    }
    pa.offsets.forEach((ya, j) => {
      const yb = pb.offsets[j]
      const delta = Math.abs(ya - yb)
      if (delta > Y_TOLERANCE_PT) {
        problems.push(
          `第 ${i + 1} 页 ${pa.blockIds[j]} 的 y 偏移差 ${delta.toFixed(2)}pt` +
            `（超过容差 ${Y_TOLERANCE_PT}pt）`,
        )
      }
    })
  })

  void id
  return problems
}

async function main(): Promise<void> {
  const positionsDir = path.resolve(process.cwd(), 'data/positions')
  const entries = await readdir(positionsDir, { withFileTypes: true })
  const ids = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)

  if (ids.length === 0) {
    console.error('data/positions/ 下没有岗位')
    process.exit(1)
  }

  // 先确认 dev server 在跑
  try {
    const res = await fetch(`${ORIGIN}/api/bootstrap`)
    if (!res.ok) throw new Error(String(res.status))
  } catch {
    console.error(`连不上 ${ORIGIN}。请先在另一个终端跑 npm run dev。`)
    process.exit(1)
  }

  const previewBrowser = await launch(PROFILES.preview)
  const exportBrowser = await launch(PROFILES.export)

  let failed = 0
  try {
    for (const id of ids) {
      const [preview, exported] = await Promise.all([
        captureLayout(previewBrowser, id),
        captureLayout(exportBrowser, id),
      ])
      const problems = compare(id, preview, exported)
      if (problems.length === 0) {
        console.log(`✓ ${id}：${preview.pages.length} 页，分页与 y 偏移完全一致`)
      } else {
        failed++
        console.error(`✗ ${id}：`)
        problems.forEach((p) => console.error('  ' + p))
      }
    }
  } finally {
    await previewBrowser.close()
    await exportBrowser.close()
  }

  if (failed > 0) {
    console.error(`\n${failed} 个岗位的预览与导出结果不一致。这是 P0 bug，不要调容差绕过。`)
    process.exit(1)
  }
  console.log('\n渲染契约校验通过。')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
