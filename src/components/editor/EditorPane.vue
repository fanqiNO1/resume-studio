<script setup lang="ts">
/**
 * 编辑器面板：基本信息 + 各小节的条目列表 + 待处理队列。
 */
import { computed, nextTick, ref } from 'vue'
import { useResumeStore } from '@/stores/resume'
import { KIND_LABEL, PositionItem, type PositionSection } from '@/schema'
import ItemCard from './ItemCard.vue'
import FieldInput from './FieldInput.vue'

const activeItemId = defineModel<string>('activeItemId', { default: '' })

const store = useResumeStore()

const position = computed(() => store.current?.position ?? null)
const profile = computed(() => store.profile)

const collapsed = defineModel<Record<string, boolean>>('collapsed', { default: () => ({}) })

function sectionTitle(sec: PositionSection): string {
  return sec.titleOverride || store.poolSection(sec.ref)?.title || sec.ref
}

function visibleCount(sec: PositionSection): number {
  return sec.items.filter((i) => i.visible).length
}

function moveItem(sec: PositionSection, index: number, delta: number): void {
  const next = index + delta
  if (next < 0 || next >= sec.items.length) return
  const [item] = sec.items.splice(index, 1)
  sec.items.splice(next, 0, item)
  store.touchPosition()
}

function moveSection(index: number, delta: number): void {
  const list = position.value?.sections
  if (!list) return
  const next = index + delta
  if (next < 0 || next >= list.length) return
  const [sec] = list.splice(index, 1)
  list.splice(next, 0, sec)
  store.touchPosition()
}

function toggleSection(sec: PositionSection): void {
  sec.visible = !sec.visible
  store.touchPosition()
}

function setPublic(value: boolean): void {
  if (!position.value) return
  position.value.meta.public = value
  store.touchPosition()
}

function toggleContact(id: string): void {
  const pos = position.value
  if (!pos) return
  const idx = pos.contactInclude.indexOf(id)
  if (idx >= 0) pos.contactInclude.splice(idx, 1)
  else {
    // 保持与内容池相同的顺序，而不是按点击顺序
    const order = profile.value?.basics.contacts.map((c) => c.id) ?? []
    pos.contactInclude = order.filter((c) => pos.contactInclude.includes(c) || c === id)
  }
  store.touchPosition()
}

/** 公开版却勾了敏感联系方式 —— 这是最容易出事的地方，必须显式告警 */
const publicLeaks = computed(() => {
  const pos = position.value
  if (!pos?.meta.public) return []
  return (profile.value?.basics.contacts ?? [])
    .filter((c) => c.sensitive && pos.contactInclude.includes(c.id))
    .map((c) => c.value)
})

/** 内容池新增、本岗位尚未表态的条目 */
const pending = computed(() => {
  const pos = position.value
  if (!pos || !profile.value) return []
  return pos.pendingItems
    .map((id) => {
      const item = store.poolItem(id)
      const section = profile.value!.sections.find((s) => s.itemIds.includes(id))
      return item && section ? { id, item, section } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
})

function itemLabel(item: ReturnType<typeof store.poolItem>): string {
  if (!item) return ''
  switch (item.kind) {
    case 'education':
      return `${item.school} / ${item.degree}`
    case 'publication':
      return item.title
    case 'project':
    case 'award':
      return item.name
    case 'experience':
      return item.company
    case 'custom':
      return item.title
  }
}

/** 表态：把待处理条目纳入本岗位（可见或隐藏） */
function resolvePending(id: string, sectionId: string, visible: boolean): void {
  const pos = position.value
  if (!pos) return
  let sec = pos.sections.find((s) => s.ref === sectionId)
  if (!sec) {
    sec = { ref: sectionId, visible: true, titleOverride: '', items: [] }
    pos.sections.push(sec)
  }
  // 插到与内容池相同的相对位置，避免新条目总是垫底
  const poolOrder = store.poolSection(sectionId)?.itemIds ?? []
  const target = poolOrder.indexOf(id)
  const insertAt = sec.items.findIndex((i) => poolOrder.indexOf(i.ref) > target)
  const entry = PositionItem.parse({ ref: id, visible })
  if (insertAt >= 0) sec.items.splice(insertAt, 0, entry)
  else sec.items.push(entry)

  pos.pendingItems = pos.pendingItems.filter((p) => p !== id)
  store.touchPosition()
}

/** 新建条目后自动展开并聚焦它 */
const justAdded = ref('')

function addItem(sectionId: string): void {
  const id = store.addItem(sectionId)
  if (!id) return
  collapsed.value[sectionId] = false
  activeItemId.value = id
  justAdded.value = id
  // 让新卡片滚进视野
  void nextTick(() => {
    document
      .querySelector(`[data-card-id="${id}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

function sectionKindLabel(sec: PositionSection): string {
  const kind = store.poolSection(sec.ref)?.kind
  return kind ? KIND_LABEL[kind] : '条目'
}

/**
 * 内容池里有、但当前岗位还没启用的小节。
 *
 * 空白新建的岗位 sections 是空的，若只渲染 position.sections，编辑器会是一片
 * 空白且无从下手 —— 这些入口保证任何状态下都能往里加东西。
 */
const inactiveSections = computed(() => {
  const pos = position.value
  if (!pos || !profile.value) return []
  const active = new Set(pos.sections.map((s) => s.ref))
  return profile.value.sections.filter((s) => !active.has(s.id))
})

function enableSection(sectionId: string): void {
  const pos = position.value
  if (!pos || !profile.value) return
  const source = profile.value.sections.find((s) => s.id === sectionId)
  if (!source) return
  // 启用时把池里已有的条目一并带上（默认可见），否则还得一条条手动表态
  pos.sections.push({
    ref: sectionId,
    visible: true,
    titleOverride: '',
    items: source.itemIds.map((id) => PositionItem.parse({ ref: id })),
  })
  pos.pendingItems = pos.pendingItems.filter((id) => !source.itemIds.includes(id))
  store.touchPosition()
}

// ---- 删除条目（内容池级，需确认）----

const deletingItem = ref<{ id: string; label: string } | null>(null)
const deletingUsage = computed(() =>
  deletingItem.value ? store.itemUsage(deletingItem.value.id) : [],
)

function askDeleteItem(itemId: string): void {
  deletingItem.value = { id: itemId, label: itemLabel(store.poolItem(itemId)) || '（未命名）' }
}

function confirmDeleteItem(): void {
  if (!deletingItem.value) return
  store.removeItem(deletingItem.value.id)
  deletingItem.value = null
}
</script>

<template>
  <div v-if="position && profile" class="editor">
    <!-- 待处理队列：内容池新增的条目必须显式表态 -->
    <section v-if="pending.length" class="pending">
      <h3>{{ pending.length }} 个新条目待处理</h3>
      <p class="pending-note">
        内容池里新增了这些条目，但本岗位还没表态。不默认显示（怕公开版泄漏细节），
        也不默认隐藏（怕忘记投）。
      </p>
      <div v-for="p in pending" :key="p.id" class="pending-row">
        <span class="pending-title">{{ itemLabel(p.item) }}</span>
        <span class="tag tag-muted">{{ p.section.title }}</span>
        <button class="btn btn-sm" @click="resolvePending(p.id, p.section.id, true)">显示</button>
        <button class="btn btn-sm" @click="resolvePending(p.id, p.section.id, false)">隐藏</button>
      </div>
    </section>

    <!-- 基本信息 -->
    <section class="group">
      <div class="group-head">
        <h3>基本信息</h3>
      </div>

      <div class="public-row">
        <span class="public-label">是否为可公开版</span>
        <div class="seg-sm">
          <button class="seg-sm-btn" :class="{ active: position.meta.public }" @click="setPublic(true)">
            是
          </button>
          <button
            class="seg-sm-btn"
            :class="{ active: !position.meta.public }"
            @click="setPublic(false)"
          >
            否
          </button>
        </div>
      </div>
      <p v-if="publicLeaks.length" class="leak">
        ⚠ 这是公开版，但勾选了敏感联系方式：{{ publicLeaks.join('、') }}
      </p>

      <FieldInput
        label="姓名"
        required
        :model-value="profile.basics.name"
        @update:model-value="
          profile.basics.name = $event;
          store.touchProfile()
        "
      />
      <FieldInput
        label="目标岗位全称（仅用于备注与文件名）"
        :model-value="position.meta.targetPosition"
        @update:model-value="
          position.meta.targetPosition = $event;
          store.touchPosition()
        "
      />
      <FieldInput
        label="文件名模板"
        :model-value="position.meta.filenameTemplate"
        placeholder="{name}-{positionName}-{phone}"
        @update:model-value="
          position.meta.filenameTemplate = $event;
          store.touchPosition()
        "
      />

      <div class="contacts">
        <div class="pool-head">
          <span>联系方式</span>
          <span class="pool-hint">勾选决定本岗位展示哪些</span>
        </div>
        <label v-for="c in profile.basics.contacts" :key="c.id" class="contact-row">
          <input
            type="checkbox"
            :checked="position.contactInclude.includes(c.id)"
            @change="toggleContact(c.id)"
          />
          <span class="contact-type">{{ c.type }}</span>
          <input
            class="field-input"
            :value="c.value"
            @input="
              c.value = ($event.target as HTMLInputElement).value;
              store.touchProfile()
            "
          />
          <span v-if="c.sensitive" class="tag tag-warn">敏感</span>
        </label>
      </div>

      <FieldInput
        label="备注（不进 PDF）"
        multiline
        :rows="2"
        :model-value="position.meta.note"
        @update:model-value="
          position.meta.note = $event;
          store.touchPosition()
        "
      />
    </section>

    <!-- 各小节 -->
    <section v-for="(sec, si) in position.sections" :key="sec.ref" class="group">
      <div class="group-head">
        <button class="chev" :class="{ open: !collapsed[sec.ref] }" @click="collapsed[sec.ref] = !collapsed[sec.ref]">
          ▸
        </button>
        <h3>{{ sectionTitle(sec) }}</h3>
        <span class="tag tag-muted">{{ visibleCount(sec) }}/{{ sec.items.length }} 可见</span>
        <div class="group-actions">
          <button class="btn btn-ghost btn-sm" :title="sec.visible ? '隐藏整个小节' : '显示整个小节'" @click="toggleSection(sec)">
            {{ sec.visible ? '👁' : '🚫' }}
          </button>
          <button class="btn btn-ghost btn-sm" title="小节上移" :disabled="si === 0" @click="moveSection(si, -1)">
            ↑
          </button>
          <button
            class="btn btn-ghost btn-sm"
            title="小节下移"
            :disabled="si === position.sections.length - 1"
            @click="moveSection(si, 1)"
          >
            ↓
          </button>
        </div>
      </div>

      <div v-if="!collapsed[sec.ref]" class="group-body" :class="{ 'group-off': !sec.visible }">
        <ItemCard
          v-for="(pi, ii) in sec.items"
          :key="pi.ref"
          :section-id="sec.ref"
          :position-item="pi"
          :index="ii"
          :total="sec.items.length"
          :active="activeItemId === pi.ref"
          :start-expanded="justAdded === pi.ref"
          @focus="activeItemId = pi.ref"
          @move="moveItem(sec, ii, $event)"
          @delete="askDeleteItem(pi.ref)"
        />
        <button class="add-btn" @click="addItem(sec.ref)">
          ＋ 新增{{ sectionKindLabel(sec) }}
        </button>
      </div>
    </section>

    <!-- 内容池里有、但本岗位尚未启用的小节 -->
    <section v-if="inactiveSections.length" class="group">
      <div class="group-head">
        <h3>未启用的小节</h3>
      </div>
      <p class="inactive-note">这些小节在内容池里存在，但本岗位还没用上。</p>
      <button
        v-for="sec in inactiveSections"
        :key="sec.id"
        class="add-btn"
        @click="enableSection(sec.id)"
      >
        ＋ 启用「{{ sec.title }}」<template v-if="sec.itemIds.length">（{{ sec.itemIds.length }} 条）</template>
      </button>
    </section>
  </div>

  <!-- 删除条目：内容池是唯一数据源，所以要说清影响范围 -->
  <div v-if="deletingItem" class="modal-backdrop" @click.self="deletingItem = null">
    <div class="modal">
      <h3>从内容池删除「{{ deletingItem.label }}」？</h3>
      <p class="modal-note">
        这条内容会被<strong>永久删除</strong>，不只是在当前岗位隐藏。
        <template v-if="deletingUsage.length">
          以下 {{ deletingUsage.length }} 个岗位正在引用它：
        </template>
        <template v-else>目前没有岗位引用它。</template>
      </p>
      <ul v-if="deletingUsage.length" class="usage-list">
        <li v-for="u in deletingUsage" :key="u.id">
          {{ u.name }}
          <span class="tag" :class="u.visible ? '' : 'tag-muted'">
            {{ u.visible ? '显示中' : '已隐藏' }}
          </span>
        </li>
      </ul>
      <p class="modal-note">
        只想在当前岗位不显示的话，用条目上的 👁 按钮即可，内容会保留。
        误删可以从 <code>data/.trash/autosave/</code> 里找回上一版 profile.json。
      </p>
      <div class="modal-actions">
        <button class="btn" @click="deletingItem = null">取消</button>
        <button class="btn btn-danger" @click="confirmDeleteItem">永久删除</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor {
  padding: 12px;
}

.group {
  margin-bottom: 14px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--ui-border);
}
.group-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.group-actions {
  margin-left: auto;
  display: flex;
}
.group-off {
  opacity: 0.45;
}

.chev {
  border: 0;
  background: transparent;
  color: var(--ui-muted);
  padding: 0 2px;
  transition: transform 0.15s;
}
.chev.open {
  transform: rotate(90deg);
}

.pending {
  border: 1px solid #f0cf8a;
  background: #fdf7e8;
  border-radius: 7px;
  padding: 10px 11px;
  margin-bottom: 14px;
}
.pending h3 {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--ui-warn);
}
.pending-note {
  margin: 0 0 8px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ui-warn);
}
.pending-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
.pending-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.public-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.public-label {
  font-size: 12px;
  color: var(--ui-muted);
}
.seg-sm {
  display: inline-flex;
  border: 1px solid var(--ui-border-strong);
  border-radius: 5px;
  overflow: hidden;
}
.seg-sm-btn {
  padding: 3px 12px;
  border: 0;
  background: var(--ui-panel-raised);
  color: var(--ui-muted);
  font-size: 12px;
}
.seg-sm-btn + .seg-sm-btn {
  border-left: 1px solid var(--ui-border);
}
.seg-sm-btn.active {
  background: var(--ui-accent);
  color: #fff;
}

.leak {
  margin: 0 0 10px;
  padding: 6px 8px;
  background: #fdeeee;
  border-radius: 5px;
  font-size: 12px;
  color: var(--ui-danger);
}

.contacts {
  margin: 12px 0;
  padding-top: 8px;
  border-top: 1px dashed var(--ui-border);
}
.pool-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
}
.pool-hint {
  font-weight: 400;
  font-size: 11px;
  color: var(--ui-muted);
}
.contact-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.contact-type {
  flex: 0 0 62px;
  font-size: 11px;
  color: var(--ui-muted);
  font-family: var(--ui-font-mono);
}

/* 新增条目按钮：虚线框，与实心的条目卡片区分开 */
.add-btn {
  display: block;
  width: 100%;
  margin-top: 2px;
  padding: 6px;
  border: 1px dashed var(--ui-border-strong);
  border-radius: 7px;
  background: transparent;
  color: var(--ui-muted);
  font-size: 12px;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.add-btn:hover {
  color: var(--ui-accent);
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
}
.add-btn + .add-btn {
  margin-top: 5px;
}
.inactive-note {
  margin: 0 0 7px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ui-muted);
}

/* ---------- 删除确认弹窗 ---------- */

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(9, 43, 60, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  width: 420px;
  max-width: calc(100vw - 32px);
  background: var(--ui-panel);
  border-radius: 9px;
  padding: 18px;
  box-shadow: 0 18px 48px rgba(9, 43, 60, 0.24);
}
.modal h3 {
  margin: 0 0 12px;
  font-size: 15px;
}
.modal-note {
  margin: 10px 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--ui-muted);
}
.modal-note code {
  font-family: var(--ui-font-mono);
  background: var(--ui-bg);
  padding: 1px 4px;
  border-radius: 3px;
}
.usage-list {
  margin: 6px 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.9;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
