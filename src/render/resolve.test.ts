import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Position, Profile, Template, type Item } from '@/schema'
import { resolveResume, applyDensity } from '@/render/resolve'
import { buildBlocks, LINK_ICON_MARK } from '@/render/blocks'

const ROOT = path.resolve(__dirname, '../..')
const read = <T>(p: string): T => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8')) as T

/**
 * 模板从 data/templates/ 读；使用者还没建 data/ 时（刚 clone、还没跑过 dev），
 * 回退到仓库里的 data.sample/templates/ —— 两份内容一致。
 */
function readTemplate(name: string): Template {
  for (const dir of ['data/templates', 'data.sample/templates']) {
    const p = path.join(ROOT, dir, name)
    if (existsSync(p)) {
      return Template.parse(JSON.parse(readFileSync(p, 'utf8')) as unknown)
    }
  }
  throw new Error(`找不到模板：${name}`)
}

/**
 * 行为断言基于 data.sample/（仓库里的虚构数据），不基于 data/ 里的真实简历。
 *
 * 两条纪律，都是踩过坑总结的：
 *  1. 真实简历是用户随时会改的 —— 挪一下小节、翻一个开关，断言具体值的测试
 *     就会红。那不是回归，是正常使用。
 *  2. 岗位是会被删的 —— 硬编码 data/positions/mllm/ 会在用户删掉该岗位后
 *     直接崩掉整个测试文件（已经发生过一次）。
 *
 * 所以：具体行为用固件（自足、可控、刻意造了边界条件），
 * 真实数据只做"能解析、引用不悬空"的结构体检（见文件末尾）。
 */
// 测试固件就是仓库里的示例数据（data.sample/）——只有一份假数据，不用维护两套。
const profile = Profile.parse(read('data.sample/profile.json'))
/** 完整版 */
const posA = Position.parse(read('data.sample/positions/general/position.json'))
/** 演示取舍的版本：论文提前、隐藏条目、要点勾选、字段覆盖 */
const posB = Position.parse(read('data.sample/positions/research/position.json'))
/** 可公开版：只留 GitHub */
const posPublic = Position.parse(read('data.sample/positions/public/position.json'))
// 只保留 academic-serif 一套模板（对齐 resume.cls）
const template = readTemplate('academic-serif.json')

function resolve(position: Position, tpl: Template = template) {
  return resolveResume({ profile, position, template: tpl })
}

function blocksOf(position: Position, tpl: Template = template) {
  return buildBlocks({ resume: resolve(position, tpl), aliases: profile.basics.aliases })
}

describe('resolve：shared 与 position-local 分层', () => {
  it('隐藏的条目不进结果', () => {
    const ids = resolve(posB)
      .sections.flatMap((s) => s.items)
      .map((i) => i.item.id)
    expect(ids).not.toContain('itm_pub_b')
    expect(ids).toContain('itm_pub_a')
  })

  it('隐藏的小节整体不进结果', () => {
    expect(resolve(posB).sections.map((s) => s.id)).not.toContain('sec_award')
    expect(resolve(posA).sections.map((s) => s.id)).toContain('sec_award')
  })

  it('顺序由岗位层决定，与内容池顺序无关', () => {
    // 固件 B 刻意把 sec_pub 提到 sec_edu 前面
    expect(resolve(posB).sections.map((s) => s.id).slice(0, 2)).toEqual(['sec_pub', 'sec_edu'])
    expect(resolve(posA).sections.map((s) => s.id).slice(0, 2)).toEqual(['sec_edu', 'sec_pub'])
  })

  it('小节标题可被岗位层覆盖', () => {
    expect(resolve(posB).sections.find((s) => s.id === 'sec_pub')!.title).toBe('研究成果')
    expect(resolve(posA).sections.find((s) => s.id === 'sec_pub')!.title).toBe('论文成果')
  })

  it('pitch 是 position-local：一个岗位有值不影响另一个', () => {
    const find = (p: Position) =>
      resolve(p)
        .sections.flatMap((s) => s.items)
        .find((i) => i.item.id === 'itm_pub_a')!
    expect(find(posB).pitch).toBe('示例一句话展开。')
    expect(find(posA).pitch).toBe('')
    // 内容池里根本没有 pitch 这个字段
    expect('pitch' in profile.items.itm_pub_a).toBe(false)
  })

  it('overrides 覆盖 shared 字段，且不改动内容池', () => {
    const before = (profile.items.itm_prj_a as { summary: string }).summary
    const item = resolve(posB)
      .sections.flatMap((s) => s.items)
      .find((i) => i.item.id === 'itm_prj_a')!
    expect(item.overriddenFields).toEqual(['summary'])
    expect((item.item as { summary: string }).summary).toBe('示例摘要。')
    // 原始池数据未被污染
    expect((profile.items.itm_prj_a as { summary: string }).summary).toBe(before)
  })

  it('bulletInclude 过滤要点，null 表示全部', () => {
    const pick = (p: Position) =>
      resolve(p)
        .sections.flatMap((s) => s.items)
        .find((i) => i.item.id === 'itm_prj_a')!
        .bullets.map((b) => b.id)
    expect(pick(posB)).toEqual(['pb_a1', 'pb_a2'])
    expect(pick(posA)).toEqual(['pb_a1', 'pb_a2', 'pb_a3'])
  })

  it('public 标记传给渲染层，供校验器告警', () => {
    expect(resolve(posPublic).public).toBe(true)
    expect(resolve(posB).public).toBe(false)
  })

  it('只渲染被 contactInclude 选中的联系方式', () => {
    expect(resolve(posPublic).contacts.map((c) => c.id)).toEqual(['c_gh'])
    expect(resolve(posB).contacts.map((c) => c.id)).toEqual(['c_phone', 'c_mail', 'c_gh'])
    // 可公开版不该带出敏感项
    expect(resolve(posPublic).contacts.some((c) => c.sensitive)).toBe(false)
  })
})

describe('blocks：论文', () => {
  it('自己的名字在作者列表里被标记出来', () => {
    const authors = blocksOf(posA).find((b) => b.id === 'itm_pub_a:authors')!
    const text = 'text' in authors ? authors.text : ''
    // academic-serif 的 selfAuthorBold = false → 只加下划线（resume.cls 的做法）
    expect(text).toContain('_Sample Person_')
    expect(text).not.toContain('**_Sample Person_**')
    expect(text).toContain('Co Author')
  })

  it('selfAuthorBold=false 时只加下划线（resume.cls 的做法）', () => {
    expect(template.entry.selfAuthorBold).toBe(false)
    const authors = blocksOf(posA).find((b) => b.id === 'itm_pub_a:authors')!
    const text = 'text' in authors ? authors.text : ''
    expect(text).toContain('_Sample Person_')
    expect(text).not.toContain('**_Sample Person_**')
  })

  it('tight 档产出 2 块，standard/expanded 产出 3 块', () => {
    const a = blocksOf(posA)
    expect(a.find((b) => b.id === 'itm_pub_a:pub')!.kind).toBe('pubTight')
    expect(a.some((b) => b.id === 'itm_pub_a:authors')).toBe(true)
    expect(a.some((b) => b.id === 'itm_pub_a:venue')).toBe(false)

    const b = blocksOf(posB)
    expect(b.find((x) => x.id === 'itm_pub_a:pub')!.kind).toBe('pubTitle')
    expect(b.some((x) => x.id === 'itm_pub_a:venue')).toBe(true)
    expect(b.some((x) => x.id === 'itm_pub_a:authors')).toBe(true)
  })

  it('expanded 档渲染 pitch 与岗位专属要点', () => {
    const b = blocksOf(posB)
    expect(b.some((x) => x.id === 'itm_pub_a:pitch')).toBe(true)
    expect(b.some((x) => x.id === 'itm_pub_a:b:xb_r1')).toBe(true)
  })

  it('standard 档：链接紧跟会议名，渲染成图标标记', () => {
    const venue = blocksOf(posB).find((b) => b.id === 'itm_pub_a:venue')!
    const text = 'text' in venue ? venue.text : ''
    expect(text).toContain(`[${LINK_ICON_MARK}](https://example.com/paper/alpha)`)
    expect(text).toContain(`[${LINK_ICON_MARK}](https://example.com/code/alpha)`)
    // 会议名在链接之前
    expect(text.indexOf('Example Conference')).toBeLessThan(text.indexOf(LINK_ICON_MARK))
  })

  it('tight 档：链接跟着会议简称，而不是跑到作者行', () => {
    const pub = blocksOf(posA).find((b) => b.id === 'itm_pub_a:pub')!
    const venueShort = 'venueShort' in pub ? pub.venueShort : ''
    expect(venueShort).toContain('EC 2025')
    expect(venueShort).toContain(`[${LINK_ICON_MARK}](https://example.com/paper/alpha)`)
    // 作者行只有作者
    const authors = blocksOf(posA).find((b) => b.id === 'itm_pub_a:authors')!
    expect('text' in authors && authors.text).not.toContain(LINK_ICON_MARK)
  })

  it('会议简称是斜体，链接图标不被斜体化', () => {
    const pub = blocksOf(posA).find((b) => b.id === 'itm_pub_a:pub')!
    const venueShort = 'venueShort' in pub ? pub.venueShort : ''
    // 斜体标记只包住会议名
    expect(venueShort.startsWith('*EC 2025*')).toBe(true)
  })

  it('空字符串链接被跳过，不产出空标记', () => {
    const withBad: typeof profile = JSON.parse(JSON.stringify(profile))
    const pub = withBad.items.itm_pub_a as Extract<Item, { kind: 'publication' }>
    pub.links = ['', '   ', 'https://c.d']
    const r = resolveResume({ profile: withBad, position: posB, template })
    const venue = buildBlocks({ resume: r, aliases: [] }).find((b) => b.id === 'itm_pub_a:venue')!
    const text = 'text' in venue ? venue.text : ''
    expect(text).toContain('https://c.d')
    expect(text).not.toContain('()')
    expect((text.match(new RegExp(LINK_ICON_MARK, 'g')) ?? []).length).toBe(1)
  })

  it('无链接时会议行不留多余空格', () => {
    const venue = blocksOf(posB).find((b) => b.id === 'itm_pub_noauth:venue')!
    const text = 'text' in venue ? venue.text : ''
    expect(text).toBe(`*${(profile.items.itm_pub_noauth as Extract<Item, { kind: 'publication' }>).venue}*`)
  })

  it('无作者的论文不产出空的作者块', () => {
    expect(profile.items.itm_pub_noauth).toMatchObject({ authors: [] })
    expect(blocksOf(posA).some((b) => b.id === 'itm_pub_noauth:authors')).toBe(false)
  })
})

describe('blocks：实习条目的组织链', () => {
  it('按 公司 · 部门 · 团队 / 角色 组装', () => {
    const head = blocksOf(posA).find((b) => b.id === 'itm_exp_a:head')!
    const left = 'left' in head ? head.left : ''
    expect(left).toBe('**示例公司** · 示例部门 · 示例团队 / *示例角色*')
  })

  it('包含链顺序：公司 → 部门 → 团队', () => {
    const head = blocksOf(posA).find((b) => b.id === 'itm_exp_a:head')!
    const left = 'left' in head ? head.left : ''
    expect(left.indexOf('示例公司')).toBeLessThan(left.indexOf('示例部门'))
    expect(left.indexOf('示例部门')).toBeLessThan(left.indexOf('示例团队'))
  })

  it('缺项时不留下多余分隔符', () => {
    const head = blocksOf(posA).find((b) => b.id === 'itm_exp_b:head')!
    const left = 'left' in head ? head.left : ''
    expect(left).toBe('**示例公司**')
    expect(left).not.toContain('·')
    expect(left).not.toContain('/')
  })
})

describe('blocks：通用', () => {
  it('detail=summary 时不产出要点', () => {
    const b = blocksOf(posB)
    expect(b.filter((x) => x.kind === 'bullet' && x.itemId === 'itm_exp_a')).toHaveLength(0)
    expect(b.some((x) => x.id === 'itm_exp_a:summary')).toBe(true)
  })

  it('项目摘要原样渲染，不做任何自动拼接', () => {
    const summary = blocksOf(posA).find((b) => b.id === 'itm_prj_a:summary')!
    const item = profile.items.itm_prj_a as Extract<Item, { kind: 'project' }>
    expect('text' in summary && summary.text).toBe(item.summary)
  })

  it('spacingAfter 落在条目最后一块上', () => {
    const b = blocksOf(posB).filter((x) => x.itemId === 'itm_prj_a')
    const last = b[b.length - 1]
    // 固件 B 用 compact 密度，并给 itm_prj_a 设了 -3pt
    const entryBelow = applyDensity(template, 'compact').spacing.entryBelow
    expect(last.spaceBelow).toBeCloseTo(entryBelow - 3, 5)
  })

  it('block id 全局唯一（分页与测量依赖它）', () => {
    for (const pos of [posA, posB]) {
      const ids = blocksOf(pos).map((b) => b.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('小节标题要求 keepWithNext，最后一块不要求', () => {
    const b = blocksOf(posA)
    expect(b.find((x) => x.kind === 'sectionTitle')!.keepWithNext).toBe(true)
    expect(b[b.length - 1].keepWithNext).toBe(false)
  })

  it('教育条目用 twoLine（专业与 GPA 独立成行）', () => {
    expect(template.entry.educationLayout).toBe('twoLine')
    expect(blocksOf(posA).some((b) => b.id === 'itm_edu_ms:detail')).toBe(true)
  })
})

describe('layout.targetPages', () => {
  it('是每个岗位独立的设置', () => {
    // 固件 A / B 都显式写了目标篇幅，schema 默认 1
    expect(posA.layout.targetPages).toBeGreaterThan(0)
    expect(posB.layout.targetPages).toBeGreaterThan(0)
  })

  it('必须是正整数（避免 0 页或负数导致 autofit 死循环）', () => {
    expect(() => Position.parse({ schemaVersion: 1, meta: { name: 'x' }, layout: { targetPages: 0 } })).toThrow()
    expect(() => Position.parse({ schemaVersion: 1, meta: { name: 'x' }, layout: { targetPages: -1 } })).toThrow()
    expect(() => Position.parse({ schemaVersion: 1, meta: { name: 'x' }, layout: { targetPages: 1.5 } })).toThrow()
    expect(Position.parse({ schemaVersion: 1, meta: { name: 'x' }, layout: { targetPages: 3 } }).layout.targetPages).toBe(3)
  })

  it('缺省时为 1 页', () => {
    expect(Position.parse({ schemaVersion: 1, meta: { name: 'x' } }).layout.targetPages).toBe(1)
  })
})

describe('applyDensity', () => {
  it('密度档等比缩放字号与间距', () => {
    const std = applyDensity(template, 'standard')
    const compact = applyDensity(template, 'compact')
    expect(compact.baseSize).toBeLessThan(std.baseSize)
    // 间距压得比字号狠
    const sizeRatio = compact.baseSize / std.baseSize
    const spaceRatio = compact.spacing.sectionAbove / std.spacing.sectionAbove
    expect(spaceRatio).toBeLessThan(sizeRatio)
  })

  it('页边距不受密度档影响', () => {
    expect(applyDensity(template, 'extreme').margin).toEqual(template.page.margin)
  })

  it('fitScale 优先压间距', () => {
    const base = applyDensity(template, 'standard', 1)
    const fit = applyDensity(template, 'standard', 0.96)
    expect(fit.baseSize).toBeLessThan(base.baseSize)
    expect(fit.spacing.entryAbove / base.spacing.entryAbove).toBeLessThan(
      fit.baseSize / base.baseSize,
    )
  })
})

/**
 * 结构体检：只验证"能用"，不验证具体内容。
 * 这些断言不会因为使用者编辑简历而失败。
 *
 * 跑两遍：
 *  - data.sample/ —— 仓库里唯一的样例数据，任何时候都该是好的
 *  - data/        —— 使用者自己的数据；不存在（刚 clone）时跳过
 */
function shapeCheck(label: string, dataDir: string) {
  const profilePath = path.join(ROOT, dataDir, 'profile.json')
  if (!existsSync(profilePath)) return

  const profile = Profile.parse(read(`${dataDir}/profile.json`))
  const positionsDir = path.join(ROOT, dataDir, 'positions')
  const positions = existsSync(positionsDir)
    ? readdirSync(positionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .filter((d) => existsSync(path.join(positionsDir, d.name, 'position.json')))
        .map((d) => ({
          id: d.name,
          position: Position.parse(read(`${dataDir}/positions/${d.name}/position.json`)),
        }))
    : []

  it(`${label}：profile.json 通过 schema 校验，且 items map 的 key 与 id 一致`, () => {
    expect(profile.schemaVersion).toBe(1)
    for (const [key, item] of Object.entries(profile.items)) {
      expect(item.id).toBe(key)
    }
  })

  it(`${label}：内容池的 section.itemIds 不悬空`, () => {
    for (const section of profile.sections) {
      for (const id of section.itemIds) {
        expect(profile.items[id], `${section.id} → ${id}`).toBeTruthy()
      }
    }
  })

  it(`${label}：每个岗位引用的 section / item 都存在`, () => {
    expect(positions.length, `${dataDir}/positions/ 不该是空的`).toBeGreaterThan(0)
    for (const { id, position } of positions) {
      for (const sec of position.sections) {
        expect(
          profile.sections.find((s) => s.id === sec.ref),
          `${id} → ${sec.ref}`,
        ).toBeTruthy()
        for (const item of sec.items) {
          expect(profile.items[item.ref], `${id} → ${item.ref}`).toBeTruthy()
        }
      }
      // pendingItems 也不该悬空
      for (const ref of position.pendingItems) {
        expect(profile.items[ref], `${id} pending → ${ref}`).toBeTruthy()
      }
    }
  })

  it(`${label}：每个岗位都能解析并产出唯一 id 的 block`, () => {
    for (const { id, position } of positions) {
      const tpl = template
      const resume = resolveResume({ profile, position, template: tpl })
      const blocks = buildBlocks({ resume, aliases: profile.basics.aliases })
      expect(blocks.length, id).toBeGreaterThan(0)
      const ids = blocks.map((b) => b.id)
      expect(new Set(ids).size, `${id} 的 block id 应唯一`).toBe(ids.length)
    }
  })
}

describe('data.sample/ 结构体检', () => {
  shapeCheck('data.sample', 'data.sample')
})

// 使用者还没建 data/（刚 clone）时没有可体检的数据，就不建这个 suite
if (existsSync(path.join(ROOT, 'data/profile.json'))) {
  describe('data/ 结构体检', () => {
    shapeCheck('data', 'data')
  })
}

