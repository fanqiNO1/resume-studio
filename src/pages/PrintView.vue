<script setup lang="ts">
/**
 * 打印页：Playwright 加载这个路由生成 PDF。
 *
 * 与工作台共用 PreviewPane、同一套 CSS、同一批字体、同一个分页器 ——
 * 这是「渲染契约」的核心（docs/DESIGN.md §2.5、AGENTS.md §4）。
 * 差别只有：不渲染任何屏幕装饰，缩放固定为 1，完成后置 __RESUME_READY__。
 */
import { onMounted, ref } from 'vue'
import { useResumeStore } from '@/stores/resume'
import PreviewPane from '@/components/preview/PreviewPane.vue'

const store = useResumeStore()
const failed = ref('')

onMounted(async () => {
  document.body.setAttribute('data-export', '1')
  const id = new URLSearchParams(window.location.search).get('position') ?? ''
  await store.load()
  if (store.error) {
    failed.value = store.error
    return
  }
  if (id && store.positions.some((p) => p.id === id)) {
    store.currentId = id
  } else if (id) {
    failed.value = `找不到岗位：${id}`
  }
})
</script>

<template>
  <div v-if="failed" class="print-error">{{ failed }}</div>
  <PreviewPane
    v-else-if="store.resolved && store.blocks.length"
    :resume="store.resolved"
    :blocks="store.blocks"
    :zoom="1"
    export-mode
  />
</template>

<style scoped>
.print-error {
  padding: 24px;
  font: 14px/1.6 monospace;
  color: #b91c1c;
}
</style>
