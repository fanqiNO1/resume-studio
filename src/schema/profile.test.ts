import { describe, expect, it } from 'vitest'
import {
  Item,
  Profile,
  createEmptyItem,
  nextItemId,
  REQUIRED_FIELDS,
  FIELD_ORDER,
  KIND_LABEL,
  type ItemKind,
} from '@/schema'

const KINDS: ItemKind[] = [
  'education',
  'publication',
  'project',
  'experience',
  'award',
  'custom',
]

describe('createEmptyItem', () => {
  it('每种 kind 都能通过 schema 校验', () => {
    // 这是新增条目功能的地基：空条目必须是合法数据，否则用户点一下「新增」
    // 就会写出一个自己 parse 不了的 profile.json，下次启动直接打不开。
    for (const kind of KINDS) {
      const item = createEmptyItem(kind, `itm_test_${kind}`)
      expect(() => Item.parse(item), kind).not.toThrow()
      expect(item.kind).toBe(kind)
      expect(item.id).toBe(`itm_test_${kind}`)
    }
  })

  it('含空条目的 profile 仍能整体解析', () => {
    const profile = Profile.parse({
      schemaVersion: 1,
      basics: { name: '', contacts: [] },
      sections: [{ id: 'sec_x', kind: 'experience', title: '实习经历', itemIds: ['itm_a'] }],
      items: { itm_a: createEmptyItem('experience', 'itm_a') },
    })
    expect(profile.items.itm_a.kind).toBe('experience')
  })

  it('把 FIELD_ORDER 里列出的字段都建出来', () => {
    // 漏字段会让编辑器显示不出该输入框，用户根本无从填写
    for (const kind of KINDS) {
      const item = createEmptyItem(kind, 'x') as unknown as Record<string, unknown>
      for (const field of FIELD_ORDER[kind]) {
        expect(field in item, `${kind}.${field} 缺失`).toBe(true)
      }
    }
  })

  it('新建的条目在编辑器里会被标为「缺必填」', () => {
    for (const kind of KINDS) {
      const item = createEmptyItem(kind, 'x') as unknown as Record<string, unknown>
      const missing = REQUIRED_FIELDS[kind].filter((f) => !String(item[f] ?? '').trim())
      // schema 放行空值，但 UI 必须提示 —— 两者职责不同
      expect(missing.length, kind).toBe(REQUIRED_FIELDS[kind].length)
    }
  })

  it('每种 kind 都有中文名可显示', () => {
    for (const kind of KINDS) {
      expect(KIND_LABEL[kind]).toBeTruthy()
    }
  })
})

describe('nextItemId', () => {
  it('不与已有 id 冲突', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const id = nextItemId('publication', taken)
      expect(taken.has(id)).toBe(false)
      taken.add(id)
    }
  })

  it('前缀带 kind，便于阅读 profile.json 与 git diff', () => {
    expect(nextItemId('publication', [])).toMatch(/^itm_pub_/)
    expect(nextItemId('experience', [])).toMatch(/^itm_exp_/)
    expect(nextItemId('education', [])).toMatch(/^itm_edu_/)
  })

  it('生成的 id 可用作 schema 的 Id（非空）', () => {
    const id = nextItemId('project', [])
    expect(() => Item.parse(createEmptyItem('project', id))).not.toThrow()
  })
})

describe('experience.team', () => {
  it('是独立字段，且默认为空', () => {
    const item = createEmptyItem('experience', 'x')
    expect(item).toHaveProperty('team', '')
    expect(item).toHaveProperty('department', '')
  })

  it('出现在编辑器字段顺序里，排在 department 之后（组织包含顺序）', () => {
    const order = FIELD_ORDER.experience
    expect(order).toContain('team')
    expect(order.indexOf('department')).toBeLessThan(order.indexOf('team'))
  })
})
