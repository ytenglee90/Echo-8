# Echo-8 开发与交接

在包含 `package.json` 和 `AGENTS.md` 的 `infinite-canvas/` 目录工作。开始前阅读 `AGENTS.md`、`.agents/skills/infinite-canvas-architecture/SKILL.md`、相关参考协议与 ADR。`GEMINI.md` 和 `.agents/rules` 仅为工具入口，架构规则统一由仓库内技能维护；不再维护工作区外的规则副本。

## 环境与安装

需要 Node.js >=22.13.0 和 `package.json` 指定的 pnpm。依赖以 `pnpm-lock.yaml` 为准：

```powershell
pnpm install --frozen-lockfile
pnpm run dev
```

原生依赖构建许可集中在 `pnpm-workspace.yaml`，不向未知依赖开放构建脚本。

## 验收与交付

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm exec playwright install chromium firefox webkit
pnpm run test:e2e
pnpm run test:performance-browser
pnpm run build
pnpm run build:portable
pnpm run test:portable
pnpm run test:cross-browser
```

当前验收结果以本次运行记录为准，不沿用旧交接包的测试数量。单 HTML 只能从源码构建，输出到 `artifacts/Echo-8.html`，连同纠错规则与 SHA256 清单分发；不直接修改生成文件。Cloudflare 部署步骤见 [部署说明](CLOUDFLARE-BYOC-DEPLOYMENT.zh-CN.md)。

`src/core` 拥有协调服务，`src/protocols` 拥有公开数据契约，`src/plugins` 拥有功能，`src/ui` 与 `src/shell` 拥有受治理界面。测试位于 `tests`、`e2e`、`portable-e2e`、`browser-performance`；构建与夹具脚本位于 `scripts`。

## 本机资料与清理

`local-data/` 只用于本机书籍、个人连接及数据库备份，全部排除于 Git 和发布产物。API Key、浏览器本地数据库、授权句柄、个人配置和会话记录不可放入源码或交接包。依赖、构建缓存与测试诊断可再生成；源码、迁移、许可证和未知插件兼容逻辑不能按“重复文件”删除。

压力夹具按需运行 `pnpm run fixture:brutal` 与 `pnpm run verify:brutal`，不随源码仓库分发。项目工作区规则以 `.agents/skills/` 为唯一维护源。
