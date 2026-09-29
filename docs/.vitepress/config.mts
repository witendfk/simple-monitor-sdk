import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Simple Monitor',
  description: '自研前端监控：采集 SDK + 服务端平台 + 看板',
  themeConfig: {
    nav: [
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '配置', link: '/guide/configuration' },
      { text: '架构', link: '/guide/architecture' },
      { text: '服务端', link: '/guide/server' },
      { text: '发布', link: '/guide/publish' },
    ],
    sidebar: {
      '/guide/': [
        { text: '指南', items: [
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '配置矩阵', link: '/guide/configuration' },
          { text: '告警', link: '/guide/alerts' },
        ]},
        { text: '深入', items: [
          { text: '架构与 ADR', link: '/guide/architecture' },
          { text: '服务端平台', link: '/guide/server' },
          { text: '看板', link: '/guide/dashboard' },
          { text: '发布流程', link: '/guide/publish' },
        ]},
      ],
    },
  },
})
