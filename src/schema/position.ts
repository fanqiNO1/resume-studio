import { z } from 'zod'
import { Bullet, SCHEMA_VERSION } from './profile'

/**
 * 岗位覆盖层 schema —— data/positions/<id>/position.json
 *
 * 这里只放 **position-local** 字段：叙述与取舍。见 docs/DESIGN.md §3.2。
 *
 * 关键区分：
 *   - `pitch` / `extraBullets`（论文）—— 池里根本没有这两个字段，所以它们不是
 *     "覆盖"，就是普通的岗位专属输入。岗位 A 和岗位 B 对同一篇论文可以写
 *     完全不同的一句话，互不影响。
 *   - `overrides` —— 覆盖池里 **已存在** 的 shared 字段，编辑器会显示
 *     「已覆盖 / 恢复继承」。用于偶发的措辞调整，不是主要手段。
 */

const Id = z.string().min(1)

/** 项目/实习/教育的展开程度。bullets.include 是真相，这个只是快捷预设。 */
export const DetailLevel = z.enum(['titleOnly', 'summary', 'full'])
export type DetailLevel = z.infer<typeof DetailLevel>

/** 论文渲染档。三档都保留完整作者列表。 */
export const PublicationRender = z.enum(['tight', 'standard', 'expanded'])
export type PublicationRender = z.infer<typeof PublicationRender>

export const PositionItem = z.object({
  /** 指向内容池（或 local-items）里的 item id */
  ref: Id,
  visible: z.boolean().default(true),
  /** 非论文条目的展开档 */
  detail: DetailLevel.default('full'),
  /** 论文条目的渲染档；留空则用模板的 publicationRender */
  render: PublicationRender.optional(),
  /**
   * 要展示哪几条池里的 bullets。
   * null = 全部展示（新增 bullet 时自动包含，这是常态）
   * 数组 = 只展示列出的 id（此时新增 bullet 默认不展示）
   */
  bulletInclude: z.array(Id).nullable().default(null),
  /** 论文的一句话展开。position-local，池里不存。 */
  pitch: z.string().default(''),
  /** 论文的岗位专属补充要点。position-local，池里不存。 */
  extraBullets: z.array(Bullet).default([]),
  /** 覆盖池里的 shared 字段。key 为字段名，值为字符串或字符串数组。 */
  overrides: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  /** 条目后的垂直微调，pt，可负。对应 LaTeX 里手写的 \vspace{-3pt}。 */
  spacingAfter: z.number().default(0),
  /** 给自己看的备注，不渲染进 PDF */
  note: z.string().default(''),
})
export type PositionItem = z.infer<typeof PositionItem>

export const PositionSection = z.object({
  ref: Id,
  visible: z.boolean().default(true),
  /** 覆盖小节标题文案（如「论文成果」→「研究成果」） */
  titleOverride: z.string().default(''),
  items: z.array(PositionItem).default([]),
})
export type PositionSection = z.infer<typeof PositionSection>

export const Density = z.enum(['loose', 'standard', 'compact', 'extreme'])
export type Density = z.infer<typeof Density>

export const PositionMeta = z.object({
  /** 显示名（简称），如「研究岗」。用于 sidebar 与文件名。 */
  name: z.string().min(1),
  /** sidebar 排序权重 */
  order: z.number().default(0),
  /** 目标岗位全称，如「研究岗算法工程师」。仅备注与文件名模板可用。 */
  targetPosition: z.string().default(''),
  note: z.string().default(''),
  /** 可公开版：勾上后校验器会对 sensitive 联系方式告警 */
  public: z.boolean().default(false),
  filenameTemplate: z.string().default('{name}-{positionName}-{phone}'),
  updatedAt: z.string().default(''),
})
export type PositionMeta = z.infer<typeof PositionMeta>

export const PositionLayout = z.object({
  showPhoto: z.boolean().default(false),
  pageNumber: z.boolean().default(false),
  /** 「压到 N 页」的目标 */
  targetPages: z.number().int().positive().default(1),
})

export const Position = z.object({
  schemaVersion: z.number().int().positive(),
  meta: PositionMeta,
  template: z.string().default('academic-serif'),
  density: Density.default('standard'),
  /**
   * 「压到 N 页」搜出来的等比缩放系数，叠在密度档之上。
   * 1 = 不缩放。由 autofit 写入，用户也可以手动清回 1。
   */
  fitScale: z.number().min(0.8).max(1).default(1),
  /** 模板字段级微调。数据结构先留好，UI 见 docs/DESIGN.md §12 TODO。 */
  templateOverrides: z.record(z.string(), z.unknown()).default({}),
  layout: PositionLayout.default({}),
  /** 展示哪些联系方式（按池里的 contact id） */
  contactInclude: z.array(Id).default([]),
  sections: z.array(PositionSection).default([]),
  /** 池里新增、本岗位尚未表态的条目 id */
  pendingItems: z.array(Id).default([]),
})
export type Position = z.infer<typeof Position>

/** 岗位 id 即目录名，不存在 json 里，由服务端扫目录得出 */
export interface PositionEntry {
  id: string
  position: Position
}

export function emptyPosition(name: string): Position {
  return Position.parse({
    schemaVersion: SCHEMA_VERSION,
    meta: { name },
    sections: [],
  })
}
