import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
// 字体在 index.html 里用 <link> 引入（public/ 下的 CSS 不能作为模块 import）
import './styles/base.css'
import './styles/resume.css'
import './styles/page.css'

createApp(App).use(createPinia()).mount('#app')
