<script setup lang="ts">
/**
 * 单个条目的编辑卡片。
 *
 * 字段来源有两处，UI 上必须让用户分得清（docs/DESIGN.md §3.2）：
 *   - 内容池字段（shared）：改了会影响所有岗位；覆盖后显示橙色竖条 + 「已覆盖」
 *   - 岗位专属字段（position-local）：pitch / extraBullets / 可见性 / 展开档，
 *     只影响当前岗位，普通输入框，无覆盖概念
 */
import { computed, ref } from 'vue'
import { useResumeStore } from '@/stores/resume'
import { FIELD_ORDER, REQUIRED_FIELDS, type PositionItem } from '@/schema'
import FieldInput from './FieldInput.vue'

const props = defineProps<{
  sectionId: string
  positionItem: PositionItem
  index: number
  total: number
  active: boolean
  /** 新建的条目直接展开，省得再点一下 */
  startExpanded?: boolean
}>()

const emit = defineEmits<{
  (e: 'focus'): void
  (e: 'move', delta: number): void
  (e: 'delete'): void
}>()

const store = useResumeStore()
const expanded = ref(props.startExpanded ?? false)
const showOptional = ref(false)

const item = computed(() => store.poolItem(props.positionItem.ref))
const kind = computed(() => item.value?.kind ?? 'custom')
const required = computed(() => REQUIRED_FIELDS[kind.value] ?? [])
const fieldOrder = computed(() => FIELD_ORDER[kind.value] ?? [])

const LABELS: Record<string, string> = {
  school: '学校',
  degree: '学位',
  major: '专业',
  gpa: 'GPA',
  title: '标题',
  venue: '会议/期刊全称',
  venueShort: '会议简称',
  authors: '作者列表',
  name: '名称',
  role: '角色',
  start: '开始',
  end: '结束',
  summary: '摘要',
  company: '公司',
  department: '部门',
  team: '团队 / 项目组',
  date: '日期',
  level: '等级',
  issuer: '颁发方',
  subtitle: '副标题',
  dateRight: '右侧日期',
}

/** 条目卡片标题：尽量用最能识别这条内容的字段 */
const heading = computed(() => {
  const it = item.value
  if (!it) return `⚠ 找不到条目 ${props.positionItem.ref}`
  switch (it.kind) {
    case 'education':
      return `${it.school} / ${it.degree}`
    case 'publication':
      return it.title
    case 'project':
      return it.name
    case 'experience':
      return it.company
    case 'award':
      return it.name
    case 'custom':
      return it.title
  }
})

const missingRequired = computed(() => {
  const it = item.value
  if (!it) return []
  return required.value.filter((f) => {
    const v = (it as unknown as Record<string, unknown>)[f]
    return typeof v === 'string' ? !v.trim() : !v
  })
})

/** 可见的池字段（必填 + 已填的选填），其余折叠 */
const visibleFields = computed(() =>
  fieldOrder.value.filter((f) => {
    if (required.value.includes(f)) return true
    if (showOptional.value) return true
    const raw = (item.value as unknown as Record<string, unknown>)?.[f]
    if (Array.isArray(raw)) return raw.length > 0
    return typeof raw === 'string' ? raw.trim().length > 0 : Boolean(raw)
  }),
)

const hiddenOptionalCount = computed(
  () => fieldOrder.value.length - visibleFields.value.length,
)

/** 字段当前值：优先取覆盖值，否则取池值。数组字段用换行分隔编辑。 */
function fieldValue(field: string): string {
  const override = props.positionItem.overrides[field]
  const raw =
    override !== undefined ? override : (item.value as unknown as Record<string, unknown>)?.[field]
  if (Array.isArray(raw)) return raw.join('\n')
  return raw == null ? '' : String(raw)
}

function inheritedValue(field: string): string | null {
  if (props.positionItem.overrides[field] === undefined) return null
  const raw = (item.value as unknown as Record<string, unknown>)?.[field]
  return Array.isArray(raw) ? raw.join('\n') : raw == null ? '' : String(raw)
}

const ARRAY_FIELDS = new Set(['authors'])
/** 支持行内标记的字段 */
const MARKUP_FIELDS = new Set(['summary', 'items', 'title', 'name'])
/** 需要多行输入的字段 */
const MULTILINE_FIELDS = new Set(['summary', 'title', 'venue', 'authors', 'items'])

/**
 * 写字段值。
 *
 * 默认直接写内容池（这是常态：改错别字应该全局生效）。
 * 只有用户显式点了「改为仅本岗位」才写进 overrides —— 避免用户以为
 * 在改这一份，实际改了所有岗位，或反之。
 */
function setFieldValue(field: string, value: string, scope: 'pool' | 'position'): void {
  const it = item.value
  if (!it) return
  const parsed: string | string[] = ARRAY_FIELDS.has(field)
    ? value.split('\n').map((s) => s.trim()).filter(Boolean)
    : value

  if (scope === 'position') {
    props.positionItem.overrides[field] = parsed
    store.touchPosition()
    return
  }
  // 若该字段已有覆盖，改池值时同时保留覆盖（用户要的是改池，不是清覆盖）
  ;(it as unknown as Record<string, unknown>)[field] = parsed
  store.touchProfile()
}

function scopeOf(field: string): 'pool' | 'position' {
  return props.positionItem.overrides[field] !== undefined ? 'position' : 'pool'
}

function revertField(field: string): void {
  delete props.positionItem.overrides[field]
  store.touchPosition()
}

function makeOverride(field: string): void {
  props.positionItem.overrides[field] = fieldValue(field)
  store.touchPosition()
}

// ---- 岗位专属：可见性、展开档、要点勾选、pitch ----

function toggleVisible(): void {
  props.positionItem.visible = !props.positionItem.visible
  store.touchPosition()
}

function setDetail(value: string): void {
  props.positionItem.detail = value as PositionItem['detail']
  store.touchPosition()
}

function setRender(value: string): void {
  props.positionItem.render = value as PositionItem['render']
  store.touchPosition()
}

function setPitch(value: string): void {
  props.positionItem.pitch = value
  store.touchPosition()
}

const poolBullets = computed(() => {
  const it = item.value
  return it && 'bullets' in it ? it.bullets : []
})

function bulletIncluded(id: string): boolean {
  return props.positionItem.bulletInclude === null || props.positionItem.bulletInclude.includes(id)
}

/**
 * 切换要点在本岗位的显示。
 *
 * bulletInclude 为 null 表示「全部显示」（新增要点自动包含，这是常态）。
 * 第一次取消勾选时把 null 展开成显式列表。
 */
function toggleBullet(id: string): void {
  const pi = props.positionItem
  if (pi.bulletInclude === null) {
    pi.bulletInclude = poolBullets.value.map((b) => b.id).filter((b) => b !== id)
  } else if (pi.bulletInclude.includes(id)) {
    pi.bulletInclude = pi.bulletInclude.filter((b) => b !== id)
  } else {
    // 保持与池里相同的顺序，而不是追加到末尾
    const order = poolBullets.value.map((b) => b.id)
    pi.bulletInclude = order.filter((b) => pi.bulletInclude!.includes(b) || b === id)
  }
  // 全选时回到 null，让后续新增的要点自动纳入
  if (pi.bulletInclude.length === poolBullets.value.length) pi.bulletInclude = null
  store.touchPosition()
}

function setBulletText(id: string, text: string): void {
  const bullet = poolBullets.value.find((b) => b.id === id)
  if (!bullet) return
  bullet.text = text
  store.touchProfile()
}

function addBullet(): void {
  const it = item.value
  if (!it || !('bullets' in it)) return
  const id = `b_${Math.random().toString(36).slice(2, 8)}`
  it.bullets.push({ id, text: '' })
  // 显式列表模式下新增要点默认纳入本岗位
  if (props.positionItem.bulletInclude !== null) {
    props.positionItem.bulletInclude = [...props.positionItem.bulletInclude, id]
    store.touchPosition()
  }
  store.touchProfile()
}

function removeBullet(id: string): void {
  const it = item.value
  if (!it || !('bullets' in it)) return
  const idx = it.bullets.findIndex((b) => b.id === id)
  if (idx >= 0) it.bullets.splice(idx, 1)
  if (props.positionItem.bulletInclude) {
    props.positionItem.bulletInclude = props.positionItem.bulletInclude.filter((b) => b !== id)
    store.touchPosition()
  }
  store.touchProfile()
}

function addExtraBullet(): void {
  props.positionItem.extraBullets.push({
    id: `pb_${Math.random().toString(36).slice(2, 8)}`,
    text: '',
  })
  store.touchPosition()
}

function removeExtraBullet(id: string): void {
  const list = props.positionItem.extraBullets
  const idx = list.findIndex((b) => b.id === id)
  if (idx >= 0) list.splice(idx, 1)
  store.touchPosition()
}

// ---- 论文链接（内容池字段，但有专门的子编辑器，不走通用字段表）----

const links = computed(() => {
  const it = item.value
  return it && it.kind === 'publication' ? it.links : []
})

function addLink(): void {
  const it = item.value
  if (!it || it.kind !== 'publication') return
  it.links.push('')
  store.touchProfile()
}

function setLink(index: number, url: string): void {
  const it = item.value
  if (!it || it.kind !== 'publication') return
  it.links[index] = url
  store.touchProfile()
}

function removeLink(index: number): void {
  const it = item.value
  if (!it || it.kind !== 'publication') return
  it.links.splice(index, 1)
  store.touchProfile()
}

const isPublication = computed(() => kind.value === 'publication')
/** 奖项是单行内容，schema 里就没有 bullets 字段 */
const hasBullets = computed(() => kind.value !== 'award')
const overrideCount = computed(() => Object.keys(props.positionItem.overrides).length)
</script>

<template>
  <div
    class="card"
    :class="{ 'card-hidden': !positionItem.visible, 'card-active': active }"
    :data-card-id="positionItem.ref"
    @click="emit('focus')"
  >
    <div class="card-head" @click="expanded = !expanded">
      <button class="chev" :class="{ open: expanded }">▸</button>
      <span class="card-title" :title="heading">{{ heading }}</span>

      <span v-if="missingRequired.length" class="tag tag-danger">
        缺 {{ missingRequired.length }} 项必填
      </span>
      <span v-if="overrideCount" class="tag tag-warn">{{ overrideCount }} 处覆盖</span>
      <span v-if="positionItem.pitch.trim()" class="tag">有展开</span>

      <div class="card-actions" @click.stop>
        <button
          class="btn btn-ghost btn-sm"
          :title="positionItem.visible ? '在本岗位隐藏' : '在本岗位显示'"
          @click="toggleVisible"
        >
          {{ positionItem.visible ? '👁' : '🚫' }}
        </button>
        <button
          class="btn btn-ghost btn-sm"
          title="上移"
          :disabled="index === 0"
          @click="emit('move', -1)"
        >
          ↑
        </button>
        <button
          class="btn btn-ghost btn-sm"
          title="下移"
          :disabled="index === total - 1"
          @click="emit('move', 1)"
        >
          ↓
        </button>
        <button
          class="btn btn-ghost btn-sm btn-del"
          title="从内容池永久删除（只想本岗位不显示请用 👁）"
          @click="emit('delete')"
        >
          ✕
        </button>
      </div>
    </div>

    <div v-if="expanded" class="card-body">
      <!-- 岗位专属：展开档 -->
      <div class="local-row">
        <span class="local-label">本岗位展开档</span>
        <div class="seg-sm">
          <template v-if="isPublication">
            <button
              v-for="opt in [
                { v: 'tight', t: '紧凑（2 行）' },
                { v: 'standard', t: '标准（3 行）' },
                { v: 'expanded', t: '展开（+一句话）' },
              ]"
              :key="opt.v"
              class="seg-sm-btn"
              :class="{ active: (positionItem.render ?? store.template?.publicationRender) === opt.v }"
              @click="setRender(opt.v)"
            >
              {{ opt.t }}
            </button>
          </template>
          <template v-else>
            <button
              v-for="opt in [
                { v: 'titleOnly', t: '仅标题' },
                { v: 'summary', t: '摘要' },
                { v: 'full', t: '完整' },
              ]"
              :key="opt.v"
              class="seg-sm-btn"
              :class="{ active: positionItem.detail === opt.v }"
              @click="setDetail(opt.v)"
            >
              {{ opt.t }}
            </button>
          </template>
        </div>
      </div>

      <!-- 岗位专属：论文的一句话展开 -->
      <div v-if="isPublication" class="local-block">
        <FieldInput
          label="一句话展开（仅本岗位）"
          :model-value="positionItem.pitch"
          multiline
          markup
          :rows="2"
          placeholder="这篇论文对这个岗位意味着什么。内容池里不存这个字段，各岗位互不影响。"
          @update:model-value="setPitch"
        />
        <p class="local-note">
          仅在展开档为「展开」时渲染。这是岗位专属字段，换个岗位可以写完全不同的一句。
        </p>
      </div>

      <!-- 内容池字段 -->
      <div class="pool-section">
        <div class="pool-head">
          <span>内容池字段</span>
          <span class="pool-hint">改动会影响所有岗位</span>
        </div>

        <div v-for="field in visibleFields" :key="field" class="pool-field">
          <FieldInput
            :label="LABELS[field] ?? field"
            :model-value="fieldValue(field)"
            :required="required.includes(field)"
            :multiline="MULTILINE_FIELDS.has(field)"
            :markup="MARKUP_FIELDS.has(field)"
            :inherited-value="inheritedValue(field)"
            :rows="field === 'authors' ? 3 : 2"
            :placeholder="ARRAY_FIELDS.has(field) ? '每行一个' : ''"
            @update:model-value="setFieldValue(field, $event, scopeOf(field))"
            @revert="revertField(field)"
          />
          <button
            v-if="scopeOf(field) === 'pool'"
            class="scope-btn"
            title="把这个字段改成仅本岗位生效，不影响其他岗位"
            @click="makeOverride(field)"
          >
            改为仅本岗位
          </button>
        </div>

        <button v-if="hiddenOptionalCount > 0 || showOptional" class="more-btn" @click="showOptional = !showOptional">
          {{ showOptional ? '收起选填字段' : `更多选填字段（${hiddenOptionalCount}）` }}
        </button>
      </div>

      <!-- 要点：池里的内容 + 本岗位勾选 -->
      <div v-if="hasBullets" class="pool-section">
        <div class="pool-head">
          <span>要点</span>
          <span class="pool-hint">文字在内容池，勾选框只影响本岗位</span>
        </div>
        <div v-for="b in poolBullets" :key="b.id" class="bullet-row">
          <input
            type="checkbox"
            :checked="bulletIncluded(b.id)"
            :title="bulletIncluded(b.id) ? '在本岗位隐藏这条' : '在本岗位显示这条'"
            @change="toggleBullet(b.id)"
          />
          <textarea
            class="field-textarea bullet-text"
            :class="{ dimmed: !bulletIncluded(b.id) }"
            :value="b.text"
            rows="2"
            @input="setBulletText(b.id, ($event.target as HTMLTextAreaElement).value)"
          />
          <button class="btn btn-ghost btn-sm" title="从内容池删除" @click="removeBullet(b.id)">
            ✕
          </button>
        </div>
        <button class="more-btn" @click="addBullet">＋ 新增要点（进内容池）</button>
      </div>

      <!-- 论文链接 -->
      <div v-if="isPublication" class="pool-section">
        <div class="pool-head">
          <span>链接</span>
          <span class="pool-hint">会议名后显示一个链接图标，电子版可点</span>
        </div>
        <div v-for="(l, li) in links" :key="li" class="link-row">
          <input
            class="field-input"
            :value="l"
            placeholder="https://arxiv.org/abs/..."
            @input="setLink(li, ($event.target as HTMLInputElement).value)"
          />
          <button class="btn btn-ghost btn-sm" title="删除这个链接" @click="removeLink(li)">✕</button>
        </div>
        <button class="more-btn" @click="addLink">＋ 新增链接</button>
      </div>

      <!-- 岗位专属补充要点 -->
      <div v-if="isPublication" class="pool-section">
        <div class="pool-head">
          <span>岗位专属补充要点</span>
          <span class="pool-hint">只属于本岗位，不进内容池</span>
        </div>
        <div v-for="b in positionItem.extraBullets" :key="b.id" class="bullet-row">
          <textarea
            class="field-textarea bullet-text"
            :value="b.text"
            rows="2"
            @input="
              b.text = ($event.target as HTMLTextAreaElement).value;
              store.touchPosition()
            "
          />
          <button class="btn btn-ghost btn-sm" @click="removeExtraBullet(b.id)">✕</button>
        </div>
        <button class="more-btn" @click="addExtraBullet">＋ 新增岗位专属要点</button>
      </div>

      <!-- 微调与备注 -->
      <div class="tune-row">
        <label class="tune">
          条目后微调
          <input
            class="field-input tune-input"
            type="number"
            step="0.5"
            :value="positionItem.spacingAfter"
            @input="
              positionItem.spacingAfter = Number(($event.target as HTMLInputElement).value) || 0;
              store.touchPosition()
            "
          />
          pt
        </label>
        <label class="tune tune-note">
          备注（不进 PDF）
          <input
            class="field-input"
            :value="positionItem.note"
            @input="
              positionItem.note = ($event.target as HTMLInputElement).value;
              store.touchPosition()
            "
          />
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  background: var(--ui-panel-raised);
  margin-bottom: 6px;
}
.card-active {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 2px rgba(102, 204, 255, 0.35);
}
.card-hidden {
  opacity: 0.55;
  background: var(--ui-panel);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  cursor: pointer;
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
.card-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.card-actions {
  display: flex;
  gap: 0;
  flex: 0 0 auto;
}
/* 删除是唯一不可撤销的操作，hover 时才变红，避免误点 */
.btn-del:hover:not(:disabled) {
  color: var(--ui-danger);
  background: #fdeeee;
}

.card-body {
  padding: 4px 10px 10px;
  border-top: 1px solid var(--ui-border);
}

.local-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.local-label {
  font-size: 12px;
  color: var(--ui-muted);
  flex: 0 0 auto;
}
.seg-sm {
  display: inline-flex;
  border: 1px solid var(--ui-border-strong);
  border-radius: 5px;
  overflow: hidden;
}
.seg-sm-btn {
  padding: 3px 8px;
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

.local-block {
  background: var(--ui-accent-soft);
  border: 1px solid var(--ui-border-strong);
  border-radius: 6px;
  padding: 8px 9px 4px;
  margin-bottom: 10px;
}
.local-note {
  margin: 0 0 6px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--ui-muted);
}

.pool-section {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px dashed var(--ui-border);
}
.pool-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text);
}
.pool-hint {
  font-weight: 400;
  font-size: 11px;
  color: var(--ui-muted);
}

.pool-field {
  position: relative;
}
.scope-btn {
  position: absolute;
  right: 0;
  top: 0;
  border: 0;
  background: transparent;
  color: var(--ui-muted);
  font-size: 11px;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.pool-field:hover .scope-btn {
  opacity: 1;
}
.scope-btn:hover {
  color: var(--ui-accent);
  text-decoration: underline;
}

.link-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}
.bullet-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 5px;
}
.bullet-row input[type='checkbox'] {
  margin-top: 8px;
  flex: 0 0 auto;
}
.bullet-text {
  flex: 1 1 auto;
  min-width: 0;
}
.bullet-text.dimmed {
  opacity: 0.5;
  background: var(--ui-bg);
}

.more-btn {
  border: 1px dashed var(--ui-border-strong);
  background: transparent;
  color: var(--ui-muted);
  border-radius: 5px;
  padding: 3px 9px;
  font-size: 12px;
  margin-top: 3px;
}
.more-btn:hover {
  color: var(--ui-accent);
  border-color: var(--ui-accent);
}

.tune-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px dashed var(--ui-border);
}
.tune {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-muted);
}
.tune-input {
  width: 66px;
}
.tune-note {
  flex: 1 1 auto;
}
</style>
