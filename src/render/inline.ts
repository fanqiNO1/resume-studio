/**
 * 行内标记解析器。
 *
 * 刻意手写而不引 Markdown 库：语法只有 6 条规则，而输出 DOM 的形状直接影响
 * 像素级排版（多一层 wrapper 就可能改变行盒高度）。手写能精确控制。
 *
 *   **粗**      → strong
 *   ==强调==    → 主色加粗（对应 LaTeX \texthl）
 *   `代码`      → 等宽
 *   _下划线_    → u
 *   *斜体*      → em
 *   [文本](url) → 链接
 *   \x          → 转义，输出字面量 x
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'highlight'; children: InlineNode[] }
  | { type: 'code'; value: string }
  | { type: 'underline'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }

interface Delimiter {
  open: string
  close: string
  /**
   * 要求分隔符处于「词边界」：前后不能紧贴字母数字。
   * `_` 必须开启这个，否则 `torch_dtype`、`snake_case` 会被当成下划线标记 ——
   * 技术简历里这类标识符很常见。
   */
  wordBoundary?: boolean
  make: (children: InlineNode[]) => InlineNode
}

/** 顺序有意义：长标记必须先于短标记尝试（** 先于 *，== 先于 =） */
const DELIMITERS: Delimiter[] = [
  { open: '**', close: '**', make: (c) => ({ type: 'strong', children: c }) },
  { open: '==', close: '==', make: (c) => ({ type: 'highlight', children: c }) },
  { open: '_', close: '_', wordBoundary: true, make: (c) => ({ type: 'underline', children: c }) },
  { open: '*', close: '*', make: (c) => ({ type: 'em', children: c }) },
]

const ALNUM = /[A-Za-z0-9]/
const SPACE = /\s/

export function parseInline(src: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let buf = ''
  let i = 0

  const flush = () => {
    if (buf) {
      nodes.push({ type: 'text', value: buf })
      buf = ''
    }
  }

  outer: while (i < src.length) {
    const ch = src[i]

    // 转义
    if (ch === '\\' && i + 1 < src.length) {
      buf += src[i + 1]
      i += 2
      continue
    }

    // 等宽：内容不再递归解析
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        nodes.push({ type: 'code', value: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // 链接 [text](url)
    if (ch === '[') {
      const close = src.indexOf(']', i + 1)
      if (close > i && src[close + 1] === '(') {
        const parenEnd = src.indexOf(')', close + 2)
        if (parenEnd > close) {
          flush()
          nodes.push({
            type: 'link',
            href: src.slice(close + 2, parenEnd),
            children: parseInline(src.slice(i + 1, close)),
          })
          i = parenEnd + 1
          continue
        }
      }
    }

    for (const d of DELIMITERS) {
      if (!src.startsWith(d.open, i)) continue
      const contentStart = i + d.open.length

      // 开标记后紧跟空白 → 不是标记。否则「a * b * c」会被吞成「a  b  c」
      if (SPACE.test(src[contentStart] ?? ' ')) continue
      // 词边界要求：开标记前一个字符不能是字母数字
      if (d.wordBoundary && ALNUM.test(src[i - 1] ?? '')) continue

      const end = findClose(src, contentStart, d.close, d.wordBoundary === true)
      // end === contentStart 表示空内容（如 ****），按字面量处理
      if (end > contentStart) {
        flush()
        nodes.push(d.make(parseInline(src.slice(contentStart, end))))
        i = end + d.close.length
        continue outer
      }
    }

    buf += ch
    i += 1
  }

  flush()
  return nodes
}

/**
 * 找闭合标记。
 *
 * 跳过被转义的字符；要求闭标记前一个字符不是空白（对称于开标记规则）；
 * wordBoundary 时还要求闭标记后一个字符不是字母数字。
 */
function findClose(src: string, from: number, close: string, wordBoundary: boolean): number {
  let i = from
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src.startsWith(close, i)) {
      const prev = src[i - 1] ?? ' '
      const next = src[i + close.length] ?? ''
      const okSpace = !SPACE.test(prev)
      const okWord = !wordBoundary || !ALNUM.test(next)
      if (okSpace && okWord) return i
    }
    i += 1
  }
  return -1
}

/** 提取纯文本，用于校验、搜索、文件名生成 */
export function inlineToPlainText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return n.value
        case 'code':
          return n.value
        default:
          return inlineToPlainText(n.children)
      }
    })
    .join('')
}

export function plainText(src: string): string {
  return inlineToPlainText(parseInline(src))
}
