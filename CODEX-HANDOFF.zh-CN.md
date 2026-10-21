# Echo-8：Codex 跨电脑开发交接

这个压缩包用于在另一台电脑上通过 Codex 桌面端、Codex IDE 扩展或 Codex CLI 继续开发 Echo-8。

## Codex 会自动读取什么

- 根目录 `AGENTS.md`：Echo-8 的强制开发规则。Codex 在开始工作前会自动读取。
- `.agents/skills/infinite-canvas-architecture/SKILL.md`：项目专用架构技能。Codex 会从仓库的 `.agents/skills` 自动发现。
- `docs/ARCHITECTURE.md` 和 `docs/ADR-*.md`：架构现状和重要设计决策。

官方说明：

- <https://developers.openai.com/codex/guides/agents-md>
- <https://developers.openai.com/codex/skills>

因此不需要把技能安装到另一台电脑的个人 `.codex` 目录，也不要随包发送个人 Codex 配置、登录信息或会话记录。

## 第一次打开

1. 完整解压压缩包。
2. 在 Codex 中打开同时包含 `package.json`、`AGENTS.md` 和 `.agents` 的项目根目录。
3. 如果使用 Codex CLI，从项目根目录启动，或者使用 `codex --cd <项目目录>`。
4. 第一次对话建议输入：

```text
请先完整阅读 AGENTS.md，并使用 $infinite-canvas-architecture 技能。只审查当前架构、测试和运行方式，先不要修改代码。
```

如果技能没有立即出现在选择器中，确认当前工作目录正确后重启 Codex。Codex 会在新会话开始时重新建立项目指令链。

## 环境与依赖

- Node.js：`>= 22.13.0`
- 依赖锁文件：`pnpm-lock.yaml`

安装依赖并启动：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run dev
```

如果本机没有 Corepack，可先安装 pnpm。如果 pnpm 提示构建脚本被拦截，运行 `pnpm approve-builds`，只审核锁文件中的 `esbuild`、`sharp`、`unrs-resolver` 和 `workerd`，确认来源后再允许。

`node_modules` 没有放进交接包，因为它体积大、可能包含与原电脑系统相关的原生文件，并且可以根据锁文件准确恢复。

## 修改后的统一验收

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm exec playwright install chromium
pnpm run test:e2e
pnpm run build:portable
pnpm run test:portable
```

最终便携单 HTML 输出到 `artifacts/Echo-8.html`。不要直接修改这个生成文件。

2026-09-30 打包时的基准状态：TypeScript、ESLint、322 项内核/功能测试、34 项 Chromium 界面回归和 1 项 `file://` 便携版回归通过；便携单 HTML 已从当前源码重新生成。

## 主要目录

- `src/core`：微内核与强制系统服务。
- `src/protocols`：公开协议和强类型契约。
- `src/plugins`：功能插件。
- `src/ui`、`src/shell`：受治理的 UI 基础与应用外壳。
- `src/workers`：由内核管理的后台 Worker。
- `tests`：架构、协议、功能、性能和恢复测试。
- `docs`：架构说明、文件格式、性能预算和 ADR。
- `scripts`：数据生成、压力夹具和单 HTML 构建脚本。
- `.agents/skills`：随项目分发、由 Codex 自动发现的架构技能。

## 不在交接包里的内容

- `node_modules`
- 构建缓存和临时目录
- 浏览器 IndexedDB、恢复日志和个人画布
- Codex 登录信息、会话记录、个人目标和全局配置
- AI平台KEY、Token和密码
- `artifacts/Echo-8-AI-个人配置.txt`（本机导出的模型连接与明文 KEY）
- 已生成的暴力测试大文件；需要时运行 `pnpm run fixture:brutal`
