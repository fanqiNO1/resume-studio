<script setup lang="ts">
/**
 * 字段输入控件。
 *
 * 负责三件事：
 *  1. 必填标记与空值提示
 *  2. 行内标记工具条（选中文字点按钮插标记，不用手打 ** ==）
 *  3. 「已覆盖 / 恢复继承」——只有覆盖池里 shared 字段时才出现
 */
import { computed, ref } from 'vue'

const props = defineProps<{
  label: string
  modelValue: string
  required?: boolean
  /** 多行输入 */
  multiline?: boolean
  placeholder?: string
  /** 提供行内标记工具条 */
  markup?: boolean
  /** 该字段被 override 时传入池里的原值，用于显示「恢复继承」 */
  inheritedValue?: string | null
  rows?: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'revert'): void
}>()

const input = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)

const overridden = computed(
  () => props.inheritedValue != null && props.inheritedValue !== props.modelValue,
)
const missing = computed(() => props.required && !props.modelValue.trim())

const MARKS: { label: string; title: string; open: string; close: string }[] = [
  { label: 'B', title: '加粗 **文本**', open: '**', close: '**' },
  { label: 'H', title: '主色强调 ==文本==', open: '==', close: '==' },
  { label: '`', title: '等宽 `文本`', open: '`', close: '`' },
  { label: 'U', title: '下划线 _文本_', open: '_', close: '_' },
  { label: 'I', title: '斜体 *文本*', open: '*', close: '*' },
]

/** 在选区两侧插入标记；无选区时插入一对标记并把光标放中间 */
function applyMark(open: string, close: string): void {
  const el = input.value
  if (!el) return
  const start = el.selectionStart ?? 0
  const end = el.selectionEnd ?? 0
  const value = props.modelValue
  const selected = value.slice(start, end)
  const next = value.slice(0, start) + open + selected + close + value.slice(end)
  emit('update:modelValue', next)
  // 等 DOM 更新后恢复选区，否则光标会跳到末尾
  requestAnimationFrame(() => {
    el.focus()
    const caret = start + open.length
    el.setSelectionRange(caret, caret + selected.length)
  })
}
</script>

<template>
  <div class="field" :class="{ 'field-overridden': overridden }">
    <div class="field-head">
      <label class="field-label">
        {{ label }}
        <em v-if="required">*</em>
      </label>
      <div class="field-tools">
        <span v-if="overridden" class="tag tag-warn" :title="`继承值：${inheritedValue}`">
          已覆盖
        </span>
        <button
          v-if="overridden"
          class="btn btn-ghost btn-sm"
          title="恢复继承内容池的值"
          @click="emit('revert')"
        >
          ↺
        </button>
        <template v-if="markup">
          <button
            v-for="m in MARKS"
            :key="m.label"
            class="mark-btn"
            :title="m.title"
            @click="applyMark(m.open, m.close)"
          >
            {{ m.label }}
          </button>
        </template>
      </div>
    </div>

    <textarea
      v-if="multiline"
      ref="input"
      class="field-textarea"
      :class="{ invalid: missing }"
      :value="modelValue"
      :placeholder="placeholder"
      :rows="rows ?? 2"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <input
      v-else
      ref="input"
      class="field-input"
      :class="{ invalid: missing }"
      :value="modelValue"
      :placeholder="placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />

    <p v-if="missing" class="field-error">必填</p>
  </div>
</template>

<style scoped>
.field {
  margin-bottom: 8px;
}
.field-overridden {
  border-left: 2px solid #f59e0b;
  padding-left: 7px;
  margin-left: -9px;
}
.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 3px;
  min-height: 20px;
}
.field-label {
  font-size: 12px;
  color: var(--ui-muted);
}
.field-label em {
  color: var(--ui-danger);
  font-style: normal;
  margin-left: 1px;
}
.field-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.field:hover .field-tools,
.field:focus-within .field-tools {
  opacity: 1;
}
/* 覆盖徽标必须常显，否则用户看不出这个字段脱离了内容池 */
.field-overridden .field-tools {
  opacity: 1;
}

.mark-btn {
  width: 20px;
  height: 20px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-panel-raised);
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 1;
  padding: 0;
}
.mark-btn:hover {
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}

.invalid {
  border-color: #eda1a1;
  background: #fffafa;
}
.field-error {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--ui-danger);
}
</style>
