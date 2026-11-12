/**
 * 应用状态。
 *
 * 数据流：/api/bootstrap 一次性拉全量 → 内存里改 → 防抖写回。
 * 单人单机工具，不做乐观锁/冲突合并；外部改文件时用户自己刷新。
 */
import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  Position,
  PositionItem,
  Profile,
  Template,
  createEmptyItem,
  nextItemId,
  type Item,
  type Section,
} from '@/schema'
import { resolveResume } from '@/render/resolve'
import { buildBlocks } from '@/render/blocks'

interface BootstrapPayload {
  profile: unknown
  positions: { id: string; position: unknown; localItems: Record<string, unknown> }[]
  templates: unknown[]
}

export interface PositionState {
  id: string
  position: Position
  localItems: Record<string, Item>
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const text = await res.text()
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`接口返回了非 JSON 内容：${url}\n${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const message = (payload as { error?: string })?.error ?? res.statusText
    throw new Error(message)
  }
  return payload as T
}

export const useResumeStore = defineStore('resume', () => {
  const profile = ref<Profile | null>(null)
  const positions = reactive<PositionState[]>([])
  const templates = reactive<Template[]>([])
  const currentId = ref<string>('')
  const loading = ref(true)
  const saving = ref(false)
  const error = ref('')
  /** 校验/加载过程中的告警，UI 顶部展示 */
  const warnings = ref<string[]>([])

  const current = computed(() => positions.find((p) => p.id === currentId.value) ?? null)

  const template = computed<Template | null>(() => {
    const pos = current.value
    if (!pos) return null
    return templates.find((t) => t.id === pos.position.template) ?? templates[0] ?? null
  })

  const resolved = computed(() => {
    if (!profile.value || !current.value || !template.value) return null
    return resolveResume({
      profile: profile.value,
      position: current.value.position,
      template: template.value,
      localItems: current.value.localItems,
    })
  })

  const blocks = computed(() => {
    const r = resolved.value
    if (!r || !profile.value) return []
    return buildBlocks({ resume: r, aliases: profile.value.basics.aliases })
  })

  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    warnings.value = []
    try {
      const data = await api<BootstrapPayload>('/api/bootstrap')

      profile.value = Profile.parse(data.profile)

      positions.splice(0, positions.length)
      for (const entry of data.positions) {
        const parsed = Position.safeParse(entry.position)
        if (!parsed.success) {
          warnings.value.push(`岗位「${entry.id}」数据不合法，已跳过：${parsed.error.issues[0]?.message}`)
          continue
        }
        positions.push({
          id: entry.id,
          position: parsed.data,
          localItems: (entry.localItems ?? {}) as Record<string, Item>,
        })
      }

      templates.splice(0, templates.length)
      for (const t of data.templates) {
        const parsed = Template.safeParse(t)
        if (parsed.success) templates.push(parsed.data)
        else warnings.value.push(`模板数据不合法，已跳过：${parsed.error.issues[0]?.message}`)
      }

      if (templates.length === 0) throw new Error('data/templates/ 下没有可用模板')
      if (positions.length === 0) throw new Error('data/positions/ 下没有可用岗位')

      // 同步内容池新增的条目到各岗位的 pendingItems
      syncPendingItems()

      if (!positions.some((p) => p.id === currentId.value)) {
        currentId.value = positions[0].id
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  /**
   * 内容池新增的条目，在尚未表态的岗位里进 pendingItems。
   *
   * 不默认可见（怕通用版泄漏细节），也不默认隐藏（怕忘记投）——
   * 逼用户显式表态。见 AGENTS.md §5。
   */
  function syncPendingItems(): void {
    if (!profile.value) return
    for (const state of positions) {
      const known = new Set<string>()
      for (const sec of state.position.sections) {
        for (const item of sec.items) known.add(item.ref)
      }
      const pending = new Set(state.position.pendingItems)
      for (const sec of profile.value.sections) {
        for (const itemId of sec.itemIds) {
          if (!known.has(itemId)) pending.add(itemId)
        }
      }
      // 已经进了 sections 的条目要从 pending 里移除
      state.position.pendingItems = [...pending].filter((id) => !known.has(id))
    }
  }

  // ---- 保存（防抖） ----

  const dirtyProfile = ref(false)
  const dirtyPositions = reactive(new Set<string>())
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleSave(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flush(), 400)
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!dirtyProfile.value && dirtyPositions.size === 0) return
    saving.value = true
    try {
      if (dirtyProfile.value && profile.value) {
        await api('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile.value),
        })
        dirtyProfile.value = false
      }
      for (const id of [...dirtyPositions]) {
        const state = positions.find((p) => p.id === id)
        if (!state) {
          dirtyPositions.delete(id)
          continue
        }
        state.position.meta.updatedAt = new Date().toISOString()
        await api(`/api/positions/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.position),
        })
        dirtyPositions.delete(id)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      saving.value = false
    }
  }

  function touchProfile(): void {
    dirtyProfile.value = true
    scheduleSave()
  }

  function touchPosition(id = currentId.value): void {
    if (id) dirtyPositions.add(id)
    scheduleSave()
  }

  const dirty = computed(() => dirtyProfile.value || dirtyPositions.size > 0)

  // ---- 岗位操作 ----

  async function createPosition(input: {
    id: string
    name: string
    forkFrom?: string
  }): Promise<void> {
    const source = input.forkFrom ? positions.find((p) => p.id === input.forkFrom) : null
    const seed: Position = source
      ? // 结构化深拷贝：fork 复制的是覆盖层，内容仍然共享同一个池
        (JSON.parse(JSON.stringify(source.position)) as Position)
      : Position.parse({
          schemaVersion: 1,
          meta: { name: input.name },
          sections: [],
        })
    seed.meta.name = input.name
    seed.meta.order = Math.max(0, ...positions.map((p) => p.position.meta.order)) + 1
    seed.meta.updatedAt = new Date().toISOString()

    await api('/api/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: input.id, position: seed }),
    })
    positions.push({ id: input.id, position: seed, localItems: {} })
    syncPendingItems()
    currentId.value = input.id
  }

  async function deletePosition(id: string): Promise<void> {
    await api(`/api/positions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    const idx = positions.findIndex((p) => p.id === id)
    if (idx >= 0) positions.splice(idx, 1)
    if (currentId.value === id) currentId.value = positions[0]?.id ?? ''
  }

  async function exportPdf(id = currentId.value): Promise<{
    filename: string
    pages: number
    bytes: number
    ms: number
    /** 非致命提醒（例如字体子集没生成，PDF 会退化） */
    warning?: string
  }> {
    // 先把未保存的改动落盘，否则导出的是旧内容
    await flush()
    return api(`/api/positions/${encodeURIComponent(id)}/export`, { method: 'POST' })
  }

  // ---- 条目操作 ----

  /**
   * 往内容池新增一个空白条目，并在**当前岗位**里直接可见。
   *
   * 只对当前岗位可见是有意的：你是在这个岗位的上下文里想到要加这条的。
   * 其他岗位走 pendingItems 队列等你表态 —— 不静默显示（怕公开版泄漏），
   * 也不静默隐藏（怕忘记投）。见 AGENTS.md §5。
   *
   * 返回新条目 id，供 UI 展开并聚焦它。
   */
  function addItem(sectionId: string): string | null {
    const prof = profile.value
    const pos = current.value
    if (!prof || !pos) return null

    const section = prof.sections.find((s) => s.id === sectionId)
    if (!section) return null

    const id = nextItemId(section.kind, Object.keys(prof.items))
    prof.items[id] = createEmptyItem(section.kind, id)
    // 新条目放在小节最前面：刚加的东西通常是最新的经历，也省得往下翻找
    section.itemIds.unshift(id)
    touchProfile()

    // 当前岗位：直接可见，插在最前
    let psec = pos.position.sections.find((s) => s.ref === sectionId)
    if (!psec) {
      psec = { ref: sectionId, visible: true, titleOverride: '', items: [] }
      pos.position.sections.push(psec)
    }
    psec.items.unshift(PositionItem.parse({ ref: id }))
    touchPosition(pos.id)

    // 其他岗位：进待处理队列
    for (const other of positions) {
      if (other.id === pos.id) continue
      if (!other.position.pendingItems.includes(id)) {
        other.position.pendingItems.push(id)
        dirtyPositions.add(other.id)
      }
    }
    scheduleSave()
    return id
  }

  /**
   * 从内容池永久删除条目，并清理所有岗位里对它的引用。
   *
   * 这是真删除（内容池是唯一数据源，没有别处留底），所以 UI 必须先确认。
   * 服务端每次写入会把旧版 profile.json 备份到 data/.trash/autosave/，
   * 误删仍可从那里捞回来。
   */
  function removeItem(itemId: string): void {
    const prof = profile.value
    if (!prof) return

    delete prof.items[itemId]
    for (const section of prof.sections) {
      const idx = section.itemIds.indexOf(itemId)
      if (idx >= 0) section.itemIds.splice(idx, 1)
    }
    touchProfile()

    for (const state of positions) {
      let changed = false
      for (const psec of state.position.sections) {
        const idx = psec.items.findIndex((i) => i.ref === itemId)
        if (idx >= 0) {
          psec.items.splice(idx, 1)
          changed = true
        }
      }
      const pi = state.position.pendingItems.indexOf(itemId)
      if (pi >= 0) {
        state.position.pendingItems.splice(pi, 1)
        changed = true
      }
      if (changed) dirtyPositions.add(state.id)
    }
    scheduleSave()
  }

  /** 哪些岗位正在使用这个条目 —— 删除确认框要如实告知影响范围 */
  function itemUsage(itemId: string): { id: string; name: string; visible: boolean }[] {
    const out: { id: string; name: string; visible: boolean }[] = []
    for (const state of positions) {
      for (const psec of state.position.sections) {
        const found = psec.items.find((i) => i.ref === itemId)
        if (found) {
          out.push({ id: state.id, name: state.position.meta.name, visible: found.visible })
          break
        }
      }
    }
    return out
  }

  function positionItem(sectionId: string, itemId: string): PositionItem | null {
    const sec = current.value?.position.sections.find((s) => s.ref === sectionId)
    return sec?.items.find((i) => i.ref === itemId) ?? null
  }

  function poolItem(itemId: string): Item | null {
    return profile.value?.items[itemId] ?? current.value?.localItems[itemId] ?? null
  }

  function poolSection(sectionId: string): Section | null {
    return profile.value?.sections.find((s) => s.id === sectionId) ?? null
  }

  watch(currentId, (id) => {
    if (id) localStorage.setItem('resume:currentPosition', id)
  })

  const stored = localStorage.getItem('resume:currentPosition')
  if (stored) currentId.value = stored

  return {
    profile,
    positions,
    templates,
    currentId,
    current,
    template,
    resolved,
    blocks,
    loading,
    saving,
    dirty,
    error,
    warnings,
    load,
    flush,
    touchProfile,
    touchPosition,
    createPosition,
    deletePosition,
    exportPdf,
    addItem,
    removeItem,
    itemUsage,
    positionItem,
    poolItem,
    poolSection,
    syncPendingItems,
  }
})
