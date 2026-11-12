<script setup lang="ts">
/**
 * 顶层路由。刻意不引 vue-router：只有两个视图（工作台 / 打印页），
 * 用 location.pathname 判断就够，少一个依赖。
 */
import { computed } from 'vue'
import AppView from './pages/AppView.vue'
import PrintView from './pages/PrintView.vue'

const isPrint = computed(() => window.location.pathname.startsWith('/print'))
</script>

<template>
  <PrintView v-if="isPrint" />
  <AppView v-else />
</template>
