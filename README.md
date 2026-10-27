# Echo-8

一个可直接携带的单 HTML 无限画布，同时保留可维护的微内核与内置插件源码。

## 直接使用

打开 `artifacts/Echo-8.html`。它不引用外部脚本、样式或字体。纠错内容单独保存在同目录的 `Echo-8-text-assist-rules.txt`；直接双击 HTML 时，按画布中央上方的“纠错规则尚未导入”提示选择该文件即可。成功导入后，完整规则会保存在当前浏览器的独立本机资源库中，后续启动不再要求重新选择；换浏览器、移动到另一站点来源或清理站点数据后需要重新导入，命令面板中的“从 TXT 更新纠错规则”可覆盖本机副本。

便携单 HTML 每次重新打开都从新的空画布开始，正式保存依赖带校验和的 `.echo8` 书籍文件；托管版会恢复当前浏览器的 IndexedDB 副本，并可选择连接用户自己的 Cloudflare Worker、D1 与 R2，在其他设备继续编辑。也可以把 `.echo8`（兼容误写 `.eco8`）直接拖入画布打开。当前书籍有未保存修改时，“打开书籍”会先在顶部询问保存或不保存；拖入书籍文件时也使用同一裁决。

公开 BYOC 部署、OAuth 权限、数据库迁移与跨设备验收见 [`docs/CLOUDFLARE-BYOC-DEPLOYMENT.zh-CN.md`](docs/CLOUDFLARE-BYOC-DEPLOYMENT.zh-CN.md)。

## 架构纪律

- 用户操作只能发送公开指令，经过消息路由、权限校验和事务提交后再广播事件。
- 插件之间不导入实现；跨插件协作只通过带版本的能力、指令、事件和查询。
- 文档状态、个人工作区状态、临时预览和派生数据分域存储。
- 所有持久修改共享一条全局撤销时间线；拖动、缩放和连续输入只在边界提交正式事务。
- UI 通过统一插槽、主题、焦点、快捷键和独占表面栈注入。
- 长正文分成独立 64 KiB 块；编辑器只挂载窗口范围；节点、连线和群组都做可视区裁剪。
- AI 检索按预算提取相关片段并显示实际来源；普通回答只进入独立对话，明确编辑一个节点时才生成可审阅、可撤销的写回提案。

完整边界、协议和设计决策见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`docs/ADR-INDEX.md`](docs/ADR-INDEX.md)。

## 开发与验收

```powershell
pnpm run dev
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm exec playwright install chromium
pnpm run test:e2e
pnpm run test:performance-browser
pnpm run build:portable
pnpm run test:portable
```

也可以运行 `pnpm run verify` 执行日常完整门禁。正式发布或修改编辑兼容性时，再执行 `pnpm exec playwright install firefox webkit` 与 `pnpm run test:cross-browser`。便携构建输出 `artifacts/Echo-8.html` 和同目录的 `artifacts/Echo-8-text-assist-rules.txt`。架构测试会阻止插件跨实现导入、核心依赖功能插件、模型层加载 React、绕过受控网络/后台任务和使用非托管持久化；浏览器回归会检查插件声明、关键命令、输入法、补全边界、编辑器、浮窗、管理面板，并直接通过 `file://` 打开最终单 HTML。

## 暴力测试夹具

`npm run fixture:brutal` 会流式生成 `artifacts/Echo-8-Brutal-2000.echo8`，包含2000个文本节点、2.199亿正文字符、8000条跨距连线和200个群组。生成器拒绝覆盖已有夹具；需要重建时请先明确移走旧文件。`npm run verify:brutal` 使用应用正式解析器复核CRC、正文分块、引用完整性和群组互斥关系。
