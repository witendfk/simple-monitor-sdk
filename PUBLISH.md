# 发布流程（PUBLISH）

> 前置：npm 账号 + `NPM_TOKEN`（GitHub Actions secrets）或本地 `npm login`。
> 本文是唯一发布入口文档；`changesets` 管版本与 changelog，`provenance` 提供发布溯源。

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

`pnpm release` = `pnpm build && changeset publish`（根 package.json）。发布范围：`packages/*`（9 个 SDK 包，`private` 未设置）；**apps/* 不发布**（server/dashboard 已标 private）。

## 二、首次发布检查单

- [ ] 各包 `package.json`：`name` 带 `@simple-monitor` scope、`repository` 指向本仓库、`files` 只含 `dist`
- [ ] `pnpm build` 全绿（发布前强制构建，防发空包）
- [ ] npm 侧创建 `simple-monitor` 组织（scope 归属）
- [ ] 首版用 `changeset publish --tag next` 打 next 标签观察，稳定后再 latest
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

## 五、当前状态

- [x] changesets 配置（.changeset/config.json）
- [x] 根 `release` 脚本 + `prepublishOnly` 钩子
- [x] 本文档
- [ ] **真实 npm 发布（需要账号操作，归属仓库所有者）**
- [ ] 文档站上线（docs/ vitepress，见 `pnpm docs:build`）
