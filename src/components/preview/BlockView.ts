/**
 * Block 渲染器。
 *
 * 同样用 render function：每个 block 的外层元素必须带 data-block-id
 * （测量、点预览定位、check:fidelity 都靠它），且不能有多余包装层——
 * 多一层 div 就可能改变 margin 折叠行为，进而改变实测高度。
 */
import { defineComponent, h, type PropType, type VNode } from 'vue'
import type { Block } from '@/render/blocks'
import InlineText from './InlineText'
import { ICONS } from './icons'

function inline(text: string): VNode {
  return h(InlineText, { text })
}

const CONTACT_ICON: Record<string, string> = {
  phone: 'phone',
  email: 'envelope',
  github: 'github',
  homepage: 'link',
  wechat: 'comment',
  linkedin: 'linkedin',
  location: 'location-dot',
  other: 'circle-info',
}

function icon(name: string): VNode | null {
  const path = ICONS[name]
  if (!path) return null
  return h(
    'svg',
    {
      // 联系方式与小节标题的图标靠上下文选择器区分颜色（见 resume.css）
      class: 'rs-icon',
      viewBox: path.viewBox,
      xmlns: 'http://www.w3.org/2000/svg',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    [h('path', { d: path.d, fill: 'currentColor' })],
  )
}

function renderBlockBody(block: Block): VNode[] {
  switch (block.kind) {
    case 'header': {
      const contactNodes: VNode[] = []
      block.contacts.forEach((c, i) => {
        if (i > 0) contactNodes.push(h('span', { class: 'rs-sep' }, '·'))
        const ic = icon(CONTACT_ICON[c.type] ?? 'circle-info')
        const label = c.url
          ? h('a', { href: c.url, class: 'rs-link' }, c.value)
          : h('span', c.value)
        contactNodes.push(h('span', { class: 'rs-contact' }, [ic, label].filter(Boolean) as VNode[]))
      })
      return [
        h('div', { class: 'rs-name' }, block.name),
        h('div', { class: 'rs-contacts' }, contactNodes),
      ]
    }

    case 'sectionTitle': {
      const ic = icon(block.icon)
      return [
        h('div', { class: 'rs-section-inner' }, [ic, h('span', block.title)].filter(Boolean) as VNode[]),
      ]
    }

    case 'entryHeader':
      return [
        h('span', { class: 'rs-entry-left' }, [inline(block.left)]),
        h('span', { class: 'rs-entry-right' }, [inline(block.right)]),
      ]

    case 'paragraph':
      return [inline(block.text)]

    case 'bullet':
      return [h('span', { class: 'rs-bullet-mark' }), h('span', { class: 'rs-bullet-body' }, [inline(block.text)])]

    case 'pubTight':
      return [
        h('span', { class: 'rs-entry-left' }, [inline(`**${block.title}**`)]),
        h('span', { class: 'rs-entry-right' }, [inline(block.venueShort)]),
      ]

    case 'pubTitle':
      return [inline(`**${block.title}**`)]
  }
}

/** 每个 block 的根元素 class，样式定义在 resume.css */
const BLOCK_CLASS: Record<Block['kind'], string> = {
  header: 'rs-header',
  sectionTitle: 'rs-section',
  entryHeader: 'rs-entry-line',
  paragraph: 'rs-para',
  bullet: 'rs-bullet',
  // tight 档复用条目标题行的两端对齐布局
  pubTight: 'rs-entry-line',
  pubTitle: 'rs-pub-title',
}

/** paragraph 的变体 class，决定字号与字形 */
const PARAGRAPH_VARIANT_CLASS: Record<string, string> = {
  body: '',
  venue: 'rs-venue',
  authors: 'rs-authors',
}

export default defineComponent({
  name: 'BlockView',
  props: {
    block: { type: Object as PropType<Block>, required: true },
    /** 页首的块不施加上间距（对齐 LaTeX 在页首吞掉 \vspace 的行为） */
    atPageTop: { type: Boolean, default: false },
    /** 高亮（编辑器联动） */
    active: { type: Boolean, default: false },
  },
  setup(props) {
    return () => {
      const b = props.block
      return h(
        'div',
        {
          'data-block-id': b.id,
          'data-item-id': b.itemId || undefined,
          class: [
            BLOCK_CLASS[b.kind],
            b.kind === 'paragraph' ? PARAGRAPH_VARIANT_CLASS[b.variant] : '',
            props.active ? 'rs-active' : '',
          ],
          style: {
            marginTop: props.atPageTop ? '0' : `${b.spaceAbove}pt`,
            marginBottom: `${b.spaceBelow}pt`,
          },
        },
        renderBlockBody(b),
      )
    }
  },
})
