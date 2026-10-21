# Echo-8：Antigravity IDE 开发交接

这个压缩包是 Echo-8 的完整开发源码，不是只有编译后单 HTML 的用户版本。

## 第一次打开

1. 解压后，在 Antigravity IDE 中直接打开包含 `package.json`、`AGENTS.md` 和 `.agents` 的项目根目录。
2. Antigravity 会读取根目录的 `AGENTS.md` / `GEMINI.md`，并发现 `.agents/rules` 与 `.agents/skills`。
3. 在 Customizations → Rules 中确认 `00-echo-8-architecture` 已出现，并将它设为 **Always On**。
4. 确认工作区技能 `infinite-canvas-architecture` 已出现。
5. 第一次对话建议输入：`先完整阅读 AGENTS.md 和 infinite-canvas-architecture 技能，只审查项目并汇报架构，不修改代码。`

Antigravity 官方规则说明：<https://antigravity.google/docs/rules-workflows/>

Antigravity 官方技能说明：<https://antigravity.google/docs/skills>

## 环境与启动

- Node.js：`>= 22.13.0`
- 包管理锁文件：`pnpm-lock.yaml`

安装并启动：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run dev
```

如果本机没有 Corepack，可先安装 pnpm，再执行 `pnpm install --frozen-lockfile`。如果 pnpm 首次安装时提示存在被拦截的构建脚本，运行 `pnpm approve-builds`，只审核锁文件中的 `esbuild`、`sharp`、`unrs-resolver` 和 `workerd`，确认来源后再允许；不要对未知依赖一键放行。

## 验证与单文件构建

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm exec playwright install chromium
pnpm run test:e2e
pnpm run build:portable
```

也可以在 Antigravity 中运行工作区工作流 `/verify-echo-8`。最终便携版本输出到 `artifacts/Echo-8.html`。

打包时的基准状态为：TypeScript、ESLint、150 项内核/功能测试和 5 项 Chromium 界面回归通过，便携单 HTML 已重新生成。

## 主要目录

- `src/core`：微内核与强制系统服务。
- `src/protocols`：跨模块公开协议和强类型契约。
- `src/plugins`：所有功能插件。
- `src/ui`、`src/shell`：受治理的 UI 基础和应用外壳。
- `src/workers`：由内核管理的后台 Worker 入口。
- `tests`：架构、协议、功能、性能和恢复测试。
- `docs`：架构说明、文件格式、性能预算和 ADR。
- `scripts`：生成数据、压力夹具和单 HTML 构建脚本。
- `.agents`：Antigravity 工作区规则、技能和工作流。

## 重要提醒

- 不要直接修改 `artifacts/Echo-8.html`，要修改 `src` 后重新构建。
- 不要把 API Key 写进源码、画布或成品。
- 不要通过删除测试、放宽断言或绕过公共消息总线来“修复”问题。
- `node_modules`、构建缓存、浏览器本地数据和个人密钥没有放进交接包；依赖应根据锁文件重新安装。
- 暴力测试文件默认不随包发送，可通过 `pnpm run fixture:brutal` 重新生成，再用 `pnpm run verify:brutal` 校验。
