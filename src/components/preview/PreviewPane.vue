<script setup lang="ts">
/**
 * 预览面板：测量 → 分页 → 渲染页面盒子。
 *
 * 流程刻意分两趟：
 *  1. 把全部 blocks 渲染进离屏容器（宽度 = 页内容区宽度），实测每块高度
 *  2. 用实测高度跑分页器，再按分页结果渲染可见的 .page
 *
 * 不能只渲染一趟然后就地测量：分页后每页首块的上间距要归零，就地测量会用
 * 错误的间距参与计算。两趟的代价很小（简历只有几十个块）。
 *
 * 离屏容器放在组件内部而不是 body 上，这样它自动继承同一份 CSS 变量与
 * .resume-root 样式 —— 测量环境与真实渲染环境必须完全一致。
 */
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import type { Block } from '@/render/blocks'
import type { ResolvedResume } from '@/render/resolve'
import { measureBlocks, waitForFonts } from '@/render/measure'
import { pageGeometry, paginate, type PaginatedPage } from '@/render/paginate'
import { buildStyleVars } from '@/render/tokens'
import BlockView from './BlockView'

const props = defineProps<{
  resume: ResolvedResume
  blocks: Block[]
  /** 缩放比例，1 = 100% */
  zoom?: number
  /** 高亮的条目（编辑器联动） */
  activeItemId?: string
  /** 显示内容区参考线 */
  guides?: boolean
  /** 导出模式：不渲染屏幕装饰，完成后置 window.__RESUME_READY__ */
  exportMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'paginated', payload: { pages: PaginatedPage[]; overflowing: string[] }): void
  (e: 'pick', itemId: string): void
}>()

const pages = shallowRef<PaginatedPage[]>([])
const measureHost = ref<HTMLElement | null>(null)

const style = computed(() => buildStyleVars(props.resume.metrics, props.resume.template))
const geometry = computed(() => pageGeometry(props.resume.metrics.margin))
const scale = computed(() => props.zoom ?? 1)

async function recompute(): Promise<void> {
  await waitForFonts()
  await nextTick()
  const host = measureHost.value
  if (!host) return

  const metrics = measureBlocks(host)
  const result = paginate(props.blocks, metrics, {
    contentHeight: geometry.value.contentHeightPt,
    onOverflow: (block, height) => {
      console.warn(
        `[paginate] 单块高度 ${height.toFixed(1)}pt 超过页内容区 ` +
          `${geometry.value.contentHeightPt.toFixed(1)}pt：${block.kind}#${block.id}`,
      )
    },
  })
  pages.value = result.pages
  emit('paginated', result)

  if (props.exportMode) {
    await nextTick()
    // 再等一帧，确保 .page 已完成布局，Playwright 才可以截 PDF
    requestAnimationFrame(() => {
      ;(window as unknown as { __RESUME_READY__?: boolean }).__RESUME_READY__ = true
    })
  }
}

// 这里不做防抖：调用方已经防抖，导出路径需要立即执行
watch(() => [props.blocks, geometry.value] as const, recompute)
onMounted(recompute)

function onStageClick(event: MouseEvent): void {
  const el = (event.target as HTMLElement)?.closest?.('[data-item-id]') as HTMLElement | null
  const itemId = el?.dataset.itemId
  if (itemId) emit('pick', itemId)
}
</script>

<template>
  <div class="preview-root">
    <div
      ref="measureHost"
      class="measure-host resume-root"
      :style="{ ...style.vars, width: `${geometry.contentWidthPx}px` }"
      v-bind="style.attrs"
      aria-hidden="true"
    >
      <BlockView v-for="b in blocks" :key="b.id" :block="b" />
    </div>

    <div class="preview-stage" @click="onStageClick">
      <div
        v-for="(page, pi) in pages"
        :key="pi"
        class="page-wrap"
        :style="{ width: `calc(210mm * ${scale})`, height: `calc(296.9mm * ${scale})` }"
      >
        <span class="page-label">第 {{ pi + 1 }} 页 · {{ Math.round(page.fill * 100) }}%</span>
        <div
          class="page resume-root"
          :style="{ ...style.vars, transform: `scale(${scale})` }"
          v-bind="style.attrs"
          :data-guides="guides ? 'true' : 'false'"
        >
          <BlockView
            v-for="(b, bi) in page.blocks"
            :key="b.id"
            :block="b"
            :at-page-top="bi === 0"
            :active="!exportMode && !!activeItemId && b.itemId === activeItemId"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-root {
  position: relative;
}

/*
 * 测量容器：必须产生布局（不能 display:none，那样量不到高度），
 * 但不可见、不可点、不占位。宽度由 JS 设为页内容区宽度。
 */
.measure-host {
  position: absolute;
  top: 0;
  left: -10000px;
  visibility: hidden;
  pointer-events: none;
  contain: layout style;
}

/* 缩放作用在 .page 上，transform-origin 置左上，外层 wrap 承担缩放后的尺寸 */
.page-wrap :deep(.page) {
  transform-origin: top left;
}
</style>
