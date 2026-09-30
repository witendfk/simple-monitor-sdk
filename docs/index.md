---
layout: home
hero:
  name: Simple Monitor
  tagline: 前端错误与性能监控 SDK，配套服务端、看板和告警演示链路
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 架构与 ADR
      link: /guide/architecture
features:
  - title: 采集 SDK
    details: 六类错误 + 自研 Web Vitals（oracle 一致性测试）+ 面包屑 + 基础隐私脱敏；已知边界见服务端指南与开发总纲
  - title: 可靠传输
    details: 批量信封 / gzip / 指数退避 / IndexedDB 缓存 / sendBeacon 通道状态机 / 采样；重放失败可能丢数据
  - title: 服务端平台
    details: 协议校验 / Redis Stream 削峰 / ClickHouse 存储 + 物化视图 / SourceMap 符号化 / 告警
---
