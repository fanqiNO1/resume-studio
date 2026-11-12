/**
 * 行内标记渲染器。
 *
 * 用 render function 而不是 <template>：Vue 模板的 whitespace: 'condense'
 * 会在元素之间增删空白，而这里每一个空格都影响排版。h() 能精确控制子节点，
 * 不产生任何意外的文本节点。
 *
 * 中英自动间距在这里插入：带 margin 的 <span class="as"/> 而非真实空格字符，
 * 视觉正确且复制出来不多空格。跨节点边界（「使用 **CUDA** 算子」里 `使用`
 * 与 `CUDA` 分属不同节点）也要处理。
 */
import { defineComponent, h, type VNode } from 'vue'
import { parseInline, type InlineNode } from '@/render/inline'
import { firstChar, gapBetween, lastChar, splitForAutoSpace } from '@/render/autospace'
import { LINK_ICON_MARK } from '@/render/blocks'
import { ICONS } from './icons'

const GAP = () => h('span', { class: 'as' })

function renderNodes(nodes: InlineNode[], autoSpace: boolean): VNode[] {
  const out: VNode[] = []

  nodes.forEach((node, i) => {
    // 跨节点边界的间距
    if (autoSpace && i > 0) {
      const left = lastChar([nodes[i - 1]])
      const right = firstChar([node])
      if (gapBetween(left, right)) out.push(GAP())
    }

    switch (node.type) {
      case 'text': {
        if (!autoSpace) {
          out.push(h('span', node.value))
          break
        }
        for (const seg of splitForAutoSpace(node.value)) {
          if (seg.gapBefore) out.push(GAP())
          out.push(h('span', seg.text))
        }
        break
      }
      case 'code':
        out.push(h('code', { class: 'rs-code' }, node.value))
        break
      case 'strong':
        out.push(h('strong', renderNodes(node.children, autoSpace)))
        break
      case 'highlight':
        out.push(h('span', { class: 'rs-hl' }, renderNodes(node.children, autoSpace)))
        break
      case 'underline':
        out.push(h('u', renderNodes(node.children, autoSpace)))
        break
      case 'em':
        out.push(h('em', renderNodes(node.children, autoSpace)))
        break
      case 'link': {
        // 链接文本是占位符时，渲染成链接图标（论文的 [⧉](url)）
        const isIcon =
          node.children.length === 1 &&
          node.children[0].type === 'text' &&
          node.children[0].value === LINK_ICON_MARK
        const icon = ICONS.link
        out.push(
          h(
            'a',
            { href: node.href, class: 'rs-link' },
            isIcon && icon
              ? [
                  h(
                    'svg',
                    {
                      class: 'rs-link-icon',
                      viewBox: icon.viewBox,
                      xmlns: 'http://www.w3.org/2000/svg',
                      'aria-hidden': 'true',
                      focusable: 'false',
                    },
                    [h('path', { d: icon.d, fill: 'currentColor' })],
                  ),
                ]
              : renderNodes(node.children, autoSpace),
          ),
        )
        break
      }
    }
  })

  return out
}

export default defineComponent({
  name: 'InlineText',
  props: {
    text: { type: String, default: '' },
    autoSpace: { type: Boolean, default: true },
  },
  setup(props) {
    return () => renderNodes(parseInline(props.text), props.autoSpace)
  },
})

export { renderNodes }
export type { InlineNode }
