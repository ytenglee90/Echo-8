# Echo-8 日常生产就绪清单

评估日期：2026-10-21

## 结论范围

当前 0.3.0 可进入**受控的单用户日常生产使用**：推荐使用 Chromium 系浏览器的托管版本，或生成的离线 `artifacts/Echo-8.html`。便携版正式资料必须保存为 `.echo8`；托管版使用 `restore-session` 保留当前浏览器恢复副本，并可通过 Cloudflare BYOC 数据 Worker 跨设备继续编辑。NovelForge 实时联动只在具有可信 origin 的 HTTP(S) 托管版开放；`file://` 便携版继续用于离线画布，不连接本机 Runtime/Codex。

BYOC 公开模式提供隔离的个人账户数据，但不等同于多人实时协作、受监管归档或无人值守服务端部署认证。那些场景还需要更完整的审计、备份恢复、安装升级、部署监控和灾难演练。

## 必须通过的发布门禁

- `pnpm install --frozen-lockfile`：锁文件与供应链策略通过。当前仅允许 `vinext@1.0.0-beta.11` 这一项精确版本例外，因为前一版本已复现受控输入撤销和极端编辑器打开回归；例外在其度过最短发布时间后删除。
- `pnpm audit --prod`：生产依赖无已知漏洞。
- `pnpm run typecheck` 与 `pnpm run lint`：类型和静态规则通过。
- `pnpm run test`：核心、插件、事务、迁移、导入边界、热停机和大文本合同测试全部通过。
- `pnpm run test:e2e`：Chromium 真实交互全部通过。
- `pnpm run test:performance-browser`：2,000 节点与 20,000,000 字符真实浏览器性能门禁通过。
- `pnpm run build`：托管生产构建通过。
- `pnpm run build:portable` 与 `pnpm run test:portable`：离线单 HTML 生成，并从真实 `file://` 无外部资源启动、创建和编辑节点。
- Linux 发布流水线执行 Firefox、WebKit hosted 与 portable 跨引擎门禁；任一失败都不得发布为跨浏览器正式版本。

NovelForge 联动还必须验证：

- 连接器仅绑定 `127.0.0.1`，精确校验 HTTP(S) origin 与至少 43 字符的设备配对令牌；未知 origin、无令牌和错误令牌全部拒绝。
- 画布只能经 `novelforge-connector` 能力读取分页投影和登记待审提案，不能直接打开 SQLite、写不可变 blob、批准提案或伪造质量 PASS/Seal。
- “NovelForge Codex（本机）”复用一次配对，不向 AI Provider 暴露令牌；真实聊天必须由官方 Codex App Server 返回，失败时不得模拟成功。
- Windows 当前用户连接器安装、登录自启、异常重启和卸载脚本通过；正式发布时使用实际画布 HTTPS origin 安装，不能以 `*` 或 `null` 放宽 CORS。

## 2026-10-21 本机实测

- 核心与架构合同：367 / 367 通过；TypeScript、ESLint、生产构建均通过。
- Chromium 托管版：50 / 50 通过；WebKit 托管用例在本机全部通过，便携版 1 / 1 通过。
- 2,000 节点与 20,000,000 字符组合门禁连续三轮通过；补充断言确认后台精确统计完成后，编辑器与导航栏计数一致。
- Chromium 与 WebKit 便携版各 1 / 1 通过；最终 `artifacts/Echo-8.html` 为 1,492,392 字节且不含外部资源。
- NovelForge 连接器专项 E2E 1 / 1 通过：一次配对、项目选择、Runtime 同步、刷新自动重连及 AI 助手复用同一能力均由真实浏览器路径覆盖。
- 已安装连接器上的真实官方 Codex 请求返回正确答案与 `finish_reason=stop`；没有假 backend 或失败降级。

## 操作要求

1. 第一次正式写作前执行一次“另存为”，确认拿到真实 `.echo8` 目标；状态栏必须显示书籍文件已保存，而不是仅显示会话恢复副本。
2. 每次版本升级前复制一份可正常打开的 `.echo8` 样本；升级后验证打开、编辑、撤销、保存、关闭再打开。
3. 普通 AI Provider 密钥只在当前会话保留；NovelForge 配对令牌作为本机个人偏好保存，不进入书籍、`.echo8`、TXT 连接备份或 Cloudflare。正式环境不要把密钥、配对令牌、私有连接或个人资源打包进项目文件。
4. 只发布由锁定依赖生成并通过上述门禁的产物，不直接分发开发服务器目录或 `.portable-stage` 中间文件。
5. 保留最近一个已验证版本及书籍备份；数据迁移失败时停止打开，不覆盖原文件，不手工修改压缩容器。

## 已知边界

- 托管框架 Vinext 仍是 beta 版本，已固定到通过漏洞审计和全部应用门禁的具体版本。该版本暂有一个精确的最短发布时间例外；这是当前发布残余风险，度过冷静期后必须删除例外并重新冻结安装。任何升级都必须重新执行全部门禁。
- 本次 Windows 主机上的 Playwright Firefox 能输出版本，但无法建立自动化控制通道；这属于测试宿主限制。WebKit hosted/portable 已通过，Firefox 结论必须以干净 Linux CI 的发布任务为准。
- NovelForge 的本机联动需要用户安装当前用户连接器；纯网页受浏览器安全模型限制，不能自行启动或控制本机 Codex。安装一次后由 Windows 登录自启，无需保持终端窗口。
- 尚未取得最终生产域名，因此当前只完成 localhost 精确 origin 实测；部署到公开网址前必须以实际 HTTPS origin 重装连接器并执行同样的预检、同步和真实 AI 测试。
- 离线单 HTML 为可恢复的便携产物，不带代码签名或自动更新；对高合规分发场景需要另行补充签名、制品哈希与发布渠道控制。
- 便携版跨启动耐久性依赖 `.echo8` 文件；托管 BYOC 版还依赖用户自己的 Cloudflare 资源、OAuth 授权与备份策略。
