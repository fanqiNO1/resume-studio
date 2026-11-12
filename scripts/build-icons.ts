/**
 * 从 iconify 离线数据里抽出实际用到的图标，生成 src/components/preview/icons.ts。
 *
 * 为什么不用图标字体：图标字体在 PDF 里容易出现字距异常或缺字，而内联 SVG
 * 是矢量、跟随 currentColor、零字体依赖。
 * 为什么不用 unplugin-icons 运行时按需：图标集固定且很少，构建期抽成常量最省事，
 * 也让 PDF 导出路径不依赖额外插件。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 用到的图标：小节标题 + 联系方式 */
const WANTED: Record<string, { set: 'fa6-solid' | 'fa6-brands'; name: string }> = {
  'graduation-cap': { set: 'fa6-solid', name: 'graduation-cap' },
  'file-lines': { set: 'fa6-solid', name: 'file-lines' },
  flask: { set: 'fa6-solid', name: 'flask' },
  'building-user': { set: 'fa6-solid', name: 'building-user' },
  'screwdriver-wrench': { set: 'fa6-solid', name: 'screwdriver-wrench' },
  trophy: { set: 'fa6-solid', name: 'trophy' },
  briefcase: { set: 'fa6-solid', name: 'briefcase' },
  'list-check': { set: 'fa6-solid', name: 'list-check' },
  phone: { set: 'fa6-solid', name: 'phone' },
  envelope: { set: 'fa6-solid', name: 'envelope' },
  link: { set: 'fa6-solid', name: 'link' },
  comment: { set: 'fa6-solid', name: 'comment' },
  'location-dot': { set: 'fa6-solid', name: 'location-dot' },
  'circle-info': { set: 'fa6-solid', name: 'circle-info' },
  github: { set: 'fa6-brands', name: 'github' },
  linkedin: { set: 'fa6-brands', name: 'linkedin-in' },
}

interface IconifyJson {
  width?: number
  height?: number
  icons: Record<string, { body: string; width?: number; height?: number }>
}

/** 从 <path d="…"/> 里抽出 d。图标 body 可能含多个 path，全部保留。 */
function extractPaths(body: string): string[] {
  const out: string[] = []
  const re = /<path[^>]*\sd="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out.push(m[1])
  return out
}

async function loadSet(set: string): Promise<IconifyJson> {
  const p = path.join(ROOT, 'node_modules', `@iconify-json/${set}/icons.json`)
  return JSON.parse(await readFile(p, 'utf8')) as IconifyJson
}

async function main(): Promise<void> {
  const sets = new Map<string, IconifyJson>()
  for (const set of ['fa6-solid', 'fa6-brands']) {
    sets.set(set, await loadSet(set))
  }

  const entries: string[] = []
  const missing: string[] = []

  for (const [key, ref] of Object.entries(WANTED)) {
    const data = sets.get(ref.set)!
    const icon = data.icons[ref.name]
    if (!icon) {
      missing.push(`${ref.set}:${ref.name}`)
      continue
    }
    const w = icon.width ?? data.width ?? 24
    const hgt = icon.height ?? data.height ?? 24
    const paths = extractPaths(icon.body)
    if (paths.length === 0) {
      missing.push(`${ref.set}:${ref.name}（body 不含 path）`)
      continue
    }
    // 多 path 用 fill-rule 无关的拼接方式合并，SVG 允许 d 中多段 subpath
    const d = paths.join(' ')
    entries.push(`  '${key}': { viewBox: '0 0 ${w} ${hgt}', d: '${d}' },`)
  }

  if (missing.length) {
    console.error('以下图标未找到：\n  ' + missing.join('\n  '))
    process.exit(1)
  }

  const out = `/**
 * 由 scripts/build-icons.ts 从 @iconify-json 生成，请勿手改。
 * 需要新图标时改 scripts/build-icons.ts 的 WANTED 再跑 npm run icons。
 *
 * 图标数据来自 Font Awesome 6 Free（CC BY 4.0）。
 */

export interface IconPath {
  viewBox: string
  d: string
}

export const ICONS: Record<string, IconPath> = {
${entries.join('\n')}
}
`

  const dest = path.join(ROOT, 'src/components/preview/icons.ts')
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, out, 'utf8')
  console.log(`已写出 ${path.relative(ROOT, dest)}（${entries.length} 个图标）`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
