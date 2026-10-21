# 验证并构建 Echo-8

用于修改完成后的统一验收。任何一步失败都停止构建，分析并修复真实原因，不得删除测试或降低断言来换取通过。

1. 阅读 `AGENTS.md` 和与修改相关的架构协议。
2. 检查改动是否仍由正确插件或系统服务拥有，是否存在跨插件实现导入、UI直接持久写入或未托管资源。
3. 运行 `pnpm run typecheck`。
4. 运行 `pnpm run lint`。
5. 运行与改动直接相关的定向测试。
6. 运行 `pnpm run test`。
7. 运行 `pnpm run test:e2e`，确认真实 Chromium 中没有插件隔离错误、未捕获异常或关键指令超时。
8. 运行 `pnpm run build:portable`，重新生成 `artifacts/Echo-8.html`。
9. 报告改动摘要、协议/文件格式影响、测试数量、构建结果和仍存在的限制。
