import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react.ts',
    vue: 'src/vue.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2020',
  splitting: false,
  // react/vue 子路径内联适配器实现：web 不声明框架依赖，
  // 子路径仅外置 react 本身（用 React 的项目必然已安装）
  noExternal: ['@simple-monitor/react', '@simple-monitor/vue'],
  // react 必须外置：内联会造成双 React 实例（用户 app 的 hooks 与我们内置副本隔离即崩），
  // 正确语义是复用宿主项目的 React 单例
  external: ['react', 'react-dom', 'vue'],
})
