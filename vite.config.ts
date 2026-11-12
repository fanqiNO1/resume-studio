import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { dataApiPlugin } from './server/vite-plugin-data'

export default defineConfig({
  plugins: [vue(), dataApiPlugin()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    /*
     * 只监听回环地址，不暴露到局域网。
     *
     * 写成 '127.0.0.1' 而不是 'localhost'：Node 的 listen() 只会绑定 localhost
     * 解析出的第一个地址，新版 Node 默认 IPv6 优先，可能只绑到 ::1 —— 那样
     * server/export.ts 里 Playwright 访问的 http://127.0.0.1:<port> 会连不上。
     *
     * 这不影响端口转发：ssh -L 是在远端连本机的回环地址，仍然通。
     * 真要开局域网访问，临时加 --host 即可（vite --host）。
     */
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    fs: { allow: ['..'] },
    /*
     * 不监听软删除归档。
     *
     * 每次写入都会往 data/.trash/autosave/ 落一份旧内容，几天就是几百个文件，
     * 而 Vite 默认会给每个文件挂一个 inotify watch —— 实测把系统 watcher 配额
     * 耗尽后，dev server 直接以 ENOSPC 崩在启动阶段。
     * 归档只供本地手工恢复，改动它不需要触发热更新。
     */
    watch: { ignored: ['**/data/.trash/**'] },
  },
})
