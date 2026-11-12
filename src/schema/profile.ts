import { z } from 'zod'

/**
 * 内容池 schema —— data/profile.json
 *
 * 这里只放 **shared** 字段：客观事实，所有岗位共用一份，改一处全局生效。
 * 叙述性/取舍性的内容（论文的一句话展开、条目可见性、顺序）属于 position-local，
 * 定义在 ./position.ts。见 docs/DESIGN.md §3.2。
 *
 * **schema 不校验"必填"。** 职责划分：
 *   - schema 管**结构完整性**：字段存不存在、类型对不对、id 稳不稳定
 *   - REQUIRED_FIELDS + 编辑器红角标管**内容完整性**
 * 原因很实际：新建的条目一定是空的，简历也不是一次性写完的。若 schema 强制
 * 非空，用户点一下"新增论文"就会写出一个自己 parse 不了的 profile.json，
 * 下次启动直接打不开。内容不全是正常中间状态，不是数据损坏。
 */

export const SCHEMA_VERSION = 1

/** 稳定 id。永远不要重排或重新生成——覆盖层、pendingItems、差异视图全靠它。 */
const Id = z.string().min(1)

export const ContactType = z.enum([
  'phone',
  'email',
  'github',
  'homepage',
  'wechat',
  'linkedin',
  'location',
  'other',
])
export type ContactType = z.infer<typeof ContactType>

/** 联系方式类型的中文名，编辑器下拉框用 */
export const CONTACT_TYPE_LABEL: Record<ContactType, string> = {
  phone: '手机号',
  email: '邮箱',
  github: 'GitHub',
  homepage: '个人主页',
  wechat: '微信',
  linkedin: 'LinkedIn',
  location: '城市',
  other: '其他',
}

export const Contact = z.object({
  id: Id,
  type: ContactType,
  value: z.string(),
  /** 显示文案与实际链接不同时用（如显示 handle，链接到 github.com/handle） */
  url: z.string().optional(),
  /** 标记为敏感：岗位设为「可公开」时，校验器会对这些字段告警 */
  sensitive: z.boolean().default(false),
})
export type Contact = z.infer<typeof Contact>

export const Basics = z.object({
  name: z.string().default(''),
  /**
   * 英文名。**不渲染进简历**，只用于在论文作者列表里把自己的名字标出来
   * （下划线）。论文作者列表里写的是英文名，而简历抬头写的是中文名，
   * 光靠 `name` 匹配不上，所以单开一个槽。
   */
  nameEn: z.string().default(''),
  /**
   * 论文作者列表里需要标记出来的名字，中英文写法都可以列。
   * 与 `name` / `nameEn` 一起构成「自己名字」的候选集合。
   */
  aliases: z.array(z.string()).default([]),
  /** 头像路径。版式尚未实现（见 docs/DESIGN.md §12），字段先留着。 */
  photo: z.string().default(''),
  contacts: z.array(Contact).default([]),
})
export type Basics = z.infer<typeof Basics>

/** 要点。id 稳定，因为岗位层通过 id 勾选要展示哪几条。 */
export const Bullet = z.object({
  id: Id,
  text: z.string(),
})
export type Bullet = z.infer<typeof Bullet>

const ItemBase = { id: Id }

export const EducationItem = z.object({
  ...ItemBase,
  kind: z.literal('education'),
  // 必填
  school: z.string().default(''),
  degree: z.string().default(''),
  start: z.string().default(''),
  end: z.string().default(''),
  // 选填
  major: z.string().default(''),
  gpa: z.string().default(''),
})

/**
 * 论文条目。注意这里 **没有** pitch / extraBullets ——
 * 一句话展开是岗位 specific 的，存在 position.json 里。
 */
export const PublicationItem = z.object({
  ...ItemBase,
  kind: z.literal('publication'),
  // 必填
  title: z.string().default(''),
  venue: z.string().default(''),
  // 选填
  venueShort: z.string().default(''),
  authors: z.array(z.string()).default([]),
  /**
   * 外部链接的 URL 列表。渲染成会议名后的链接图标，电子版可点。
   * 不带标签：标签要么冗余（会议名已经写了 arXiv），要么需要额外维护。
   */
  links: z.array(z.string()).default([]),
  bullets: z.array(Bullet).default([]),
})

export const ProjectItem = z.object({
  ...ItemBase,
  kind: z.literal('project'),
  // 必填
  name: z.string().default(''),
  // 选填
  role: z.string().default(''),
  start: z.string().default(''),
  end: z.string().default(''),
  summary: z.string().default(''),
  bullets: z.array(Bullet).default([]),
})

export const ExperienceItem = z.object({
  ...ItemBase,
  kind: z.literal('experience'),
  // 必填
  company: z.string().default(''),
  start: z.string().default(''),
  end: z.string().default(''),
  // 选填
  department: z.string().default(''),
  /**
   * 团队 / 项目组名称，如「某某实验室」。
   * 与 department 分开：department 是组织架构上的部门，team 是实际所在的
   * 团队或产品线，两者可能都要写。渲染时按 公司·部门·团队 的包含顺序拼接。
   */
  team: z.string().default(''),
  role: z.string().default(''),
  summary: z.string().default(''),
  bullets: z.array(Bullet).default([]),
})

/** 奖项是单行内容，没有子要点 —— 故意不给 bullets */
export const AwardItem = z.object({
  ...ItemBase,
  kind: z.literal('award'),
  name: z.string().default(''),
  date: z.string().default(''),
  level: z.string().default(''),
  issuer: z.string().default(''),
})

export const CustomItem = z.object({
  ...ItemBase,
  kind: z.literal('custom'),
  title: z.string().default(''),
  subtitle: z.string().default(''),
  dateRight: z.string().default(''),
  summary: z.string().default(''),
  bullets: z.array(Bullet).default([]),
})

export const Item = z.discriminatedUnion('kind', [
  EducationItem,
  PublicationItem,
  ProjectItem,
  ExperienceItem,
  AwardItem,
  CustomItem,
])
export type Item = z.infer<typeof Item>
export type ItemKind = Item['kind']

export const SectionKind = z.enum([
  'education',
  'publication',
  'project',
  'experience',
  'award',
  'custom',
])
export type SectionKind = z.infer<typeof SectionKind>

export const Section = z.object({
  id: Id,
  kind: SectionKind,
  title: z.string().min(1),
  /** iconify 名称，如 fa6-solid:graduation-cap；空字符串表示不显示图标 */
  icon: z.string().default(''),
  itemIds: z.array(Id).default([]),
})
export type Section = z.infer<typeof Section>

export const Profile = z.object({
  schemaVersion: z.number().int().positive(),
  basics: Basics,
  sections: z.array(Section).default([]),
  /** 扁平 map，key === value.id */
  items: z.record(Id, Item).default({}),
})
export type Profile = z.infer<typeof Profile>

/** 各 kind 的必填字段，供编辑器区分必填/选填与校验面板使用 */
export const REQUIRED_FIELDS: Record<ItemKind, readonly string[]> = {
  education: ['school', 'degree', 'start', 'end'],
  publication: ['title', 'venue'],
  project: ['name'],
  experience: ['company', 'start', 'end'],
  award: ['name'],
  custom: ['title'],
}

/** 各 kind 在编辑器里的字段顺序（必填在前，其余折叠进「更多选填字段」） */
export const FIELD_ORDER: Record<ItemKind, readonly string[]> = {
  education: ['school', 'degree', 'start', 'end', 'major', 'gpa'],
  publication: ['title', 'venue', 'venueShort', 'authors'],  // links 有专门的子编辑器，不走通用字段表
  project: ['name', 'start', 'end', 'role', 'summary'],
  experience: ['company', 'start', 'end', 'department', 'team', 'role', 'summary'],
  award: ['name', 'date', 'level', 'issuer'],
  custom: ['title', 'subtitle', 'dateRight', 'summary'],
}

/** 新建条目时的中文名，用于按钮文案与提示 */
export const KIND_LABEL: Record<ItemKind, string> = {
  education: '教育经历',
  publication: '论文',
  project: '项目',
  experience: '实习经历',
  award: '奖项',
  custom: '自定义条目',
}

/**
 * 生成一个空白条目。
 *
 * 全部字段都给出显式默认值，而不是依赖 zod 的 default 填充 —— 这样写进
 * profile.json 的对象是完整的，git diff 里能直接看出这个条目有哪些字段。
 */
export function createEmptyItem(kind: ItemKind, id: string): Item {
  const base = { id, bullets: [] as Bullet[] }
  switch (kind) {
    case 'education':
      return { id, kind, school: '', degree: '', start: '', end: '', major: '', gpa: '' }
    case 'publication':
      return { ...base, kind, title: '', venue: '', venueShort: '', authors: [], links: [] }
    case 'project':
      return { ...base, kind, name: '', role: '', start: '', end: '', summary: '' }
    case 'experience':
      return { ...base, kind, company: '', start: '', end: '', department: '', team: '', role: '', summary: '' }
    case 'award':
      return { id, kind, name: '', date: '', level: '', issuer: '' }
    case 'custom':
      return { ...base, kind, title: '', subtitle: '', dateRight: '', summary: '' }
  }
}

/**
 * 生成一个不与现有条目冲突的 id。
 *
 * 前缀带上 kind，让 profile.json 与 git diff 可读（`itm_pub_x7k2` 一眼看出是论文）。
 * 随机后缀而不是自增序号：条目会被删除，序号复用会让历史里的 id 指向新东西。
 */
export function nextItemId(kind: ItemKind, taken: Iterable<string>): string {
  const prefix = `itm_${kind.slice(0, 3)}_`
  const used = new Set(taken)
  for (let i = 0; i < 100; i++) {
    const id = prefix + Math.random().toString(36).slice(2, 7)
    if (!used.has(id)) return id
  }
  // 理论上到不了这里；兜底用时间戳保证唯一
  return prefix + Date.now().toString(36)
}

/**
 * 生成一个不与现有联系方式冲突的 id。
 *
 * 前缀带类型（`c_homepage_xxx`），让 profile.json 与 git diff 一眼看得出
 * 这是哪一条联系方式。
 */
export function nextContactId(type: ContactType, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let i = 0; i < 100; i++) {
    const id = `c_${type}_${Math.random().toString(36).slice(2, 6)}`
    if (!used.has(id)) return id
  }
  return `c_${type}_${Date.now().toString(36)}`
}

export function emptyProfile(name = '我的名字'): Profile {
  return Profile.parse({
    schemaVersion: SCHEMA_VERSION,
    basics: { name, nameEn: '', aliases: [], contacts: [] },
    sections: [],
    items: {},
  })
}
