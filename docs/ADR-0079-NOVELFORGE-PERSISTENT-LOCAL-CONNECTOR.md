# ADR-0079：NovelForge 持久本机连接器与一次配对

## 状态

已采纳 — 2026-10-21。补充 ADR-0039、0060、0067、0074、0077和 0078；部分替代 ADR-0078 中“由 MCP 拥有生命周期、令牌仅页面会话有效、每次需在 Codex 重启”的决定。ADR-0078 的回环限制、官方 App Server 映射、不可提权及 Runtime 权威边界继续有效。

## 问题

浏览器不能启动本机 Runtime 或 Codex 进程。`file://` 页面又以 `Origin: null` 访问回环地址，无法安全区分信任网站。先前的可见前台桥虽可用，但关窗即断、页面刷新后需再粘贴令牌，不符合“打开画布网址，首次配置后直接使用”。

## 决定

1. `Canvas-App/infinite-canvas/connector` 提供当前 Windows 用户的本机连接器。安装器不需管理员，写入 `%LOCALAPPDATA%\NovelForge\CanvasConnector`，并创建当前用户的启动文件夹快捷方式。它是隐藏的用户级监督进程，不是特权 Windows Service。
2. 连接器只监听 `127.0.0.1`，不绑定局域网或公网。它使用稳定、高熵、设备本地的 Bearer 配对令牌，并必须同时匹配明确的 HTTP(S) origin 白名单。令牌不可放在 URL、命令行、日志或诊断中。
3. 安装器把令牌文件 ACL 限制为当前用户和 `SYSTEM`。不改 `.codex` ACL，不复制 `auth.json`，不读取 Codex 登录凭据。轮换令牌或更换画布域名必须重跑安装器；旧 origin 和旧令牌随即失效。
4. 托管 HTTP(S) 画布在 NovelForge 面板中输入 endpoint 和令牌一次。配置只存于该浏览器设备的个人偏好，不进入 `.echo8`、正文/节点、撤销历史、项目检查点、TXT 连接备份、Cloudflare 数据同步、日志或诊断。清理站点数据、换浏览器或换网址后需重新配对。
5. NovelForge 插件是配对令牌的唯一画布所有者，通过 `novelforge.localConnectorFetch@1` 版本化能力代理受限请求。`ai-provider` 只把聊天 body 交给该能力，不保存、显示或接收配对令牌，也不导入 NovelForge 插件实现。
6. 本机协议 `novelforge-canvas-local/2` 提供受认证的健康检查、Runtime 项目列表、分页快照、批量待审提案及 OpenAI Chat Completions 兼容聊天端点。Runtime 数据读取可在不启动 App Server 时工作；首个 AI 请求才懒启动官方 `codex app-server --stdio`。
7. 画布修改只能进入 Runtime 的 `canvas_change_proposals`。连接器不提供直接 SQLite/blob 写入、作者确认、质量门 PASS 或 Seal 伪造能力。画布中的人物、时间轴、完整故事和对话仍是不可信输入，权威变更由 Runtime 版本、CAS、审批和七步门禁裁决。
8. `file://` 便携单 HTML 不启用本机连接器，因为它没有可白名单化的网站 origin。它仍支持纯离线 `.echo8` 与人工 exchange 目录兼容模式。
9. Cloudflare 登录只属于可选的用户自有画布数据同步，与本机配对、Runtime 和 Codex 登录无关。NovelForge 小说 SQLite/blob 不会因配对而上传到画布运营方服务器。

## 运行与恢复

- 登录 Windows 后启动文件夹快捷方式静默启动监督进程；重复启动由当前用户命名 mutex 拒绝。
- 桥进程崩溃后监督进程有界重启，日志限长轮换且不包含令牌。App Server 崩溃只使当前 AI 请求失败，下次请求重建。
- 画布刷新时从个人偏好恢复配置并自动探测；Runtime 项目和映射留在书内，配对只留在设备。
- 使用 `uninstall.ps1` 删除启动项和连接器配置。它不删除 Engine、小说数据库、画布书籍或 Codex 登录。

## 验证

- Connector 测试覆盖配置、origin、令牌命令行隔离、日志轮换和安装脚本解析。
- Engine HTTP 集成覆盖认证/CORS、项目列表、分页快照、幂等待审提案及真实 App Server 回答。
- Canvas 契约测试覆盖配对持久性、摘要校验、项目同步、只待审提交，以及 AI Provider 始终不接收令牌。
- 真实浏览器验证“配对→选项目→同步→刷新→自动重连”；正式发布还需在实际 HTTPS 域名验证浏览器的本地网络许可流程。
