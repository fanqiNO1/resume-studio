/**
 * resolve：内容池 + 岗位覆盖层 → 可渲染的中间表示。
 *
 * 这是 shared / position-local 两级字段合流的唯一地方。见 docs/DESIGN.md §3.2。
 * 预览与 PDF 导出必须走同一个 resolve()——任何分叉都会导致两者不一致。
 */

import type {
  Contact,
  Item,
  Position,
  PositionItem,
  Profile,
  PublicationRender,
  Template,
} from '@/schema'
import { DENSITY, type Density } from '@/schema'

/** 解析后的条目：池里的 shared 字段（含 overrides）+ 岗位层的 local 字段 */
export interface ResolvedItem {
  /** 已应用 overrides 的条目数据 */
  item: Item
  /** 本岗位实际要展示的要点（已按 bulletInclude 过滤） */
  bullets: { id: string; text: string }[]
  /** 论文的一句话展开，position-local */
  pitch: string
  /** 论文的岗位专属补充要点，position-local */
  extraBullets: { id: string; text: string }[]
  /** 论文渲染档（已回落到模板默认值） */
  render: PublicationRender
  detail: 'titleOnly' | 'summary' | 'full'
  spacingAfter: number
  /** 哪些字段被 overrides 改过，供编辑器显示徽标 */
  overriddenFields: string[]
}

export interface ResolvedSection {
  id: string
  kind: string
  title: string
  icon: string
  items: ResolvedItem[]
}

export interface ResolvedResume {
  name: string
  contacts: Contact[]
  sections: ResolvedSection[]
  template: Template
  density: Density
  /** 密度档乘算后的最终排版数值，直接喂给 CSS 变量 */
  metrics: ResolvedMetrics
  layout: Position['layout']
  public: boolean
}

export interface ResolvedMetrics {
  /** mm */
  margin: { top: number; right: number; bottom: number; left: number }
  /** pt */
  baseSize: number
  baseLineHeight: number
  scale: Template['scale']
  spacing: Template['spacing']
}

/**
 * 应用密度档与 autofit 缩放。
 *
 * 字号、行高、间距用不同乘子：压缩时间距应该比字号降得更快
 * （字号缩小伤可读性，间距缩小只是变紧），所以 space 乘子比 size 激进。
 *
 * fitScale 是「压到 N 页」搜出来的额外等比系数，同样对字号温和、对间距激进。
 */
export function applyDensity(
  template: Template,
  density: Density,
  fitScale = 1,
): ResolvedMetrics {
  const f = DENSITY[density] ?? DENSITY.standard
  // fitScale 对间距的作用放大一倍：先挤间距，尽量少动字号
  const sizeFactor = f.size * fitScale
  const spaceFactor = f.space * (1 - (1 - fitScale) * 2)
  const s = (v: number) => round(v * sizeFactor)
  const sp = (v: number) => round(v * Math.max(0.3, spaceFactor))

  return {
    margin: { ...template.page.margin },
    baseSize: s(template.font.baseSize),
    baseLineHeight: round(template.font.baseLineHeight * f.line * fitScale),
    scale: {
      name: s(template.scale.name),
      contact: s(template.scale.contact),
      sectionTitle: s(template.scale.sectionTitle),
      entryTitle: s(template.scale.entryTitle),
      dateRight: s(template.scale.dateRight),
      body: s(template.scale.body),
      small: s(template.scale.small),
    },
    spacing: {
      nameBelow: sp(template.spacing.nameBelow),
      headerBelow: sp(template.spacing.headerBelow),
      sectionAbove: sp(template.spacing.sectionAbove),
      sectionBelow: sp(template.spacing.sectionBelow),
      entryAbove: sp(template.spacing.entryAbove),
      entryBelow: sp(template.spacing.entryBelow),
      listTop: sp(template.spacing.listTop),
      listItemGap: sp(template.spacing.listItemGap),
      // 缩进与符号位置跟字号走，不跟间距走：缩进过小会破坏列表层级的可辨识度
      listIndent: s(template.spacing.listIndent),
      listMarkerLeft: s(template.spacing.listMarkerLeft),
      paragraphGap: sp(template.spacing.paragraphGap),
      // 横线与标题的距离跟字号走：它是标题排版的一部分，不是段间距
      ruleBelowTitle: s(template.spacing.ruleBelowTitle),
    },
  }
}

/** 保留两位小数，避免浮点尾数污染 CSS 与 diff */
function round(v: number): number {
  return Math.round(v * 100) / 100
}

/** 把 overrides 应用到池里的条目上，返回新对象（不改动原数据） */
function applyOverrides(item: Item, overrides: PositionItem['overrides']): {
  item: Item
  overriddenFields: string[]
} {
  const keys = Object.keys(overrides)
  if (keys.length === 0) return { item, overriddenFields: [] }

  const merged = { ...item } as Record<string, unknown>
  const applied: string[] = []
  for (const key of keys) {
    // 只允许覆盖池里已存在的字段；未知 key 忽略（可能是 schema 迁移残留）
    if (!(key in merged)) continue
    merged[key] = overrides[key]
    applied.push(key)
  }
  return { item: merged as Item, overriddenFields: applied }
}

export interface ResolveInput {
  profile: Profile
  position: Position
  template: Template
  /** 岗位专属条目（data/positions/<id>/local-items.json） */
  localItems?: Record<string, Item>
}

export function resolveResume(input: ResolveInput): ResolvedResume {
  const { profile, position, template, localItems = {} } = input
  const lookupItem = (id: string): Item | undefined => profile.items[id] ?? localItems[id]

  const contacts = position.contactInclude
    .map((id) => profile.basics.contacts.find((c) => c.id === id))
    .filter((c): c is Contact => Boolean(c))

  const sections: ResolvedSection[] = []
  for (const ps of position.sections) {
    if (!ps.visible) continue
    const source = profile.sections.find((s) => s.id === ps.ref)
    if (!source) continue

    const items: ResolvedItem[] = []
    for (const pi of ps.items) {
      if (!pi.visible) continue
      const raw = lookupItem(pi.ref)
      if (!raw) continue

      const { item, overriddenFields } = applyOverrides(raw, pi.overrides)
      const poolBullets = 'bullets' in item ? item.bullets : []
      const bullets =
        pi.bulletInclude === null
          ? poolBullets
          : pi.bulletInclude
              .map((bid) => poolBullets.find((b) => b.id === bid))
              .filter((b): b is { id: string; text: string } => Boolean(b))

      items.push({
        item,
        bullets,
        pitch: pi.pitch,
        extraBullets: pi.extraBullets,
        render: pi.render ?? template.publicationRender,
        detail: pi.detail,
        spacingAfter: pi.spacingAfter,
        overriddenFields,
      })
    }

    if (items.length === 0) continue
    sections.push({
      id: source.id,
      kind: source.kind,
      title: ps.titleOverride || source.title,
      icon: source.icon,
      items,
    })
  }

  return {
    name: profile.basics.name,
    contacts,
    sections,
    template,
    density: position.density,
    metrics: applyDensity(template, position.density, position.fitScale),
    layout: position.layout,
    public: position.meta.public,
  }
}
