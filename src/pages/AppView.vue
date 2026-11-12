<script setup lang="ts">
/**
 * 工作台：左侧岗位 sidebar，右侧编辑器 + 预览双栏。
 *
 * 预览的重排在这里防抖（120ms）：分页要测量 DOM，每次按键都跑一遍会卡。
 * 120ms 对打字来说无感，又足够避免每个字符触发一次全量重排。
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useResumeStore } from '@/stores/resume'
import PositionSidebar from '@/components/sidebar/PositionSidebar.vue'
import EditorPane from '@/components/editor/EditorPane.vue'
import PreviewPane from '@/components/preview/PreviewPane.vue'
import TextView from '@/components/preview/TextView.vue'
import type { Block } from '@/render/blocks'
import type { PaginatedPage } from '@/render/paginate'
import { DENSITY, type Density } from '@/schema'

type ViewMode = 'split' | 'editor' | 'preview' | 'text'

const store = useResumeStore()

const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  split: '双栏',
  editor: '仅编辑',
  preview: '仅预览',
  text: '纯文本',
}
const VIEW_MODE_HINT: Record<ViewMode, string> = {
  split: 'Ctrl+1',
  editor: 'Ctrl+2',
  preview: 'Ctrl+3',
  text: 'Ctrl+4　可复制的纯文本，投递表单用',
}

const viewMode = ref<ViewMode>('split')
const zoom = ref(1)
const guides = ref(false)
const activeItemId = ref('')
/** 侧栏折叠状态，记住上次选择 */
const sidebarCollapsed = ref(localStorage.getItem('resume:sidebarCollapsed') === '1')
watch(sidebarCollapsed, (v) => localStorage.setItem('resume:sidebarCollapsed', v ? '1' : '0'))
const pageInfo = shallowRef<{ pages: PaginatedPage[]; overflowing: string[] }>({
  pages: [],
  overflowing: [],
})
const toast = ref('')
const exporting = ref(false)

/** 防抖后的 blocks，喂给预览 */
const debouncedBlocks = shallowRef<Block[]>([])
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => store.blocks,
  (next) => {
    if (debounceTimer) clearTimeout(debounceTimer)
    // 首次渲染不延迟，避免打开页面时白屏
    if (debouncedBlocks.value.length === 0) {
      debouncedBlocks.value = next as Block[]
      return
    }
    debounceTimer = setTimeout(() => {
      debouncedBlocks.value = store.blocks as Block[]
    }, 120)
  },
  { immediate: true },
)

const pageCount = computed(() => pageInfo.value.pages.length)
const lastFill = computed(() => {
  const pages = pageInfo.value.pages
  return pages.length ? Math.round(pages[pages.length - 1].fill * 100) : 0
})
const targetPages = computed(() => store.current?.position.layout.targetPages ?? 1)
const overTarget = computed(() => pageCount.value > targetPages.value)

function setTargetPages(value: number): void {
  if (!store.current) return
  store.current.position.layout.targetPages = value
  store.touchPosition()
}

/**
 * 末页填充率过低的提示。
 *
 * 目标 2 页但内容只填到第 2 页的 15%，视觉上就是"最后一页几乎空白"，
 * 通常比压成 1 页更难看。这个提示只在明显偏低时出现，避免唠叨。
 */
const sparseLastPage = computed(
  () => pageCount.value === targetPages.value && pageCount.value > 1 && lastFill.value < 25,
)

const densityOptions = Object.entries(DENSITY).map(([id, d]) => ({ id: id as Density, ...d }))
const densityWarning = computed(() => {
  const d = store.current?.position.density
  return d ? DENSITY[d]?.warning ?? '' : ''
})

function setDensity(value: string): void {
  if (!store.current) return
  store.current.position.density = value as Density
  store.touchPosition()
}

/**
 * 等下一次分页完成。autofit 每试一个系数都要等真实重排后的页数。
 *
 * 必须带超时兜底：某个缩放系数若产生完全相同的布局，PreviewPane 不会重新
 * emit，watch 永远不触发 —— 没有超时的话 autoFit 会卡死在「压缩中…」，
 * 且 fitting 标志永不复位，按钮再也点不动。
 */
function nextPagination(timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      stop()
      clearTimeout(timer)
      resolve()
    }
    const stop = watch(pageInfo, finish)
    const timer = setTimeout(finish, timeoutMs)
  })
}

const fitting = ref(false)
const fitScale = computed(() => store.current?.position.fitScale ?? 1)

/**
 * autofit 尝试的缩放序列，从不缩放开始逐档下探。
 * 下限 0.9 是可读性红线：正文 10.95pt 缩到 90% 约 9.9pt，再小在打印稿上就吃力了。
 * 宁可如实报告装不下，也不悄悄缩到 8pt 让用户投出一份看不清的简历。
 */
const FIT_SCALES = [1, 0.98, 0.96, 0.94, 0.92, 0.9] as const
const MIN_FIT_SCALE = FIT_SCALES[FIT_SCALES.length - 1]

/**
 * 压到目标页数。
 *
 * 从 1.0 往下线性扫，取第一个装得下的系数 —— 不用二分：文字重排后页数并非
 * 严格单调（少一行可能让某个 keep-with-next 链整体挪页），线性扫描才能
 * 可靠地拿到「最大的可行系数」。步长 0.02，最多 6 步，每步约 50ms。
 */
async function autoFit(): Promise<void> {
  const pos = store.current?.position
  if (!pos || fitting.value) return
  const target = pos.layout.targetPages

  fitting.value = true
  const original = pos.fitScale
  try {
    for (const scale of FIT_SCALES) {
      pos.fitScale = scale
      // 等防抖（120ms）+ 重排完成
      await new Promise((r) => setTimeout(r, 140))
      await nextPagination()
      if (pageInfo.value.pages.length <= target) {
        store.touchPosition()
        const now = pageInfo.value.pages.length
        toast.value =
          scale === 1
            ? `已经是 ${now} 页（目标 ${target} 页），无需压缩`
            : `已压到 ${now} 页（等比缩放 ${Math.round(scale * 100)}%）`
        return
      }
    }
    /*
     * 压到下限仍装不下。还原，并把"还差多少"量化出来 —— 光说"装不下"没用，
     * 用户需要知道是差两行还是差半页，才好决定删什么。
     * 末页填充率就是这个量：它等于超出目标的那部分内容占一页的比例。
     */
    const stuckAt = pageInfo.value.pages.length
    const overflowPct = Math.max(1, Math.round(pageInfo.value.pages[stuckAt - 1].fill * 100))
    pos.fitScale = original
    store.touchPosition()
    await new Promise((r) => setTimeout(r, 140))
    toast.value =
      `缩到 ${Math.round(MIN_FIT_SCALE * 100)}% 仍需 ${stuckAt} 页（末页占 ${overflowPct}%），已还原。` +
      `继续缩会伤可读性 —— 建议隐藏约 ${overflowPct}% 一页的内容（要点、论文档位降到「紧凑」），` +
      `或把目标改成 ${stuckAt} 页。`
  } finally {
    fitting.value = false
    setTimeout(() => {
      if (!fitting.value && toast.value.includes('页')) toast.value = ''
    }, 8000)
  }
}

function resetFit(): void {
  if (!store.current) return
  store.current.position.fitScale = 1
  store.touchPosition()
}

async function doExport(): Promise<void> {
  if (!store.current) return
  exporting.value = true
  toast.value = '正在导出…'
  try {
    const result = await store.exportPdf()
    toast.value = result.warning
      ? `已导出 ${result.filename}，但 ${result.warning}`
      : `已导出 ${result.filename}（${result.pages} 页，${(result.bytes / 1024).toFixed(0)} KB，${result.ms}ms）`
    // 触发浏览器下载：端口转发场景下这是拿到文件的唯一途径
    const url = `/api/positions/${encodeURIComponent(store.currentId)}/pdf?name=${encodeURIComponent(result.filename)}`
    const a = document.createElement('a')
    a.href = url
    a.download = result.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    toast.value = `导出失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    exporting.value = false
    setTimeout(() => {
      if (!exporting.value) toast.value = ''
    }, 6000)
  }
}

function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  if (e.key === 's') {
    e.preventDefault()
    void store.flush()
    toast.value = '已保存'
    setTimeout(() => {
      // 只清掉自己这条提示，别把后来的错误信息也吞掉
      if (toast.value === '已保存') toast.value = ''
    }, 1500)
  }
  if (e.key === 'b') {
    e.preventDefault()
    sidebarCollapsed.value = !sidebarCollapsed.value
  }
  if (e.key === '1') {
    e.preventDefault()
    viewMode.value = 'split'
  }
  if (e.key === '2') {
    e.preventDefault()
    viewMode.value = 'editor'
  }
  if (e.key === '3') {
    e.preventDefault()
    viewMode.value = 'preview'
  }
  if (e.key === '4') {
    e.preventDefault()
    viewMode.value = 'text'
  }
}

onMounted(() => {
  void store.load()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', (e) => {
    if (store.dirty) {
      void store.flush()
      e.preventDefault()
    }
  })
})
</script>

<template>
  <div class="shell" :class="{ 'shell-collapsed': sidebarCollapsed }">
    <PositionSidebar v-model:collapsed="sidebarCollapsed" />

    <main class="main">
      <header class="toolbar">
        <div class="seg">
          <button
            v-for="mode in (['split', 'editor', 'preview', 'text'] as ViewMode[])"
            :key="mode"
            class="seg-btn"
            :class="{ active: viewMode === mode }"
            :title="VIEW_MODE_HINT[mode]"
            @click="viewMode = mode"
          >
            {{ VIEW_MODE_LABEL[mode] }}
          </button>
        </div>

        <div class="stat" :class="{ 'stat-warn': overTarget }">
          <strong>{{ pageCount }}</strong> 页
          <span class="stat-sep">·</span>
          末页填充 <strong>{{ lastFill }}%</strong>
          <span v-if="overTarget" class="tag tag-warn">
            超出目标 {{ targetPages }} 页
          </span>
          <span v-else-if="sparseLastPage" class="tag tag-muted" title="末页大片留白，考虑压成更少页数">
            末页偏空
          </span>
          <span v-if="pageInfo.overflowing.length" class="tag tag-danger">
            {{ pageInfo.overflowing.length }} 块超页高
          </span>
        </div>

        <label class="ctl">
          目标篇幅
          <select
            class="field-select ctl-select"
            :value="targetPages"
            title="「压到 N 页」的目标，也决定何时提示「超出目标」"
            @change="setTargetPages(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="n in 4" :key="n" :value="n">{{ n }} 页</option>
          </select>
        </label>

        <label class="ctl">
          密度
          <select
            class="field-select ctl-select"
            :value="store.current?.position.density ?? 'standard'"
            @change="setDensity(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="d in densityOptions" :key="d.id" :value="d.id">{{ d.label }}</option>
          </select>
        </label>

        <button
          class="btn"
          :disabled="fitting || !store.current"
          :title="
            overTarget
              ? `等比压缩字号与间距，直到装进 ${targetPages} 页；压到 90% 仍装不下会还原并给出建议`
              : `当前 ${pageCount} 页，已在目标 ${targetPages} 页之内`
          "
          @click="autoFit"
        >
          {{ fitting ? '压缩中…' : overTarget ? `压到 ${targetPages} 页` : '已达标' }}
        </button>
        <button
          v-if="fitScale < 1"
          class="btn btn-ghost btn-sm"
          title="取消 autofit 缩放"
          @click="resetFit"
        >
          {{ Math.round(fitScale * 100) }}% ↺
        </button>

        <label class="ctl">
          缩放
          <input
            v-model.number="zoom"
            class="ctl-range"
            type="range"
            min="0.5"
            max="1.6"
            step="0.05"
          />
          <span class="ctl-value">{{ Math.round(zoom * 100) }}%</span>
        </label>

        <label class="ctl ctl-check">
          <input v-model="guides" type="checkbox" />
          参考线
        </label>

        <div class="spacer" />

        <span v-if="store.saving" class="tag tag-muted">保存中…</span>
        <span v-else-if="store.dirty" class="tag tag-warn">未保存</span>

        <button class="btn btn-primary" :disabled="exporting || !store.current" @click="doExport">
          导出 PDF
        </button>
      </header>

      <div v-if="densityWarning" class="banner banner-warn">{{ densityWarning }}</div>
      <div v-if="store.error" class="banner banner-error">{{ store.error }}</div>
      <div v-for="w in store.warnings" :key="w" class="banner banner-warn">{{ w }}</div>
      <div v-if="toast" class="banner banner-info">{{ toast }}</div>

      <div v-if="store.loading" class="placeholder">加载中…</div>

      <div v-else-if="viewMode === 'text'" class="panes" data-mode="text">
        <section class="pane pane-text">
          <TextView :blocks="debouncedBlocks" />
        </section>
      </div>

      <div v-else class="panes" :data-mode="viewMode">
        <section v-if="viewMode !== 'preview'" class="pane pane-editor">
          <EditorPane v-model:active-item-id="activeItemId" />
        </section>

        <section v-if="viewMode !== 'editor'" class="pane pane-preview">
          <PreviewPane
            v-if="store.resolved"
            :resume="store.resolved"
            :blocks="debouncedBlocks"
            :zoom="zoom"
            :guides="guides"
            :active-item-id="activeItemId"
            @paginated="pageInfo = $event"
            @pick="activeItemId = $event"
          />
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 232px 1fr;
  height: 100%;
  overflow: hidden;
  transition: grid-template-columns 0.16s ease;
}
/* 收起后留一条 46px 的轨道，仍能点岗位方块切换 */
.shell-collapsed {
  grid-template-columns: 46px 1fr;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
  background: var(--ui-panel);
  border-bottom: 1px solid var(--ui-border);
  flex: 0 0 auto;
  flex-wrap: wrap;
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

.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-muted);
  font-variant-numeric: tabular-nums;
}
.stat strong {
  color: var(--ui-text);
}
.stat-warn strong {
  color: var(--ui-warn);
}
.stat-sep {
  color: var(--ui-border-strong);
}

.ctl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-muted);
}
.ctl-select {
  width: auto;
  padding: 3px 6px;
}
.ctl-range {
  width: 92px;
}
.ctl-value {
  min-width: 34px;
  font-variant-numeric: tabular-nums;
}
.ctl-check {
  gap: 4px;
}

.spacer {
  flex: 1 1 auto;
}

.banner {
  padding: 6px 14px;
  font-size: 12px;
  border-bottom: 1px solid var(--ui-border);
  flex: 0 0 auto;
}
.banner-warn {
  background: #fdf6e6;
  color: var(--ui-warn);
}
.banner-error {
  background: #fdeeee;
  color: var(--ui-danger);
}
.banner-info {
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}

.placeholder {
  padding: 32px;
  color: var(--ui-muted);
}

.panes {
  display: grid;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.panes[data-mode='split'] {
  grid-template-columns: minmax(360px, 1fr) minmax(420px, 1.15fr);
}
.panes[data-mode='editor'],
.panes[data-mode='preview'],
.panes[data-mode='text'] {
  grid-template-columns: 1fr;
}

.pane {
  min-width: 0;
  overflow: auto;
}
.pane-editor {
  background: var(--ui-panel);
  border-right: 1px solid var(--ui-border);
}
/*
 * 预览区底色刻意压得很淡且偏中性：简历页面是纯白的，
 * 周围铺太饱和的蓝会影响对纸面颜色与灰阶的判断。
 */
.pane-preview {
  background: #dde7ef;
}
.pane-text {
  background: var(--ui-bg);
  overflow: hidden;
}
</style>
