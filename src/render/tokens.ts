/**
 * 模板参数 → CSS 自定义属性。
 *
 * 排版数值只有这一条路径进入样式，保证预览与导出用的是同一组值。
 * 全部输出 pt（页边距用 mm，因为 @page 与 A4 的自然单位是 mm）。
 */

import type { Template } from '@/schema'
import type { ResolvedMetrics } from '@/render/resolve'

export interface StyleVars {
  vars: Record<string, string>
  /** 挂在 .resume-root 上的 data-* 属性，供 CSS 按模板变体分支 */
  attrs: Record<string, string>
}

export function buildStyleVars(metrics: ResolvedMetrics, template: Template): StyleVars {
  const { margin, scale, spacing } = metrics
  const fontStack = (list: string[]) =>
    list
      .map((f) => (/[^a-zA-Z0-9-]/.test(f) ? `'${f}'` : f))
      .concat(['sans-serif'])
      .join(', ')

  return {
    vars: {
      '--rs-margin-top': `${margin.top}mm`,
      '--rs-margin-right': `${margin.right}mm`,
      '--rs-margin-bottom': `${margin.bottom}mm`,
      '--rs-margin-left': `${margin.left}mm`,

      '--rs-font-body': fontStack(template.font.body),
      '--rs-font-mono': fontStack(template.font.mono),

      '--rs-size-body': `${scale.body}pt`,
      '--rs-size-name': `${scale.name}pt`,
      '--rs-size-contact': `${scale.contact}pt`,
      '--rs-size-section': `${scale.sectionTitle}pt`,
      '--rs-size-entry': `${scale.entryTitle}pt`,
      '--rs-size-date': `${scale.dateRight}pt`,
      '--rs-size-small': `${scale.small}pt`,

      // 绝对行高：避免倍数行高在不同字号下产生不一致的行盒
      '--rs-line': `${metrics.baseLineHeight}pt`,
      '--rs-list-indent': `${spacing.listIndent}pt`,
      '--rs-list-marker-left': `${spacing.listMarkerLeft}pt`,
      '--rs-name-gap': `${spacing.nameBelow}pt`,
      '--rs-rule-gap': `${spacing.ruleBelowTitle}pt`,
      '--rs-para-gap': `${spacing.paragraphGap}pt`,

      // Termes 的词间空格约 0.25em；\dotSep 用两个词间空格，故 pad 为 0.5em
      '--rs-word-space': '0.25em',
      '--rs-dotsep-pad': '0.5em',

      '--rs-accent': template.color.accent,
      '--rs-fg': template.color.fg,
      '--rs-muted': template.color.muted,
      '--rs-rule': template.color.rule,

      '--rs-align': template.text.align,
      '--rs-punct-trim': template.text.punctuationTrim ? 'space-first' : 'normal',
    },
    attrs: {
      'data-section-style': template.sectionTitleStyle,
      'data-header': template.headerStyle,
      'data-auto-space': template.text.autoSpaceCJKLatin ? 'on' : 'off',
    },
  }
}

/** 转成可直接绑到 :style 的对象 */
export function toStyleObject(vars: Record<string, string>): Record<string, string> {
  return vars
}
