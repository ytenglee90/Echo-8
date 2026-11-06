# Echo-8 开发与交接

在包含 `package.json` 和 `AGENTS.md` 的 `infinite-canvas/` 目录工作。开始前阅读 `AGENTS.md`、`.agents/skills/infinite-canvas-architecture/SKILL.md`、相关参考协议与 ADR。`GEMINI.md` 和 `.agents/rules` 仅为工具入口，架构规则统一由仓库内技能维护；不再维护工作区外的规则副本。

## 环境与安装

需要 Node.js >=22.13.0 和 `package.json` 指定的 pnpm。依赖以 `pnpm-lock.yaml` 为准：

```powershell
pnpm install --frozen-lockfile
pnpm run dev
```

原生依赖构建许可集中在 `pnpm-workspace.yaml`，不向未知依赖开放构建脚本。

## 换设备后继续使用 Codex

可以从 GitHub 克隆，或解压本次开发交接包。交接包中的 `Echo-8/` 是干净的 Git 仓库，包含完整提交历史、源码、锁文件、仓库内架构技能、测试、迁移、许可证和便携成品；不包含依赖、本机书籍、浏览器数据、登录凭据或构建缓存。

```powershell
git clone https://github.com/ytenglee90/Echo-8.git
cd Echo-8
git status --short
git log -1 --oneline
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm exec playwright install chromium firefox webkit
pnpm run dev
```

解压方式从 `cd Echo-8` 开始即可，不必再次克隆。使用 Node.js >=22.13.0、pnpm 11.19.0；缺少指定 pnpm 时可先运行 `npm install --global pnpm@11.19.0`。Linux 浏览器运行库缺失时使用 `pnpm exec playwright install --with-deps chromium firefox webkit`。依赖和浏览器需要在新设备重新安装，不复制旧设备的 `node_modules`。

在 Codex 中打开解压或克隆后的 `Echo-8/` 文件夹，先让它读取 `AGENTS.md` 和本文，再读取 `docs/HANDOFF-2026-11-06.md` 获取本次验收状态。项目规则与技能随仓库携带；后续开发仍在同一源码目录中进行。GitHub 推送身份、Cloudflare 身份和本机环境变量需要在新设备独立配置，环境变量格式见 `.env.example`、`.dev.vars.example`，部署见项目内 Cloudflare 文档。

源码交接包不迁移画布书籍或浏览器恢复副本；书籍通过正式保存的 `.echo8` 文件或既有云同步单独转移。个人 AI 配置同样不随源码分发。

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
