# Echo-8 架构决策索引

本页是 ADR 的唯一导航入口。ADR 记录历史决策，不因后续调整而删除；后续 ADR 与早期 ADR 冲突时，以表中“状态／后续”列和较新的明确替代说明为准。

状态约定：

- **有效**：仍是当前架构的一部分；后续 ADR 可能补充细节。
- **部分被替代**：只有明确指出的决定失效，其余背景、协议或兼容字段继续有效。
- **历史**：不再指导当前实现，仅保留决策过程。目前没有整篇完全失效的 ADR。

| ADR | 决策 | 状态／后续 |
|---|---|---|
| [0001](ADR-0001-MICROKERNEL.md) | Headless microkernel with governed plugin runtime | 有效 |
| [0002](ADR-0002-GROUPS-CLIPBOARD.md) | Flat groups and provider-planned internal clipboard | 有效；群组标题由 0022 补充 |
| [0003](ADR-0003-SEARCH-STATISTICS.md) | Revisioned literal search and explicit text measures | 有效 |
| [0004](ADR-0004-EDITOR-FORMATTING-METRICS.md) | Three-pane editor, document typography and writing metrics | 有效 |
| [0005](ADR-0005-PALETTE-THEMES.md) | Semantic themes and owner-planned appearance changes | 有效 |
| [0006](ADR-0006-FILES-RECOVERY.md) | Portable files, journal autosave and recovery boundaries | 有效；文件和检查点格式由 0030、0040、0060 补充 |
| [0007](ADR-0007-ACTIONS-SHORTCUTS-DIAGNOSTICS.md) | Action catalog, shortcut arbitration and sanitized diagnostics | 有效 |
| [0008](ADR-0008-AI-RETRIEVAL-PROPOSALS.md) | AI retrieval transparency and reviewable proposals | 有效 |
| [0009](ADR-0009-LARGE-CONTENT-PORTABLE-BUILD.md) | Independent text chunks, windowed editing and portable HTML | 有效 |
| [0010](ADR-0010-LONG-TASK-NOTICES.md) | Unified notices for long background tasks | 有效 |
| [0011](ADR-0011-INCREMENTAL-INVALIDATION-SPATIAL-INDEX.md) | Incremental invalidation, command availability and spatial indexes | 有效 |
| [0012](ADR-0012-AI-INLINE-COMMANDS-MULTI-PROVIDER.md) | AI inline commands, reference drops and multiple provider profiles | 有效 |
| [0013](ADR-0013-AI-CONVERSATION-MEMORY-INDEX.md) | Evidence-backed conversation memory nodes | 有效 |
| [0014](ADR-0014-AI-MEMORY-EXECUTION-PROTOCOL.md) | Versioned AI memory execution protocol | 有效 |
| [0015](ADR-0015-AI-MEMORY-GOVERNANCE.md) | Batched retrieval and user-governed memory center | 有效 |
| [0016](ADR-0016-HYBRID-RETRIEVAL-EVIDENCE-BLOCKS.md) | Hybrid retrieval and complete evidence blocks | 有效 |
| [0017](ADR-0017-ADAPTIVE-CONNECTION-RENDERING.md) | Adaptive dense-connection rendering | 有效 |
| [0018](ADR-0018-REMOTE-SEMANTIC-PROVIDER.md) | Independent remote semantic retrieval provider | 有效 |
| [0019](ADR-0019-INDEPENDENT-GROUP-MEMBER-SELECTION.md) | Independent group-container and member selection | 有效 |
| [0020](ADR-0020-STREAMING-AI-PROMPT-POLICY.md) | Streaming AI generation and prompt policy | 有效 |
| [0021](ADR-0021-CANVAS-NODE-DETAIL-LOD.md) | Canvas node level of detail | 有效 |
| [0022](ADR-0022-GROUP-SELECTION-SCOPES.md) | Titleless groups and spatial selection scopes | 有效 |
| [0023](ADR-0023-ONBOARDING-TEXT-NODES.md) | Fresh-canvas onboarding as ordinary explicit-only text nodes | 有效 |
| [0024](ADR-0024-MULTI-ASSISTANT-WINDOWS.md) | Independent AI assistant windows and session-scoped tasks | 有效 |
| [0025](ADR-0025-RIGHT-SURFACE-ARBITRATION.md) | Core arbitration for editor and right-side panels | 有效 |
| [0026](ADR-0026-SMART-GUIDES-GRID-LAYOUT.md) | Smart guides, snapping and selected-node grid layout | 有效 |
| [0027](ADR-0027-OVERFLOW-SHORTCUT-PRESENTATION.md) | Overflow strips and live shortcut presentation | 有效 |
| [0028](ADR-0028-SEARCH-NAVIGATION-QUEUE.md) | Search navigation command queue discipline | 有效 |
| [0029](ADR-0029-MANAGED-BACKGROUND-WORKERS.md) | Background computation is owned by the kernel | 有效 |
| [0030](ADR-0030-DEDUPLICATED-LOCAL-CHECKPOINT-CHUNKS.md) | Local checkpoints deduplicate immutable text chunks | 有效 |
| [0031](ADR-0031-INCREMENTAL-SEMANTIC-BLOCK-FINGERPRINTS.md) | Remote semantic cache reuses unchanged sampled blocks | 有效 |
| [0032](ADR-0032-PLUGIN-DEPENDENCY-ORDER.md) | Plugin auto-start is dependency ordered | 有效 |
| [0033](ADR-0033-PORTABLE-STARTUP-AND-REACT-SCHEDULING-GATE.md) | Unified portable bundle and measured split boundary | 有效 |
| [0034](ADR-0034-READ-ONLY-AI-MEMORY-TOOL.md) | 只读本地记忆工具 | 有效；重复编号已整理，文本辅助为 0061 |
| [0035](ADR-0035-COMPOUND-COMMANDS-AND-ASYNC-OBSERVERS.md) | Compound commands and isolated committed observers | 有效 |
| [0036](ADR-0036-AI-MINIMIZATION-MEMORY-FILES-REASONING.md) | AI 最小化、严格记忆范围、本地双 TXT 与思考分离 | 有效 |
| [0037](ADR-0037-PROJECT-DROP-ANNOTATION-ANCHORS-AI-WEB.md) | 项目拖入、注释屏幕锚点与 AI 原生联网 | 有效 |
| [0038](ADR-0038-SAFE-OPEN-PERSONAL-TEXT-ASSETS.md) | 打开书籍裁决与大型个人文本资源 | 有效 |
| [0039](ADR-0039-AI-PERSONAL-CONNECTION-BACKUP.md) | AI 个人连接备份边界 | 有效 |
| [0040](ADR-0040-COMPACTED-HISTORY-AND-REFERENCE-CHECKPOINTS.md) | Compacted editing history and reference-based checkpoints | 有效 |
| [0041](ADR-0041-COMPRESSED-INVERTED-SEARCH-INDEX.md) | Bounded compressed inverted candidate index | 有效 |
| [0042](ADR-0042-PARAGRAPH-SEMANTIC-BLOCKS.md) | Stable paragraph-aware semantic blocks | 有效 |
| [0043](ADR-0043-MODEL-AWARE-AI-CONTEXT-BUDGET.md) | Model-aware AI evidence budgets | 有效 |
| [0044](ADR-0044-AI-MEMORY-ACCURACY-EVALUATION.md) | Declarative AI memory accuracy release evaluation | 有效 |
| [0045](ADR-0045-REAL-BROWSER-EXTREME-PERFORMANCE-GATE.md) | Real-browser large-canvas performance gate | 有效 |
| [0046](ADR-0046-UNIFIED-UI-ACTION-FAILURES.md) | Kernel-reported user command failures | 有效 |
| [0047](ADR-0047-EXPORT-AI-EDITOR-FILE-HANDLE-COMPATIBILITY.md) | 整画布导出绑定、AI 输出纪律与跨浏览器编辑同步 | 有效 |
| [0048](ADR-0048-CARET-ANCHORED-ASSISTANCE-AND-ESCAPE-ORDER.md) | 光标定位的文本辅助与分层 Escape 退出 | 有效 |
| [0049](ADR-0049-UNICODE-VISIBLE-CHARACTER-COUNT.md) | 统一 Unicode 可见字符统计 | 有效；0059 恢复主显示，0062 统一实现 |
| [0050](ADR-0050-TEXT-ASSIST-STATUS-AND-AI-COMPLETENESS.md) | 纠错资源状态与 AI 回答完整性控制 | 有效 |
| [0051](ADR-0051-EDITOR-WRITING-COUNT.md) | 编辑器写作字数与字符数分离 | **部分被 0059 替代**；写作单位仅作兼容字段 |
| [0052](ADR-0052-EXPLICIT-AI-CONTEXT-MODE.md) | Explicit-source-only AI context | 有效 |
| [0053](ADR-0053-CONFIRMED-AI-MEMORY-CANDIDATES.md) | Source-bound AI memory candidates | 有效 |
| [0054](ADR-0054-INTENT-ROUTED-AI-RETRIEVAL.md) | Intent-routed AI retrieval | 有效 |
| [0055](ADR-0055-CLAIM-AWARE-MEMORY-RETRIEVAL.md) | Confirmed claims as retrieval anchors | 有效 |
| [0056](ADR-0056-LOCAL-SEMANTIC-RETRIEVAL.md) | 本地 BGE 语义检索作为受控并列提供器 | 有效 |
| [0057](ADR-0057-BOUNDED-CLAIM-RELATION-RETRIEVAL.md) | 受限、可解释的确认事实关系检索 | 有效 |
| [0058](ADR-0058-STABLE-AI-PROMPT-PREFIX.md) | 稳定 AI 协议前缀与动态请求分离 | 有效 |
| [0059](ADR-0059-DAILY-EDITOR-CONSISTENCY.md) | 日常编辑一致性与会话恢复提示 | 有效；替代 0051 的编辑器主显示口径 |
| [0060](ADR-0060-PRODUCTION-BOUNDARIES-AND-PLUGIN-DATA-MIGRATIONS.md) | 生产输入边界、插件数据迁移与热停机 | 有效 |
| [0061](ADR-0061-TEXT-ASSISTANCE.md) | 可热插拔的文本纠错、节点引用与补全 | 有效；原重复编号 0034，仅重编号 |
| [0062](ADR-0062-TYPED-COMMANDS-AND-UNICODE-METRICS.md) | 统一命令类型表与 Unicode 统计实现 | **部分被 0074 替代**；统计语义保留，共享实现从 core 移至 services |
| [0063](ADR-0063-EDITOR-ANNOTATION-BOUNDARIES-AND-TRANSFER.md) | 编辑器注释边界、剪贴板传递与视图稳定性 | 有效 |
| [0064](ADR-0064-TITLE-BAR-CONNECTION-ENDPOINTS.md) | 标题栏连接端点与左侧绕线路径 | 有效；水平端点切线与文字由 0065 补充 |
| [0065](ADR-0065-CONNECTION-LABELS-AND-HORIZONTAL-TANGENTS.md) | 连线文字、水平端点切线与自适应箭头 | 有效；补充 0017、0064 |
| [0066](ADR-0066-TEXT-BOX-PRESENTATION-AND-SIZE-MEMORY.md) | 文本框形态与双尺寸记忆 | 有效；补充 0021、0060 |
| [0067](ADR-0067-CLOUDFLARE-BYOC-CROSS-DEVICE-SYNC.md) | 用户自有 Cloudflare 数据平面与跨设备单人同步 | 有效；R2 必选部分由 0068 替代 |
| [0068](ADR-0068-D1-FIRST-CLOUD-OBJECT-STORAGE.md) | D1 优先的云对象存储与 R2 升级路径 | 有效；部分替代 0067 |
| [0069](ADR-0069-EXPLICIT-DATA-WORKER-UPGRADES.md) | 用户自有数据 Worker 的显式版本检测与原地升级 | 有效；补充 0067、0068 |
| [0070](ADR-0070-BOOK-LIBRARY-ENTRY-AND-PROJECT-SWITCHING.md) | 托管版书库首页与显式书籍切换 | **部分被 0076 替代**；书库与切换语义保留，便携版排除决定失效 |
| [0071](ADR-0071-CLOUD-FIRST-SAVE-AND-PERSONAL-AI-BOUNDARY.md) | 云端优先保存、另存本地副本与个人 AI 数据边界 | 有效；补充 0006、0039、0056、0067、0068、0070 |
| [0072](ADR-0072-COMMAND-PALETTE-PRIMARY-FILE-ACTIONS.md) | 命令面板承载首页、保存、另存与打开的主要入口 | 有效；补充 0038、0046、0070、0071 |
| [0073](ADR-0073-FIRST-SAVE-CREATES-CLOUD-BOOK.md) | 首次保存创建云端书籍 | 有效；补充 0006、0070、0072 |
| [0074](ADR-0074-PLUGIN-BOUNDARIES-AND-CANVAS-COMPOSITION.md) | 插件边界、画布组合与运行时资源归属 | 有效；补充 0001、0025、0029、0032、0045、0060，部分替代 0062 的目录决定 |
| [0075](ADR-0075-CONFIRMED-CLOUD-BOOK-DELETION.md) | 首页与同步面板共用的云端书籍删除确认 | 有效；补充 0067、0070、0073 |
| [0076](ADR-0076-PORTABLE-LIBRARY-AND-CONDITIONAL-CLOUD-CONTROL.md) | 便携版书库入口与按来源启用的云控制面 | 有效；补充 0033，部分替代 0070 的便携版排除决定 |
| [0077](ADR-0077-NOVELFORGE-LOCAL-RUNTIME-BRIDGE.md) | NovelForge 本地 Runtime 投影、画布映射与受审提案桥接 | 有效；补充 0006、0035、0060、0074 |
| [0078](ADR-0078-NOVELFORGE-CODEX-LOOPBACK-PROVIDER.md) | NovelForge Codex 回环 Provider、会话配对与现有 AI 输入框复用 | **部分被 0079 替代**；回环、App Server、权威和提权限制保留 |
| [0079](ADR-0079-NOVELFORGE-PERSISTENT-LOCAL-CONNECTOR.md) | Windows 用户级持久本机连接器、一次配对、Runtime 同步与 Codex 共享能力 | 有效；补充 0039、0060、0067、0074、0077、0078，部分替代 0078 的会话生命周期 |

新增 ADR 时必须使用下一个未占用编号，同时在本表登记状态和明确的替代关系。不要通过删除旧文件来“解决”冲突。
