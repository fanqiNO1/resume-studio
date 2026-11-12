<script setup lang="ts">
/**
 * 可复制的纯文本视图。
 *
 * 投递表单（公司自建 ATS）大多不收 PDF，得手敲或粘贴，
 * 这个视图就是为那个场景服务的。
 *
 * 分段复制是刻意做的：表单往往把"工作经历""项目经历"拆成独立输入框，
 * 一次全选反而要手工切分。
 */
import { computed, ref } from 'vue'
import type { Block } from '@/render/blocks'
import {
  blocksToSections,
  blocksToText,
  DEFAULT_TEXT_OPTIONS,
  type TextFormat,
} from '@/render/plaintext'

const props = defineProps<{
  blocks: Block[]
}>()

const format = ref<TextFormat>(DEFAULT_TEXT_OPTIONS.format)
const autoSpace = ref(DEFAULT_TEXT_OPTIONS.autoSpace)

const options = computed(() => ({ format: format.value, autoSpace: autoSpace.value }))
const fullText = computed(() => blocksToText(props.blocks, options.value))
const sections = computed(() => blocksToSections(props.blocks, options.value))

const stats = computed(() => {
  const t = fullText.value
  return {
    chars: [...t.replace(/\s/g, '')].length,
    lines: t.trimEnd().split('\n').length,
  }
})

/** 刚复制过的那块的标识，用于短暂显示「已复制」 */
const copied = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copy(text: string, key: string): Promise<void> {
  try {
    await writeClipboard(text)
    copied.value = key
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = ''), 1600)
  } catch (err) {
    console.error('[copy] 写剪贴板失败', err)
    copied.value = `error:${key}`
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = ''), 3000)
  }
}

/**
 * 写剪贴板。
 *
 * navigator.clipboard 需要安全上下文 —— 通过端口转发用 http://<内网 IP>
 * 访问时它是 undefined（只有 localhost 被当作安全来源）。
 * 所以保留 execCommand 兜底，否则那个场景下复制按钮会静默失效。
 */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  // 放在视口内但不可见，否则 iOS 上会滚动跳动
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('execCommand("copy") 返回 false')
}
</script>

<template>
  <div class="text-view">
    <div class="text-toolbar">
      <div class="seg">
        <button
          v-for="f in (['plain', 'markdown'] as TextFormat[])"
          :key="f"
          class="seg-btn"
          :class="{ active: format === f }"
          @click="format = f"
        >
          {{ f === 'plain' ? '纯文本' : 'Markdown' }}
        </button>
      </div>

      <label class="ctl-check" title="在中英之间补真实空格。PDF 里靠 CSS 实现，纯文本只能插空格">
        <input v-model="autoSpace" type="checkbox" />
        中英加空格
      </label>

      <span class="text-stat">{{ stats.lines }} 行 · {{ stats.chars }} 字</span>

      <div class="spacer" />

      <button class="btn btn-primary" @click="copy(fullText, '__all__')">
        {{ copied === '__all__' ? '已复制 ✓' : '复制全文' }}
      </button>
    </div>

    <p v-if="copied.startsWith('error:')" class="copy-error">
      写剪贴板失败。若你是通过 IP 访问（而非 localhost），浏览器会禁用剪贴板 API ——
      可以手动选中下方文本复制。
    </p>

    <div class="text-body">
      <section v-for="(sec, si) in sections" :key="si" class="text-section">
        <div class="section-bar">
          <span class="section-title">{{ sec.title || '基本信息' }}</span>
          <button class="copy-btn scope-section" @click="copy(sec.content, `s${si}`)">
            {{ copied === `s${si}` ? '已复制 ✓' : '复制本段' }}
          </button>
        </div>

        <div v-for="(entry, ei) in sec.entries" :key="ei" class="entry">
          <div v-if="entry.head" class="entry-head">
            <span class="entry-title">{{ entry.head.content }}</span>
            <button class="copy-btn scope-head" @click="copy(entry.head.content, `s${si}e${ei}h`)">
              {{ copied === `s${si}e${ei}h` ? '✓' : '复制标题' }}
            </button>
            <button class="copy-btn scope-entry" @click="copy(entry.content, `s${si}e${ei}a`)">
              {{ copied === `s${si}e${ei}a` ? '✓' : '复制整条' }}
            </button>
          </div>

          <div v-for="(unit, ui) in entry.units" :key="ui" class="unit">
            <span class="unit-label">{{ unit.label }}</span>
            <pre class="unit-text">{{ unit.content }}</pre>
            <button class="copy-btn scope-unit" @click="copy(unit.content, `s${si}e${ei}u${ui}`)">
              {{ copied === `s${si}e${ei}u${ui}` ? '✓' : '复制' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.text-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.text-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: var(--ui-panel);
  border-bottom: 1px solid var(--ui-border);
  flex: 0 0 auto;
}
.spacer {
  flex: 1 1 auto;
}
.text-stat {
  color: var(--ui-muted);
  font-variant-numeric: tabular-nums;
}
.ctl-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-muted);
}

.seg {
  display: inline-flex;
  border: 1px solid var(--ui-border-strong);
  border-radius: 6px;
  overflow: hidden;
}
.seg-btn {
  padding: 4px 11px;
  border: 0;
  background: var(--ui-panel-raised);
  color: var(--ui-muted);
}
.seg-btn + .seg-btn {
  border-left: 1px solid var(--ui-border);
}
.seg-btn.active {
  background: var(--ui-accent);
  color: #fff;
}

.copy-error {
  margin: 0;
  padding: 7px 14px;
  background: #fdeeee;
  color: var(--ui-danger);
  font-size: 12px;
  line-height: 1.6;
  flex: 0 0 auto;
}

.text-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px;
}

/*
 * 限宽而不是铺满：全屏宽下复制按钮会被推到离文字一米远，点之前得先用眼睛
 * 横着扫一遍确认对应的是哪一行；长作者列表也难扫。左对齐不居中，与编辑器一致。
 */
.text-section {
  max-width: 900px;
  background: var(--ui-panel-raised);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  margin-bottom: 12px;
  overflow: hidden;
}

.section-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: var(--ui-panel);
  border-bottom: 1px solid var(--ui-border);
}
.section-title {
  font-weight: 600;
  font-size: 12.5px;
}

/* 条目之间用分隔线而不是间距：分隔线更明确地说明"这两条是分开复制的" */
.entry + .entry {
  border-top: 1px solid var(--ui-border);
}

.entry-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 9px 10px 5px;
}
.entry-title {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
  line-height: 1.5;
}

/*
 * 一行一个字段。label 定宽对齐，正文占满，复制按钮贴右。
 * 定宽 40px 够放「GitHub」「LinkedIn」以外的所有标签，超出就换行 ——
 * 不用 min-content，否则每个小节的对齐位置都不一样，扫读时很乱。
 */
.unit {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 10px;
}
.unit:last-child {
  padding-bottom: 9px;
}
.unit-label {
  flex: 0 0 auto;
  width: 40px;
  color: var(--ui-muted);
  font-size: 11.5px;
  text-align: right;
  user-select: none;
}
/*
 * 用 pre 而不是 div：保留换行与空格，复制时不带 HTML 的额外空白。
 * 字体用界面字体而非简历字体 —— 这里是"待复制的内容"，不是排版预览。
 */
.unit-text {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-family: var(--ui-font);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  /* 允许手动选中 —— 剪贴板 API 不可用时这是唯一出路 */
  user-select: text;
}

/*
 * 按钮多，所以做得很轻：默认半透明，鼠标进到所在行才实心。
 * 不用 display:none，否则一眼看不出"每个字段都能单独复制"。
 */
.copy-btn {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-muted);
  font-size: 11px;
  line-height: 1.7;
  opacity: 0.5;
  transition: opacity 0.12s ease;
}
.unit:hover .copy-btn,
.entry-head:hover .copy-btn,
.section-bar .copy-btn,
.copy-btn:hover,
.copy-btn:focus-visible {
  opacity: 1;
}
.copy-btn:hover {
  border-color: var(--ui-border-strong);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}

/*
 * 悬停复制按钮时高亮它对应的范围。
 *
 * 三级按钮挨在一起，「复制标题 / 复制整条 / 复制本段」光看位置说不清各自
 * 覆盖到哪 —— 点下去才知道复制了什么，就晚了。高亮把范围直接画出来。
 *
 * 用 :has() 反向选中祖先，不进 Vue 响应式：纯悬停反馈而已，走 CSS 不会
 * 在每次移动鼠标时触发组件更新。不支持 :has() 的浏览器只是没有高亮，不坏。
 * 每条选择器都用子组合器锁定层级，否则 .text-section:has(.copy-btn:hover)
 * 会被内层任意一个按钮点亮，反而分不清范围。
 */
.text-section {
  --hl: #eaf6fd;
}
.text-section,
.section-bar,
.entry,
.unit,
.entry-title {
  transition: background 0.12s ease;
}

.text-section:has(> .section-bar > .scope-section:hover),
.text-section:has(> .section-bar > .scope-section:hover) .section-bar {
  background: var(--hl);
}

.entry:has(> .entry-head > .scope-entry:hover) {
  background: var(--hl);
}

/* 标题是行内文本，用外扩阴影把高亮撑开一点，否则贴着字看不出是一块 */
.entry-head:has(> .scope-head:hover) .entry-title {
  background: var(--hl);
  box-shadow: 0 0 0 3px var(--hl);
  border-radius: 2px;
}

.unit:has(> .scope-unit:hover) {
  background: var(--hl);
}
</style>
