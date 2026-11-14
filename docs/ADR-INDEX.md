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
| [0003](ADR-0003-SEARCH-STATISTICS.md) | Revisioned literal search and explicit text measures | 有效；标题范围与导航由 0083 补充 |
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
| [0028](ADR-0028-SEARCH-NAVIGATION-QUEUE.md) | Search navigation command queue discipline | **部分被 0083 替代**；队列纪律保留，活动编辑区单一范围失效 |
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
| [0073](ADR-0073-FIRST-SAVE-CREATES-CLOUD-BOOK.md) | 首次保存创建云端书籍 | **部分被 0077 替代**；手动保存兜底保留，新建书籍的自动检查点成为首选触发器 |
| [0074](ADR-0074-PLUGIN-BOUNDARIES-AND-CANVAS-COMPOSITION.md) | 插件边界、画布组合与运行时资源归属 | 有效；补充 0001、0025、0029、0032、0045、0060，部分替代 0062 的目录决定 |
| [0075](ADR-0075-CONFIRMED-CLOUD-BOOK-DELETION.md) | 首页与同步面板共用的云端书籍删除确认 | 有效；补充 0067、0070、0073 |
| [0076](ADR-0076-PORTABLE-LIBRARY-AND-CONDITIONAL-CLOUD-CONTROL.md) | 便携版书库入口与按来源启用的云控制面 | **部分被 0077 替代**；便携版边界保留，删除按钮的文字呈现要求失效 |
| [0077](ADR-0077-ICON-FIRST-CLOUD-STATUS-AND-AUTOSAVE-TARGETS.md) | 图标优先的云状态与按来源选择自动保存目标 | **部分被 0081 替代**；目标来源与图标语义保留，即时云端绑定/上传触发失效 |
| [0078](ADR-0078-SELECTION-SCOPED-APPEARANCE.md) | 选中对象与连接线部件的局部调色 | 有效；补充 0005、0017、0019、0060、0065 |
| [0079](ADR-0079-MIXED-APPEARANCE-CATALOG-AND-RESET.md) | 混合模块调色、全画布颜色记录与恢复初始颜色 | 有效；补充 0005、0078，替代 0078 的单一外观类型限制 |
| [0080](ADR-0080-GOVERNED-INPUT-COMPOSITION-AND-PUBLIC-STATE-PROTOCOLS.md) | 受治理文件输入、唯一插件组合清单与公共状态协议 | 有效；补充 0001、0035、0038、0060、0074 |
| [0081](ADR-0081-UNIFIED-AUTOSAVE-TARGET-SCHEDULING.md) | 统一自动保存目标调度、本机恢复与云端上传节拍 | 有效；补充 0006、0071，部分替代 0077 |
| [0082](ADR-0082-COMPACT-BUILTIN-TEXT-ASSIST-OVERLAYS.md) | 书籍仅保存内置纠错规则版本引用与自定义覆盖 | 有效；补充 0006、0038、0061 |
| [0083](ADR-0083-TITLE-SEARCH-AND-SELECTION-SCOPED-NAVIGATION.md) | 标题检索、画布选择联动与选中范围导航 | 有效；补充 0003，部分替代 0028 |
| [0084](ADR-0084-SESSION-ONLY-WORKSPACE-RESTORE-BOUNDARY.md) | 仅会话工作区恢复边界与只读云书籍接管入口 | 有效；补充 0006、0025、0060、0080 |
| [0085](ADR-0085-HOMEPAGE-CLOUD-CAPACITY-AND-ACCESS.md) | 首页云容量与当前书籍权限状态 | 有效；补充 0068、0069、0070 |
| [0086](ADR-0086-OVERVIEW-CONNECTION-LOD-AND-INDEXED-LASSO.md) | 低缩放连线 LOD、框选仲裁与增量选择索引 | 有效；补充 0011、0017、0021、0022、0045、0065、0074 |
| [0087](ADR-0087-STARTUP-RECOVERY-AND-INTERACTION-SESSIONS.md) | 启动恢复通道与交互会话令牌 | 有效；补充 0006、0035、0045、0046、0081、0086 |
| [0088](ADR-0088-EDITOR-FORMAT-PROJECTION-AND-HOVER.md) | 编辑器格式投影一致性与画布悬停反馈 | 有效；补充 0004、0017、0063、0066、0086 |
| [0089](ADR-0089-CONNECTION-JUNCTIONS-AND-TITLE-DASHES.md) | 连接中转点、共享分支、智能吸附与标题虚线 | 有效；补充 0002、0017、0026、0060、0064、0065、0086、0087 |
| [0090](ADR-0090-MINIMAP-NAVIGATION.md) | 独立小地图插件、色块概览与保持缩放的视图导航 | 有效；补充 0007、0011、0084、0087 |
| [0091](ADR-0091-CONNECTION-STROKES-AND-GROUP-ENDPOINTS.md) | 独立箭头、平顺中转点、群组端点与焦点提示 | 有效；补充 0002、0064、0086、0089、0090，部分替代 0017 |
| [0092](ADR-0092-SEARCH-EMPTY-SELECTION-NAVIGATION.md) | 查找的未命中选区自动退回全画布导航 | 有效；补充、部分替代 0083 |
| [0093](ADR-0093-TITLE-CONNECTION-SIDES.md) | 标题连线的左右端口与自动相向几何 | 有效；部分替代 0064、0091 |
| [0094](ADR-0094-UNBOUNDED-NODE-WIDTH.md) | 节点与文本框取消宽度上限 | 有效；替代旧宽度上限 |
| [0095](ADR-0095-BATCH-GROUP-DROP.md) | Ctrl 拖拽批量加入和移出群组 | 有效；扩展原单节点成员操作 |
| [0096](ADR-0096-MINIMAP-ENTITY-SHAPES.md) | 小地图群组轮廓与文本框边框横杆 | 有效；部分替代 0090 |
| [0097](ADR-0097-CONNECTION-PRESENTATION-AND-TERMINAL-TANGENTS.md) | 形态转换的连接投影与水平箭头接入 | 有效；补充 0093，部分替代 0091 |
| [0098](ADR-0098-JUNCTION-BATCH-MOVEMENT-AND-FOLLOW.md) | 中转点批量移动与相连对象平均位移跟随 | 批量移动有效；跟随由 0109 取代 |
| [0099](ADR-0099-GROUP-CONNECTION-PREVIEW.md) | 群组透明端口与成员变更锚点预览 | 有效；补充 0091、0095、0097 |
| [0100](ADR-0100-TITLE-SAME-SIDES-AND-MINIMAP-GROUP-FILLS.md) | 仅标题互连同侧端口与小地图群组底色 | 有效；部分替代 0093、0096 |
| [0101](ADR-0101-CONNECTION-RECONNECT-AND-LABEL-INTERACTIONS.md) | 箭头重接、标签缩放会话与统一描边和实体已用色 | 有效；补充 0089、0091、0097、0099 |
| [0102](ADR-0102-JUNCTION-HORIZONTAL-PORTS-AND-TITLE-SIDE-CORRECTION.md) | 中转点左入右出与标题互连选边方向修正 | 部分由 0105 取代固定端口；标题自动选边仍有效 |
| [0103](ADR-0103-TEXT-BOX-TARGET-REGIONS.md) | 文本框互连按目标上/下区判定线型，保持中点锚点 | 有效；由 0105 扩展群组/中转点来源 |
| [0104](ADR-0104-JUNCTION-LINE-TYPES-AND-GROUP-COPY.md) | 中转组件线型隔离与群组复制排除中转图 | 有效；部分替代 0091 群组复制规则 |
| [0105](ADR-0105-ADAPTIVE-JUNCTION-AND-TITLE-ORIGIN.md) | 中转点相向端口、标题起始侧与群组/点到文本框区域 | 有效；替代 0102 固定端口，扩展 0103 |
| [0106](ADR-0106-SEMANTIC-TITLE-PAIR-SIDES.md) | 标题对齐区、中转点相向端口与正文输入箭头 | 有效；部分替代 0100、0102、0105 |
| [0107](ADR-0107-GROUP-PORTS-AND-JUNCTION-DRAG-HANDOFF.md) | 群组固定屏幕命中区与中转点连续拖动交接 | 有效；补充 0087、0098、0099 |
| [0108](ADR-0108-TITLE-ORIGIN-REFERENCE-AND-AUTO-SIDES.md) | 标题创建参照与对齐区外按当前左右自动选边 | 有效；修正 0105、0106 区外翻边 |
| [0109](ADR-0109-FIXED-JUNCTIONS-AND-FLEXIBLE-ATTACHMENT.md) | 固定中转点、独立线型、内容复制边界与自适应接入 | 有效；取代 0098 跟随，补充 0104、0105、0107 |
| [0110](ADR-0110-MIXED-SELECTION-MOVEMENT.md) | 中转点、节点、文本框和群组混合选区原子移动 | 有效；补充 0109 固定点规则 |
| [0111](ADR-0111-JUNCTION-HANDLE-ROTATION.md) | 双击按 15° 循环旋转中转点手柄 | 已由 0120 取消 |
| [0117](ADR-0117-JUNCTION-CURVE-STEERING.md) | 拖动曲线调整方向；箭头尺寸与连接距离解耦 | 部分被 0118 替代；固定尺寸规则继续有效 |
| [0118](ADR-0118-SINGLE-CURVE-BENDS.md) | 单条曲线独立调整；共享切线不变，关联线完全不动 | 已由 0119 取代 |
| [0119](ADR-0119-REMOVE-CURVE-DRAG-STEERING.md) | 移除拖动曲线调向，保留自动平滑路由 | 有效；取代 0118，数据 13 兼容旧偏移数据 |
| [0120](ADR-0120-LAYOUT-SWITCHES-AND-EDGE-PAN.md) | 智能参考线/吸附开关、边缘自动平移、删除双击旋转 | 有效；补充 0119，取消 0111 手动旋转，连线数据 14 |
| [0121](ADR-0121-JUNCTION-COLOR-TITLE-SHORTCUT-AND-FOCUS.md) | 中转点全局颜色、配套主题、Shift+L 与全画布聚焦 | 有效；补充 0120，兼容连线数据 14 |
| [0122](ADR-0122-OVERVIEW-OVERLAP-AND-JUNCTION-CONTROLS.md) | 40% 选择关联概览、重叠循环选择、中转点命中区分离 | 有效；交互投影，文档/消息格式不变 |
| [0125](ADR-0125-LOCAL-RECOVERY-MANAGEMENT.md) | 本机恢复副本单条/批量清理、分页目录与可选数量限制 | 有效；补充 0124，文件格式与 IndexedDB v5 兼容 |

| [0126](ADR-0126-TRANSACTION-AUTHORITY-AND-CLEANUP.md) | 补丁来源授权、事务回退、特殊键兼容与重复实现清理 | 有效；内存授权收紧，文件与网络协议不变 |

| [0127](ADR-0127-ACCOUNT-PERSISTENCE-PREFERENCES.md) | 自动保存间隔与恢复副本保留数量的个人账户同步 | 有效；数据 Worker 6、D1 迁移 4，文件与 IndexedDB 结构兼容 |

| [0128](ADR-0128-CLOUD-REAUTHORIZATION.md) | 授权失效时重新连接、导航前保存本机书籍与队列 | 有效；状态字段兼容扩展，书籍格式不变 |

| [0129](ADR-0129-PACKED-CLOUD-RECORDS.md) | 小记录共享分块、稳定分组增量保存与安全原地迁移 | 有效；云书籍格式 3、数据 Worker 7，兼容读取 2；.echo8 不变 |

| [0130](ADR-0130-COMMAND-PALETTE-CURATION.md) | 命令面板分组精简与本地书籍云端另存入口 | 有效；新增 requestSaveAs@1 兼容指令，文件与数据库不变 |

| [0131](ADR-0131-CONTEXTUAL-TOOLBAR-MENUS.md) | 选择相关图标、统一悬停菜单与批量群组操作 | 有效；新增版本化操作指令，替代旧工具栏交互，文件格式不变 |

| [0132](ADR-0132-FIXED-VERTICAL-TOOLBAR-ACTIONS.md) | 固定竖排连接菜单、批量中转点、群组直点与排列轮转 | 有效；替代 0131 对应交互约定，新增批量版本化指令，文件格式不变 |

| [0133](ADR-0133-UNIFIED-SETTINGS-CENTER.md) | 统一设置导航、页面视觉与命令偏好管理 | 有效；新增运行时 UI 元数据 v1，旧入口及持久格式兼容 |

| [0134](ADR-0134-SETTINGS-ENTRY-AND-RULE-IMPORT-CANCEL.md) | 设置入口、排序、规则 Esc 取消与本机恢复面板精简 | 有效；替代 0133 工具栏入口，新增取消指令 v1，持久格式不变 |

| [0135](ADR-0135-AI-VISUAL-SYSTEM.md) | AI 四视图统一视觉及账户容量/权限同行 | 有效；表现层调整，消息与持久格式不变 |

| [0136](ADR-0136-AI-TEXT-BOOK-INPUT.md) | AI 直接编写 TXT、改后缀即可打开的文本书籍输入 | 有效；新增 echo-8-ai-book v1 输入，保存迁移为原生 v2；原生 CRC 和数据库格式不变 |

| [0137](ADR-0137-E8-EXTENSION-AND-CONNECTION-HOVER.md) | 书籍改用 .e8，悬停查看关联连线 | 有效；替代旧扩展名规则，书籍字节格式不变 |

| [0138](ADR-0138-AI-CANVAS-CONTROL.md) | AI 画布控制、范围快照与原子计划审查 | 有效；新增控制 v1 公共协议及临时工作区，书籍格式不变 |

| [0139](ADR-0139-BACKGROUND-QUEUE-AND-AI-FAILURE-RECOVERY.md) | 后台同步排队、Gemini 模型地址与画布计划失败恢复 | 有效；扩展非等待跟进至后台回调，补充 0138 的计划校验与重试，书籍格式不变 |

| [0140](ADR-0140-AI-ROUND-USAGE-AND-REQUEST-INSPECTION.md) | 全模型每轮 Token 实际/估算用量与临时请求查看 | 有效；请求查看 v1，回复增加可选元数据，书籍容器不变 |

| [0141](ADR-0141-DIRECT-CANVAS-GENERATION-AND-REVIEW-SCROLL.md) | 新增对象默认直接生成、固定应用栏与请求查看图标 | 有效；补充 0138 的默认执行方式，书籍格式不变 |

| [0142](ADR-0142-AI-TASK-USAGE-AND-DEMAND-CONTEXT.md) | 任务累计用量、按需上下文、本地操作和范围编辑 v2 | 有效；补充 0138–0141，新旧能力并存，书籍容器不变 |

| [0143](ADR-0143-NATURAL-CANVAS-OPERATIONS.md) | 自然语言定位、连续操作和本地筛选 | 有效；补充 0138、0141、0142，书籍容器不变 |

| [0144](ADR-0144-NATURAL-RULES-AND-RETRIEVAL-POLICY.md) | 自然语言规则扩展、正文约束接续和独立检索设置 | 有效，新增本地与远程分流能力及语义策略 v2，兼容 v1 |

| [0145](ADR-0145-REALTIME-OPERATION-LOG.md) | 实时操作日志 | 有效，新增会话内诊断查询与状态信号，不改变书籍格式 |

| [0146](ADR-0146-CANVAS-TARGET-BINDING-AND-DETAILED-LOG.md) | 画布正文目标绑定与详细操作日志 | 有效，新增正文目标绑定与恢复 v1、详细日志 v2，兼容日志 v1，书籍格式不变 |

| [0147](ADR-0147-CANVAS-SEMANTIC-TOOLS-AND-VERIFICATION.md) | 自然语言画布工具与执行核对 | 有效，新增画布工具 v1、就绪索引策略 v3 与提供者 v2、选区核对 v1；兼容旧协议，书籍与数据库格式不变 |

新增 ADR 时必须使用下一个未占用编号，同时在本表登记状态和明确的替代关系。不要通过删除旧文件来“解决”冲突。
