import { z } from 'zod'

/**
 * 模板 schema —— data/templates/<id>.json
 *
 * 模板是纯表现层参数包，不含任何内容。切换模板只改观感，不动数据。
 * 目前只保留 1 套 academic-serif（对齐 luooofan/resume 的 resume.cls）；
 * 加一套的成本是写一个 JSON，不是改代码。
 */

const Margin = z.object({
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
  /** 目前只支持 mm，留字段是为了将来接受 in/pt */
  unit: z.literal('mm').default('mm'),
})
export type Margin = z.infer<typeof Margin>

export const Template = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  page: z.object({
    /** 目前只支持 A4 */
    size: z.literal('A4').default('A4'),
    margin: Margin,
  }),
  font: z.object({
    /**
     * CSS font-family 栈。第一项必须是自托管的字族（目前只有 'Resume Serif'），
     * 否则远程浏览器可能没有该字体，且 Chromium 只能以 Type3 嵌进 PDF。
     * 新增字族要同时改 scripts/build-fonts.py。
     */
    body: z.array(z.string()).default(['Resume Serif']),
    mono: z.array(z.string()).default(['Resume Serif']),
    /** pt */
    baseSize: z.number(),
    /** pt，绝对行高（不是倍数），避免 em 层层相乘的舍入漂移 */
    baseLineHeight: z.number(),
  }),
  /** 各层级字号，pt */
  scale: z.object({
    name: z.number(),
    contact: z.number(),
    sectionTitle: z.number(),
    entryTitle: z.number(),
    /** 条目行右侧的日期。resume.cls 里它与条目标题同为 \large */
    dateRight: z.number(),
    body: z.number(),
    small: z.number(),
  }),
  color: z.object({
    accent: z.string(),
    fg: z.string(),
    muted: z.string(),
    rule: z.string(),
  }),
  /** 小节标题样式：标题下横线 / 左侧色条 / 无装饰 */
  sectionTitleStyle: z.enum(['rule', 'leftbar', 'plain']).default('rule'),
  /** 页首版式：姓名与联系方式同行 / 姓名居中且联系方式居中另起一行 */
  headerStyle: z.enum(['inline', 'stacked']).default('stacked'),
  /** 条目版式细节，用于表达不同模板的结构差异 */
  entry: z
    .object({
      /**
       * 教育条目：
       *   twoLine —— 「学校 / 学位 …… 日期」一行，专业与 GPA 另起一行（resume.cls 的做法）
       *   merged  —— 专业与 GPA 并入标题行，省一行（单页向）
       */
      educationLayout: z.enum(['twoLine', 'merged']).default('twoLine'),
      /** 教育条目的学校名用主色加粗（对应 resume.cls 的 \texthl） */
      accentSchool: z.boolean().default(true),
      /** 论文作者列表里自己的名字：仅下划线（resume.cls）还是下划线+加粗 */
      selfAuthorBold: z.boolean().default(false),
    })
    .default({}),
  /** 各类垂直间距，pt */
  spacing: z.object({
    /** 姓名基线到联系方式基线之间（resume.cls 的 \name 后 \vspace{1.5ex}） */
    nameBelow: z.number(),
    /** 联系方式到第一个小节标题之间（\basicInfo 后 \vspace{1.5ex} + section 前间距） */
    headerBelow: z.number(),
    sectionAbove: z.number(),
    sectionBelow: z.number(),
    entryAbove: z.number(),
    entryBelow: z.number(),
    listTop: z.number(),
    listItemGap: z.number(),
    /** 要点文字的缩进（resume.cls: 1.25pc = 15pt） */
    listIndent: z.number(),
    /** 要点符号距左边距的距离（resume.cls 实测 5.67pt） */
    listMarkerLeft: z.number(),
    paragraphGap: z.number(),
    /** 小节标题基线到下方横线的距离 */
    ruleBelowTitle: z.number(),
  }),
  /** 该模板下论文的默认渲染档 */
  publicationRender: z.enum(['tight', 'standard', 'expanded']).default('tight'),
  text: z.object({
    align: z.enum(['justify', 'left']).default('justify'),
    /** 中英之间自动插入间距（等价 xeCJK 的行为） */
    autoSpaceCJKLatin: z.boolean().default(true),
    /** CJK 标点挤压 */
    punctuationTrim: z.boolean().default(true),
  }),
  /** 分页规则。见 src/render/paginate.ts */
  breaking: z.object({
    /** 小节标题不得成为页内最后一块 */
    keepSectionTitleWithNext: z.boolean().default(true),
    /** 条目标题行必须与其后第一块内容同页 */
    keepEntryHeaderWithNext: z.boolean().default(true),
  }),
})
export type Template = z.infer<typeof Template>

/** 密度档：叠在模板上的等比乘子。用户选一个词，而不是调十几个滑杆。 */
export interface DensityFactors {
  /** 字号乘子 */
  size: number
  /** 间距乘子 */
  space: number
  /** 行高乘子 */
  line: number
  label: string
  /** 可读性告警文案，空表示无告警 */
  warning: string
}

export const DENSITY: Record<string, DensityFactors> = {
  loose: { size: 1.04, space: 1.25, line: 1.06, label: '宽松', warning: '' },
  standard: { size: 1, space: 1, line: 1, label: '标准', warning: '' },
  compact: { size: 0.965, space: 0.8, line: 0.97, label: '紧凑', warning: '' },
  extreme: {
    size: 0.93,
    space: 0.62,
    line: 0.94,
    label: '极限',
    warning: '字号与间距已接近可读性下限，建议优先隐藏要点而不是继续压缩',
  },
}
