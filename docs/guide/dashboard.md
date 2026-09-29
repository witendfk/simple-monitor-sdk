# 看板

```bash
pnpm --filter @simple-monitor/dashboard dev   # :5190，/api 代理到 :3000
```

视图：概览（统计卡+Top 错误）/ 错误列表（发版过滤+新错误回归徽标）/
错误详情（符号化堆栈+面包屑时间线）/ 性能分位 / 告警（规则管理+触发记录）。
