import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// workspace 包名 → 源码入口（与 demo 的 vite.config 一致，免预先 build）
const pkgs = (name: string) => resolve(process.cwd(), `packages/${name}/src`)

export default defineConfig({
  resolve: {
    alias: {
      '@simple-monitor/protocol': pkgs('protocol'),
      '@simple-monitor/types': pkgs('types'),
      '@simple-monitor/shared': pkgs('shared'),
      '@simple-monitor/utils': pkgs('utils'),
      '@simple-monitor/core': pkgs('core'),
    },
  },
})
