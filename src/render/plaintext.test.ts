import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Position, Profile, Template } from '@/schema'
import { resolveResume } from '@/render/resolve'
import { buildBlocks, LINK_ICON_MARK, type Block } from '@/render/blocks'
import { blocksToSections, blocksToText } from '@/render/plaintext'

const ROOT = path.resolve(__dirname, '../..')
const read = <T>(p: string): T => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8')) as T

// 同 resolve.test.ts：行为断言只用固件，不碰 data/ 里的真实简历
// 测试固件就是仓库里的示例数据（data.sample/）——只有一份假数据，不用维护两套。
const profile = Profile.parse(read('data.sample/profile.json'))
const posA = Position.parse(read('data.sample/positions/general/position.json'))
const posB = Position.parse(read('data.sample/positions/research/position.json'))
/** 可公开版：只留 GitHub */
const posPublic = Position.parse(read('data.sample/positions/public/position.json'))

/** 模板优先读 data/templates/，没有就用仓库里的 data.sample/templates/ */
function readTemplate(name: string): Template {
  for (const dir of ['data/templates', 'data.sample/templates']) {
    const p = path.join(ROOT, dir, name)
    if (existsSync(p)) {
      return Template.parse(JSON.parse(readFileSync(p, 'utf8')) as unknown)
    }
  }
  throw new Error(`找不到模板：${name}`)
}

// 只保留 academic-serif 一套模板（对齐 resume.cls）
const template = readTemplate('academic-serif.json')

const blocksOf = (position: Position, tpl: Template = template) =>
  buildBlocks({
    resume: resolveResume({ profile, position, template: tpl }),
    selfNames: [profile.basics.name, profile.basics.nameEn, ...profile.basics.aliases].filter(Boolean),
  })

const blocks = blocksOf(posA)

const plain = blocksToText(blocks)
const md = blocksToText(blocks, { format: 'markdown' })

/** 造只关心文本内容的块；排版字段填中性值，纯文本层用不到 */
const BASE = { itemId: '', sectionId: '', keepWithNext: false, spaceAbove: 0, spaceBelow: 0 }
const bullet = (text: string): Block => ({ ...BASE, id: 't_bullet', kind: 'bullet', text })
const para = (text: string): Block => ({
  ...BASE,
  id: 't_para',
  kind: 'paragraph',
  variant: 'body',
  text,
})
const pubTight = (title: string, venueShort: string): Block => ({
  ...BASE,
  id: 't_pub',
  kind: 'pubTight',
  title,
  venueShort,
})

describe('plaintext：渲染层占位符不外泄', () => {
  /*
   * 论文链接在 blocks 里是 [⧉](url) —— ⧉ 只是给预览层换成 SVG 图标用的信号。
   * 它一旦进入复制内容，粘到招聘表单里就是个乱码方块。开发时真的漏过一次。
   */
  it('链接图标占位符不出现在任何格式里', () => {
    expect(blocks.some((b) => JSON.stringify(b).includes(LINK_ICON_MARK))).toBe(true)
    expect(plain).not.toContain(LINK_ICON_MARK)
    expect(md).not.toContain(LINK_ICON_MARK)
  })

  it('占位符被剥掉后链接退化成裸 URL，而不是空的 markdown 链接', () => {
    expect(plain).toContain('https://example.com/paper/alpha')
    expect(md).toContain('https://example.com/paper/alpha')
    expect(md).not.toContain('[](')
  })
})

describe('plaintext：标记转换', () => {
  const marked = [bullet('用 **粗体** 与 ==强调== 与 `代码` 与 [文档](https://e.example)')]

  it('纯文本去掉所有标记符号，只留字面内容', () => {
    const out = blocksToText(marked).trim()
    expect(out).toBe('• 用 粗体 与 强调 与 代码 与 文档 (https://e.example)')
  })

  it('markdown 保留粗体，强调降级成粗体（== 不是标准语法）', () => {
    const out = blocksToText(marked, { format: 'markdown' }).trim()
    expect(out).toBe('- 用 **粗体** 与 **强调** 与 `代码` 与 [文档](https://e.example)')
  })

  it('小节标题在 markdown 下是二级标题，纯文本下是裸标题', () => {
    expect(md).toContain('## 论文成果')
    expect(plain).toContain('\n论文成果\n')
    expect(plain).not.toContain('## ')
  })
})

describe('plaintext：中英加空格', () => {
  const b = [para('负责PyTorch相关开发')]

  it('开启时在 CJK/拉丁边界插真实空格', () => {
    expect(blocksToText(b, { autoSpace: true }).trim()).toBe('负责 PyTorch 相关开发')
  })

  it('关闭时严格保留原文', () => {
    expect(blocksToText(b, { autoSpace: false }).trim()).toBe('负责PyTorch相关开发')
  })
})

describe('plaintext：空行层次', () => {
  it('条目之间空一行，条目内部（摘要、要点）不空', () => {
    const exp = blocksToText(blocks).split('\n')
    const i = exp.findIndex((l) => l.startsWith('示例公司'))
    expect(i).toBeGreaterThan(-1)
    // 摘要与要点紧跟标题行
    expect(exp[i + 1]).toBe('示例摘要。')
    expect(exp[i + 2]).toBe('• 示例要点 1，含 强调')
    // 下一个条目前空一行
    expect(exp[i + 3]).toBe('')
    expect(exp[i + 4]).toContain('示例公司')
  })

  it('小节标题之后不空行 —— 标题与首个条目属于同一块视觉单元', () => {
    const lines = plain.split('\n')
    const i = lines.indexOf('教育背景')
    expect(i).toBeGreaterThan(-1)
    expect(lines[i + 1]).not.toBe('')
  })

  it('不出现连续两个以上空行，且以单个换行结尾', () => {
    expect(plain).not.toMatch(/\n{3}/)
    expect(plain.endsWith('\n')).toBe(true)
    expect(plain.endsWith('\n\n')).toBe(false)
  })
})

describe('plaintext：逐级复制的切分', () => {
  const sections = blocksToSections(blocks)
  const find = (t: string) => sections.find((s) => s.title === t)!

  it('页首自成一段，标题为空', () => {
    expect(sections[0].title).toBe('')
    expect(sections[0].content).toContain('示例人')
  })

  it('每个小节一段，顺序与 blocks 一致', () => {
    expect(sections.slice(1).map((s) => s.title)).toEqual(
      blocks.filter((b) => b.kind === 'sectionTitle').map((b) => (b as { title: string }).title),
    )
  })

  it('小节标题不重复出现在正文里 —— UI 已经在标题栏显示了', () => {
    const pub = find('论文成果')
    expect(pub.content.startsWith('论文成果')).toBe(false)
    expect(pub.content).toContain('Alpha: Example Paper')
  })

  /*
   * 复制粒度必须对齐表单字段的粒度。表单里手机、邮箱、主页是三个输入框，
   * 把整段基本信息复制过去还得手工再切一次 —— 那按钮就没有意义。
   */
  it('基本信息按联系方式逐条切分，不是一整块', () => {
    // 固件 A 是「可公开」版，手机邮箱被脱敏过滤了，所以这里用 B
    const units = blocksToSections(blocksOf(posB))[0].entries[0].units
    expect(units.map((u) => u.label)).toEqual(['姓名', '手机', '邮箱', 'GitHub', '主页'])
    expect(units[1].content).toBe('000-0000-0000')
  })

  it('主页类联系方式复制链接，手机邮箱复制字面值', () => {
    const units = blocksToSections(blocksOf(posB))[0].entries[0].units
    expect(units.find((u) => u.label === 'GitHub')!.content).toBe('https://github.com/sample')
    expect(units.find((u) => u.label === '邮箱')!.content).toBe('sample@example.com')
  })

  it('脱敏过的联系方式不会从纯文本里漏出来', () => {
    // 公开版岗位只勾了 GitHub，手机与邮箱根本不进渲染
    const units = blocksToSections(blocksOf(posPublic))[0].entries[0].units
    expect(units.map((u) => u.label)).toEqual(['姓名', 'GitHub'])
  })

  it('论文的标题、会议、链接、作者各自成栏', () => {
    const pub = find('论文成果').entries[0]
    expect(pub.head).toEqual({ label: '标题', content: 'Alpha: Example Paper' })
    expect(pub.units.map((u) => u.label)).toEqual(['会议', '链接 1', '链接 2', '作者'])
    expect(pub.units[1].content).toBe('https://example.com/paper/alpha')
    expect(pub.units[3].content).toBe('Sample Person, Co Author')
  })

  it('会议字段不夹带链接 —— 链接已经单独一栏', () => {
    const venue = find('论文成果').entries[0].units[0]
    expect(venue.content).not.toContain('http')
    expect(venue.content).not.toContain(LINK_ICON_MARK)
  })

  it('只有一个链接时标签不带序号，没有链接时不占位', () => {
    const one = blocksToSections([pubTight('T', `*V* [${LINK_ICON_MARK}](https://a.example)`)])
    expect(one[0].entries[0].units.map((u) => u.label)).toEqual(['会议', '链接'])
    // 第三篇（itm_pub_c）没有链接 —— 不该占一栏
    expect(find('论文成果').entries[2].units.map((u) => u.label)).toEqual(['会议', '作者'])
  })

  it('经历的标题与内容分开，摘要与要点合成一个「内容」', () => {
    const exp = find('实习经历').entries[0]
    expect(exp.head!.content).toBe('示例公司 · 示例部门 · 示例团队 / 示例角色')
    expect(exp.units.map((u) => u.label)).toEqual(['时间', '内容'])
    expect(exp.units[0].content).toBe('2020.06 – 2021.06')
    expect(exp.units[1].content).toBe('示例摘要。\n• 示例要点 1，含 强调')
  })

  it('每段经历各成一条，不会粘在一起', () => {
    const entries = find('实习经历').entries
    expect(entries).toHaveLength(2)
    expect(entries[1].head!.content).toBe('示例公司')
    // 空条目不该造出空字段
    expect(entries[1].units.map((u) => u.label)).toEqual(['时间'])
  })

  it('教育背景同样按条切分', () => {
    const edu = find('教育背景')
    expect(edu.entries).toHaveLength(2)
    expect(edu.entries[1].head!.content).toContain('本科')
  })

  /*
   * 教育条目的行数由模板决定：academic-serif 是 resume.cls 的两行式
   * （专业与 GPA 独立成行）。切分跟着渲染走，不自己另立规则。
   */
  it('两行式教育条目会切出独立的「内容」栏', () => {
    const edu = blocksToSections(blocksOf(posA)).find((s) => s.title === '教育背景')!
    expect(edu.entries[0].head!.content).toBe('示例大学 / 硕士')
    expect(edu.entries[0].units.map((u) => u.label)).toEqual(['时间', '内容'])
    expect(edu.entries[0].units[1].content).toBe('示例专业，GPA: 3.8/4.0')
  })

  it('奖项条目的标题行含名称与颁发方', () => {
    const awd = find('获奖情况').entries[0]
    expect(awd.head!.label).toBe('标题')
    expect(awd.head!.content).toBe('示例奖项 · 示例等级 · 示例机构')
    expect(awd.units).toEqual([{ label: '时间', content: '2024' }])
  })

  it('「整条」文本与该条目在全文里的样子一致', () => {
    const exp = find('实习经历').entries[0]
    expect(plain).toContain(exp.content)
  })

  it('各段拼起来覆盖全文的所有非空行', () => {
    const joined = sections.map((s) => s.content).join('\n')
    for (const line of plain.split('\n').filter(Boolean)) {
      // 小节标题行只存在于 TextSection.title
      if (blocks.some((b) => b.kind === 'sectionTitle' && b.title === line)) continue
      expect(joined).toContain(line)
    }
  })

  it('段内与条内都不以空行开头或结尾', () => {
    for (const s of sections) {
      expect(s.content).toBe(s.content.trim())
      for (const e of s.entries) expect(e.content).toBe(e.content.trim())
    }
  })

  it('字段内容非空 —— 空字段不该占一个复制按钮', () => {
    for (const s of sections) {
      for (const e of s.entries) {
        for (const u of e.units) expect(u.content).not.toBe('')
      }
    }
  })
})
