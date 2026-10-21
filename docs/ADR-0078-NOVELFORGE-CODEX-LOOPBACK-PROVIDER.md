# ADR-0078：NovelForge Codex 回环 Provider

## 状态

已采纳 — 2026-10-20；**部分被 ADR-0079 替代**。本 ADR 的回环、官方 App Server 映射、不可提权与 Runtime 权威边界继续有效；“由 MCP 拥有生命周期、令牌仅页面会话有效”由 ADR-0079 的用户级持久连接器取代。

## 问题

NovelForge 文件交换能安全投影视觉节点和提交待审改动，但不能满足作者在画布现有 AI 输入框里实时控制自己 Codex 的需求。浏览器不能自行启动本机进程，也不能得到 Codex 登录凭据；直接把 App Server WebSocket 暴露给任意网页会放大权限面，另造一套聊天窗口又会复制 AI 转录、取消、重试、Provider 和提案逻辑。

## 决定

1. 画布不新增聊天实现。`ai-provider` 增加“NovelForge Codex（本机）”OpenAI 兼容范本，继续使用现有 `ai.generate.stream@1`、任务取消、转录和提案边界。
2. 本机适配由 NovelForge Engine 的 MCP 生命周期拥有。作者先在 Codex 中显式启动；它只监听 `127.0.0.1`，不安装 Windows 服务，不绑定局域网，也不要求画布登录 Cloudflare。
3. 启动生成高熵 Bearer 配对令牌。令牌在 Canvas 中标记为 `session-only`，不会进入个人配置偏好、TXT 备份、画布文档、恢复、便携文件或云同步；MCP 重启后旧令牌自然失效。
4. 浏览器通过 `OPTIONS` 完成 CORS/Private Network Access 预检，再调用受令牌保护的 OpenAI 兼容 SSE 端点。可选 origin 白名单进一步限制网站来源；`Origin: null` 被拒绝，因此直接互联只面向 HTTP(S) 托管版。
5. 桥接把请求映射到官方 Codex App Server 的 `initialize`、ephemeral `thread/start`、`turn/start`、`item/agentMessage/delta`、`turn/completed` 和 `turn/interrupt`。实际 Codex 账户、模型和插件仍由用户本机配置拥有。
6. Canvas 系统协议作为附加开发指令传递；对话、节点和记忆按带角色标签的不可信资料传递。桥接前置不可覆盖的 NovelForge 指令，禁止直接改 SQLite/blob、伪造门禁、审批和 Seal。
7. App Server 使用 `approvalPolicy=never`，网页不能代表作者同意系统权限提升。小说业务审批仍由 Runtime 的精确 digest 和状态机裁决，不能因 Provider 回答完成而自动通过。
8. v1 在本机桥接内部串行回合。Canvas 的多个 AI 窗口仍各自拥有工作区选择、转录和取消状态；串行只限制对子 Codex App Server 的同时占用。
9. Provider 对非 2xx JSON 错误和 2xx SSE `error` 事件做限长解析，将“令牌失效、Codex 未登录、App Server 失败”等原因显示为任务错误；不得把错误流降格成“模型返回空内容”，也不得把错误正文保存为助手回答。

## 结果

- 作者只需在 Codex 启动桥接、在模型设置粘贴一次性令牌，随后在原 AI 输入框操作。
- 画布没有获得 Codex 登录凭据、文件系统任意权限或 Runtime 数据库权限。
- 文件交换继续负责权威工件投影与受审修改；实时 AI Provider 负责对话和调用意图，两者互补但不混成双权威同步。
- 托管 HTTPS 浏览器可能首次显示本地网络访问许可，这是浏览器安全边界，不是 Cloudflare 登录。

## 验证

- Provider 契约测试断言本机范本和 session-only 令牌不会写入个人备份。
- Provider 契约测试断言 HTTP 与 SSE 桥接错误会保留限长原因并终止生成，不制造空白助手消息。
- Chromium E2E 使用真实 `127.0.0.1` HTTP Server 验证预检、Bearer、OpenAI 兼容 SSE 和现有 AI 对话呈现。
- Engine 测试验证令牌、origin、体积、角色、MCP 启停和停止失效；另以真实已登录 Codex App Server 完成最小回复联调。
- 原有架构门继续禁止 feature-to-feature 实现导入；本变更不新增跨插件实现依赖。
