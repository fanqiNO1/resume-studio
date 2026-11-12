import { describe, expect, it } from 'vitest'
import { parseInline, plainText } from '@/render/inline'
import { splitForAutoSpace, gapBetween } from '@/render/autospace'

describe('parseInline', () => {
  it('解析各种标记', () => {
    expect(parseInline('**粗**')).toEqual([
      { type: 'strong', children: [{ type: 'text', value: '粗' }] },
    ])
    expect(parseInline('==强==')).toEqual([
      { type: 'highlight', children: [{ type: 'text', value: '强' }] },
    ])
    expect(parseInline('`code`')).toEqual([{ type: 'code', value: 'code' }])
    expect(parseInline('_下_')).toEqual([
      { type: 'underline', children: [{ type: 'text', value: '下' }] },
    ])
    expect(parseInline('*斜*')).toEqual([
      { type: 'em', children: [{ type: 'text', value: '斜' }] },
    ])
  })

  it('** 优先于 *（长标记先匹配）', () => {
    expect(parseInline('**x**')[0].type).toBe('strong')
    expect(parseInline('*x*')[0].type).toBe('em')
  })

  it('支持嵌套', () => {
    const nodes = parseInline('**_Sample Person_**')
    expect(nodes[0]).toEqual({
      type: 'strong',
      children: [{ type: 'underline', children: [{ type: 'text', value: 'Sample Person' }] }],
    })
  })

  it('解析链接', () => {
    expect(parseInline('[主页](https://a.b)')).toEqual([
      { type: 'link', href: 'https://a.b', children: [{ type: 'text', value: '主页' }] },
    ])
  })

  it('多个链接并排时互不干扰', () => {
    // 论文的链接标记形如 *会议 2026* [⧉](url) [⧉](url)
    const src = '*会议 2026* [\u29c9](https://a.b) [\u29c9](https://c.d)'
    const links = parseInline(src).filter((n) => n.type === 'link')
    expect(links).toHaveLength(2)
    expect(links.map((l) => ('href' in l ? l.href : ''))).toEqual([
      'https://a.b',
      'https://c.d',
    ])
  })

  it('等宽内容不再递归解析', () => {
    expect(parseInline('`**x**`')).toEqual([{ type: 'code', value: '**x**' }])
  })

  it('转义输出字面量', () => {
    expect(plainText('\\*\\*不是粗\\*\\*')).toBe('**不是粗**')
    expect(plainText('100\\% 覆盖')).toBe('100% 覆盖')
  })

  it('未闭合的标记按字面量处理，不吞掉内容', () => {
    expect(plainText('**未闭合')).toBe('**未闭合')
    expect(plainText('单个 ` 反引号')).toBe('单个 ` 反引号')
  })

  it('分隔符后紧跟空白时不视为标记（否则会吞掉星号）', () => {
    // 这类文本在简历里真实存在：「3 * 4 的矩阵」「a * b」
    expect(plainText('a * b * c')).toBe('a * b * c')
    expect(plainText('吞吐 3 ** 4')).toBe('吞吐 3 ** 4')
  })

  it('下划线要求词边界，不破坏 snake_case 标识符', () => {
    // 技术简历里 torch_dtype、per_device_batch_size 很常见，绝不能被吃成下划线标记
    expect(plainText('torch_dtype 与 per_device_batch_size')).toBe(
      'torch_dtype 与 per_device_batch_size',
    )
    expect(plainText('MAX_SEQ_LEN')).toBe('MAX_SEQ_LEN')
    // 真正的词边界下划线仍然生效
    expect(parseInline('_Sample Person_')[0].type).toBe('underline')
  })

  it('空标记不产生空节点', () => {
    expect(plainText('****')).toBe('****')
  })

  it('plainText 还原全部文字', () => {
    const src = '搭建了 ==Example-LLM== 框架，用 `PyTorch` 实现，见 [论文](https://x.y)'
    expect(plainText(src)).toBe('搭建了 Example-LLM 框架，用 PyTorch 实现，见 论文')
  })
})

describe('autospace', () => {
  it('在中英边界插间距', () => {
    expect(gapBetween('用', 'C')).toBe(true)
    expect(gapBetween('A', '中')).toBe(true)
    expect(gapBetween('中', '文')).toBe(false)
    expect(gapBetween('A', 'B')).toBe(false)
  })

  it('用户已打了空格时不重复插入', () => {
    expect(gapBetween('用', ' ')).toBe(false)
    expect(gapBetween(' ', 'C')).toBe(false)
  })

  it('CJK 标点两侧不插间距（标点自带留白）', () => {
    expect(gapBetween('，', 'A')).toBe(false)
    expect(gapBetween('A', '。')).toBe(false)
    expect(gapBetween('（', 'A')).toBe(false)
  })

  it('切分后拼回原文，不增删字符', () => {
    for (const src of [
      '使用CUDA算子',
      '基于GPT-4的Agent系统',
      '纯中文内容',
      'pure english',
      '',
      'A中A中A',
    ]) {
      expect(splitForAutoSpace(src).map((s) => s.text).join('')).toBe(src)
    }
  })

  it('第一段之前不插间距', () => {
    const segs = splitForAutoSpace('使用CUDA')
    expect(segs[0].gapBefore).toBe(false)
    expect(segs[1].gapBefore).toBe(true)
  })
})
