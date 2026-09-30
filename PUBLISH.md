# 发布流程（PUBLISH）

> 前置：npm 账号 + `NPM_TOKEN`（GitHub Actions secrets）或本地 `npm login`。
> 本文是唯一发布入口文档；`changesets` 管版本与 changelog。provenance **尚未启用**（规划：CI 发布 job 落地时加 `NPM_CONFIG_PROVENANCE: true` + `id-token: write` 权限，见总纲 §3.7）。

## 一、日常发布（三步）

```bash
# 1. 生成变更集（交互式选择包与 bump 类型）
pnpm changeset

# 2. 消费变更集 → 更新各包版本 + CHANGELOG（会生成/更新 lockfile，提交它）
pnpm changeset version
git add . && git commit -m "chore: version packages"

# 3. 构建 + 发布（prepublishOnly 已挂 build）
pnpm release
```

`pnpm release` = `pnpm build && pnpm -r --filter "./packages/*" publish --access public --no-git-checks`（根 package.json）。发布范围：`packages/*`（9 个 SDK 包，`private` 未设置）；**apps/* 不发布**（server/dashboard 已标 private）。

> 不用 `changeset publish` 发布：其底层走 npm publish，不解析 `workspace:*` 协议（见 §五实测结论）。

## 二、首次发布检查单

- [ ] 各包 `package.json`：`name` 带 `@simple-monitor` scope、`repository` 指向本仓库、`files` 只含 `dist`
- [ ] `pnpm build` 全绿（发布前强制构建，防发空包）
- [ ] npm 侧创建 `simple-monitor` 组织（scope 归属）
- [ ] 首版给 publish 加 next 标签观察：`pnpm -r --filter "./packages/*" publish --access public --tag next --no-git-checks`，稳定后再 latest
- [ ] CI 已配置 `NPM_TOKEN` secret（.github/workflows，release job 可选）

## 三、CI 自动发布（可选，推荐）

合入 master 时自动发布：workflow 里

```yaml
- run: pnpm release
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`changesets/action` 亦可（自动开 "Version Packages" PR）。

## 四、发布后验证

```bash
npm view @simple-monitor/web versions      # 版本存在
npm i @simple-monitor/web                  # 干净项目安装
# 15 分钟接入验证：按文档站快速开始跑通 init({dsn, apikey})
```

## 附：本地产物验证（不发布也能验证）

```bash
pnpm build && pnpm pack:all    # 产物统一输出到 release/*.tgz（自动清旧）
# 任意空目录里装本地产物（等价于真实发布物）：
npm i /path/to/sdk/release/simple-monitor-web-0.1.0.tgz \
      /path/to/sdk/release/simple-monitor-core-0.1.0.tgz \
      ...（其余依赖包一并列出）
```

框架适配走子路径导入（主入口零框架依赖）：

```ts
import { init } from '@simple-monitor/web'
import { MonitorVue } from '@simple-monitor/web/vue'      // Vue 项目
import { ErrorBoundary } from '@simple-monitor/web/react' // React 项目
```

## 五、当前状态（打包链路已验证，质量风险待关闭）

- [x] changesets 配置：`access: public`（scoped 包必须）/ `baseBranch: master`
- [x] 首版 changeset 已消费：全包 0.0.1 → **0.1.0** + CHANGELOG 已生成
- [x] `pnpm pack` 实测：**workspace:\* 协议在打包时解析为真实版本**（0.1.0，无残留）——
  发布脚本因此用 `pnpm -r publish`（npm publish 不解析 workspace 协议，勿改回）
- [x] 九包 repository 字段齐（provenance 前提；provenance 本身未启用）；apps/* 已标 private 不发布
- [x] 根 `release` 脚本 = `pnpm build && pnpm -r --filter "./packages/*" publish --access public --no-git-checks`
- [ ] 对外发布前处理错误消息脱敏与离线重放丢数风险，并按 [开发总纲 §3.8](./开发总纲.md) 的验收条件复测。服务端另需分离公开上报 key 与管理权限、封闭 Webhook SSRF 路径，才能用于公网多项目部署
- [ ] npm 侧创建 `simple-monitor` 组织并登录后执行 `pnpm release`；目前尚未实际发布
- [ ] 发布后：文档站部署（`pnpm docs:build` 产物在 `docs/.vitepress/dist`）+ 陌生人 15 分钟验收
