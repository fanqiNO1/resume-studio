/**
 * 服务端 PDF 导出。
 *
 * 为什么必须在服务端生成（而不是浏览器 window.print）：用户可能通过端口转发
 * 在另一台机器的浏览器里编辑，那台机器的字体环境不可控。服务端生成保证
 * 字体与渲染环境固定，且能顺带把 PDF 归档进 data/。见 docs/DESIGN.md §5.2。
 *
 * Playwright 访问的是服务端回环地址，与用户那侧的端口转发无关。
 */
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Browser, BrowserContext } from 'playwright-core'

/** 常驻浏览器：首次冷启约 800ms，之后每次导出约 200ms */
let browserPromise: Promise<Browser> | null = null

/** 优先复用本机已装的 Chrome/Edge，避免下载 Playwright 自带的 Chromium */
const CHANNEL_CANDIDATES = ['chrome', 'msedge', 'chromium'] as const

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright-core')
  const args = [
    // 这两个只影响光栅化观感，不改变字形 metrics（已由 check:fidelity 验证漂移为 0）
    '--font-render-hinting=none',
    '--disable-lcd-text',
    //
    // 不要加 --disable-font-subpixel-positioning：它会改变行盒高度，
    // 实测在 32 个块里改掉 8 个，页面底部累计漂移 1.31pt。那样导出结果就
    // 不再等于用户在浏览器里看到的预览 —— 违反渲染契约。
  ]

  const errors: string[] = []
  for (const channel of CHANNEL_CANDIDATES) {
    try {
      return await chromium.launch({ channel, args })
    } catch (err) {
      errors.push(`${channel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // 回落到 Playwright 自带的 Chromium（若已 install）
  try {
    return await chromium.launch({ args })
  } catch (err) {
    errors.push(`bundled: ${err instanceof Error ? err.message : String(err)}`)
    throw new Error(
      '无法启动任何 Chromium。请安装 Chrome/Edge，或执行 npx playwright install chromium。\n' +
        errors.join('\n'),
    )
  }
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      // 失败后清空缓存，下次请求可以重试
      browserPromise = null
      throw err
    })
  }
  return browserPromise
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return
  const p = browserPromise
  browserPromise = null
  try {
    const browser = await p
    await browser.close()
  } catch {
    // 关闭失败无所谓，进程即将退出
  }
}

/**
 * 渲染文件名模板。
 *
 * 取不到值的占位符整段省略，并清理多余分隔符 —— 公开版没勾手机号时
 * 不应该产出「张三-通用-.pdf」。见 docs/DESIGN.md §5.3。
 */
export function renderFilename(
  template: string,
  values: Record<string, string>,
): string {
  let out = template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
  out = out
    .replace(/[-_·]{2,}/g, '-')
    .replace(/^[-_·\s]+|[-_·\s]+$/g, '')
    .replace(/[/\\:*?"<>|]/g, '')
    .trim()
  return `${out || 'resume'}.pdf`
}

interface PositionFile {
  meta?: {
    name?: string
    targetPosition?: string
    filenameTemplate?: string
    public?: boolean
  }
  contactInclude?: string[]
}

interface ProfileFile {
  basics?: {
    name?: string
    contacts?: { id: string; type: string; value: string }[]
  }
}

async function computeFilename(id: string, dataDir: string): Promise<string> {
  const position = JSON.parse(
    await readFile(path.join(dataDir, 'positions', id, 'position.json'), 'utf8'),
  ) as PositionFile
  const profile = JSON.parse(
    await readFile(path.join(dataDir, 'profile.json'), 'utf8'),
  ) as ProfileFile

  const included = new Set(position.contactInclude ?? [])
  const contacts = (profile.basics?.contacts ?? []).filter((c) => included.has(c.id))
  const pick = (type: string) => contacts.find((c) => c.type === type)?.value ?? ''

  return renderFilename(position.meta?.filenameTemplate ?? '{name}-{positionName}', {
    name: profile.basics?.name ?? '',
    positionName: position.meta?.name ?? id,
    targetPosition: position.meta?.targetPosition ?? '',
    // 手机号去掉连字符与空格，HR 系统更好处理
    phone: pick('phone').replace(/[-\s]/g, ''),
    email: pick('email'),
    date: new Date().toISOString().slice(0, 10),
  })
}

export interface ExportOptions {
  id: string
  port: number
  dataDir: string
}

export interface ExportResult {
  filename: string
  pages: number
  bytes: number
  ms: number
  /** 非致命的问题（比如字体子集没生成），前端提示一下 */
  warning?: string
}

/**
 * 自托管字体子集是否在位。
 *
 * 缺了不会报错 —— 浏览器会退回系统字体，预览和 PDF 仍然一致（渲染契约不破），
 * 但导出会退化：Chromium 只能把系统 CFF 字体以 Type3 嵌进 PDF（逐字形填充路径，
 * 没有字体名、体积大三倍、放大发虚）。所以值得提醒一次。
 */
const FONT_PROBE = path.join(process.cwd(), 'public/fonts/generated/serif-400-base.woff2')
let fontWarning: string | undefined

async function checkFonts(): Promise<string | undefined> {
  if (fontWarning === undefined) {
    try {
      await stat(FONT_PROBE)
      fontWarning = undefined
    } catch {
      fontWarning =
        '未找到自托管字体子集（public/fonts/generated/）：PDF 将退回系统字体并退化成 Type3' +
        '（体积大、无字体名、放大发虚）。请先运行 scripts/prepare-fonts.sh。'
    }
  }
  return fontWarning
}

export async function exportPositionPdf(options: ExportOptions): Promise<ExportResult> {
  const started = Date.now()
  const { id, port, dataDir } = options
  const filename = await computeFilename(id, dataDir)
  const outPath = path.join(dataDir, 'positions', id, filename)

  const browser = await getBrowser()
  let context: BrowserContext | null = null
  try {
    context = await browser.newContext({
      // A4 宽度对应的 CSS 像素，避免视口过窄触发意外的响应式行为
      viewport: { width: 900, height: 1400 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()

    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    // 127.0.0.1 是服务端本机回环；用户那侧的端口转发不影响这里
    const url = `http://127.0.0.1:${port}/print?position=${encodeURIComponent(id)}`
    const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
    if (!response || !response.ok()) {
      throw new Error(`加载打印页面失败：${url} → ${response?.status() ?? '无响应'}`)
    }

    // 等分页完成（字体就绪 → 测量 → 装箱 → 页面盒子布局完毕）
    await page.waitForFunction(
      () => (window as unknown as { __RESUME_READY__?: boolean }).__RESUME_READY__ === true,
      undefined,
      { timeout: 30_000 },
    )

    if (consoleErrors.length) {
      console.warn(`[export] 打印页面报告了 ${consoleErrors.length} 条错误：`)
      consoleErrors.slice(0, 5).forEach((e) => console.warn('  ' + e))
    }

    const pageCount = await page.evaluate(() => document.querySelectorAll('.page').length)
    if (pageCount === 0) throw new Error('打印页面没有渲染出任何页面盒子')

    const pdf = await page.pdf({
      // 用 CSS 里的 @page size，而不是 Playwright 的 format
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      tagged: true,
      outline: false,
    })

    const withMeta = await stampMetadata(pdf, { id, dataDir })

    await mkdir(path.dirname(outPath), { recursive: true })
    const tmp = `${outPath}.tmp`
    await writeFile(tmp, withMeta)
    await rename(tmp, outPath)

    const { size } = await stat(outPath)
    const result: ExportResult = { filename, pages: pageCount, bytes: size, ms: Date.now() - started }
    const warning = await checkFonts()
    if (warning) {
      result.warning = warning
      console.warn(`[export] ${warning}`)
    }
    return result
  } finally {
    await context?.close()
  }
}

/** Chromium 不给设 PDF 元数据，导出后用 pdf-lib 补写 */
async function stampMetadata(
  pdf: Buffer,
  ctx: { id: string; dataDir: string },
): Promise<Buffer> {
  try {
    const { PDFDocument } = await import('pdf-lib')
    const profile = JSON.parse(
      await readFile(path.join(ctx.dataDir, 'profile.json'), 'utf8'),
    ) as ProfileFile
    const position = JSON.parse(
      await readFile(path.join(ctx.dataDir, 'positions', ctx.id, 'position.json'), 'utf8'),
    ) as PositionFile

    const doc = await PDFDocument.load(pdf)
    const name = profile.basics?.name ?? ''
    const target = position.meta?.targetPosition || position.meta?.name || ''
    doc.setTitle(`${name} 简历${target ? ` · ${target}` : ''}`)
    doc.setAuthor(name)
    doc.setSubject(target)
    doc.setCreator('resume-studio')
    doc.setProducer('resume-studio')
    return Buffer.from(await doc.save())
  } catch (err) {
    // 元数据是加分项，写不进去不该让导出失败
    console.warn('[export] PDF 元数据写入失败，产物仍然可用：', err)
    return pdf
  }
}
