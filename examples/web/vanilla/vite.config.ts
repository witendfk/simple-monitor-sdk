import { defineConfig } from 'vite'
import { resolve } from 'path'

// M1 demo 的 vite 配置
// 通过 alias 直接引入各包源码（无需预先 build），改 SDK 代码即时生效。
const pkgs = (name: string) => resolve(__dirname, `../../../packages/${name}/src/index.ts`)

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@simple-monitor/web': pkgs('web'),
      '@simple-monitor/browser': pkgs('browser'),
      '@simple-monitor/web-performance': pkgs('web-performance'),
      '@simple-monitor/vue': pkgs('vue'),
      '@simple-monitor/react': pkgs('react'),
      '@simple-monitor/core': pkgs('core'),
      '@simple-monitor/shared': pkgs('shared'),
      '@simple-monitor/utils': pkgs('utils'),
      '@simple-monitor/types': pkgs('types'),
    },
  },
  server: {
    port: 5180,
    host: true,
  },
})
