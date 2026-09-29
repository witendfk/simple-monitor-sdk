import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    proxy: {
      // 看板与 API 同源开发：/api 代理到服务端（内存或基础设施形态均可）
      '/api': 'http://localhost:3000',
    },
  },
})
