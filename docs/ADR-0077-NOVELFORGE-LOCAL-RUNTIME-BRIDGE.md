# ADR-0077：NovelForge 本地 Runtime 桥接

## 状态

已采纳 — 2026-10-20。补充 ADR-0006、ADR-0035、ADR-0060 和 ADR-0074。

## 问题

NovelForge Engine 以 SQLite、不可变 blob、严格七步流程、审批和 Seal 为权威；Echo-8 是浏览器画布，并有自己的文档事务、撤销、文件授权和节点身份。若画布直接改 SQLite、把节点坐标当章节位置、把本地编辑自动覆盖 Runtime，或把 Runtime 全量数据复制成第二套故事权威，就会破坏 CAS、审批、任务恢复和 CompleteStory 封版边界。

浏览器 File System Access API 还不能启动本地进程。目录授权可能在刷新、浏览器重启或切换来源后失效，网页关闭时也不保证后台监听。因此第一版必须是显式、可恢复、无常驻服务的本地协议。

## 决定

1. NovelForge 作为独立 `novelforge` feature plugin 注册，不进入 shell、canvas core、文本节点实现或 AI 插件。
2. import/export 插件只提供 `file.chooseExternalProjectDirectory@1` 目录选择能力；NovelForge 得到用户选择的目录句柄，但不持有 `.echo8` 保存目标，也不读取 SQLite/blob。
3. Runtime 导出 `manifest.json + artifacts/*.json` 可重建投影。画布只写 `requests/*.json`，只读 `receipts/*.json`。协议 v1 使用 canonical JSON SHA-256，并限制路径、字段、条目数和文件大小。
4. `artifactId`、`entryId`、`canvasNodeId` 分离。绑定记录项目、工件、章节/卡片、文件、revision/digest、画布节点、建议坐标和同步状态；坐标从不回写 Runtime 章位。
5. 投影节点通过 `content.createPlan@1` 创建，通过 revision-checked delta/rename plans 更新。NovelForge 不写文本节点命名空间，也不跨插件导入实现。
6. 映射属于文档域，连接/面板状态属于工作区域。两域分别提交事务；同步的文档事务可进入全局历史，连接状态不进入书籍历史。
7. 本地节点变化只产生 `local-draft`。作者显式点击后，后台任务完整读取节点、计算候选 digest，并以确定性 request ID 原子写一个请求文件。画布永远不能提交作者审批或 Runtime 权威。
8. Runtime 与画布只有一边变化时更新相应一边的同步基线；两边都变化时进入 `conflict`，不覆盖。Runtime 移除 entry 时保留节点并标为 `orphaned`；节点被删除时下次同步重新创建。
9. 切换书籍、插件热停机和显式断开会取消受管任务并释放目录 lease。目录句柄不进入 `.echo8`、历史、恢复快照或云同步。
10. v1 不包含后台 watcher、网页唤醒 Codex、Windows Connector、Cloudflare 小说服务或多用户合并。未来适配器必须继续调用同一 Runtime 协议。

## 结果

- 画布可视化素材、时间轴、主线节点、CompleteStory 和正文，而 Runtime 保持唯一权威。
- 浏览器重开后作者需要重新授权目录，但 `.echo8` 中的稳定映射仍可继续对账。
- 同步不是实时双向数据库复制；每个方向都由明确操作触发。
- Runtime 的 `PROPOSAL_ONLY` 内容可收集作者意图，但仍必须进入阶段专用或事务式修复流程，不能把自由文本直接变成 Seal 事实。

## 验证

- TypeScript 协议测试覆盖 Python/TypeScript canonical digest 一致、投影/路径/摘要篡改和请求路径限制。
- 内核集成测试覆盖首次导入、Runtime 标题与正文更新、画布本地编辑、请求写入和双边冲突保留。
- 架构门继续禁止 feature-to-feature 实现导入，类型检查和 Lint 必须通过。
- `verify:novelforge-exchange` 直接读取 Runtime 实际导出的目录；可选 `--write-probe` 只生成待审协议探针，不修改权威数据。
