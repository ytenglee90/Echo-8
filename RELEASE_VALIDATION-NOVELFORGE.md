# NovelForge Canvas 0.3.0 验收

检查日期：2026-10-21。此文件只验收 Canvas-App 侧的画布插件、用户级连接器和 AI 助手接入；Runtime 权威验收见相邻 `NovelForge-Engine/RELEASE_VALIDATION.md`。

## 结论

0.3.0 已达到本机单用户第一版可用：作者安装一次 Windows 当前用户连接器，在 HTTP(S) 画布保存一次 endpoint 与设备配对令牌，之后登录 Windows 自动静默启动、网页刷新自动重连。NovelForge 面板可列出本机项目、分页同步投影、登记待审提案；原 AI 助手可复用同一受认证能力调用用户已登录的 Codex，不需要第二份令牌。

它不把画布升级为 Runtime 权威入口：画布不能直接写 SQLite/blob、批准提案、签作者决定、写质量 PASS 或 Seal。Cloudflare BYOC 只保存用户自己的画布数据，不会自动上传 NovelForge SQLite/blob。

## 已实现

- `novelforge-canvas-local/2`：精确 HTTP(S) origin + 高熵设备 Bearer token + 仅 `127.0.0.1`。
- Windows 当前用户监督器：命名 mutex、防重复启动、隐藏子进程、登录启动项、有界异常重启、限长脱敏日志、令牌文件 ACL 与卸载脚本。
- `novelforge.localConnectorFetch@1`：NovelForge 插件独占令牌，其他插件只调用版本化能力。
- 项目发现、分页快照、canonical SHA-256、稳定映射、增量同步、冲突/孤儿保留和批量待审提案。
- AI Provider 的 `novelforge-connector` transport；Provider 不接收配对令牌，首个聊天请求才由 Engine 懒启动官方 Codex App Server。
- exchange 目录兼容模式；`file://` 便携版因 `Origin: null` 不启用实时连接器。

## 验证结果

| 验证 | 结果 |
|---|---|
| `pnpm run typecheck` | PASS |
| `pnpm run lint` | PASS |
| `pnpm run test` | 367 / 367 PASS |
| `pnpm run test:e2e` | Chromium 50 / 50 PASS |
| NovelForge 连接器专项 E2E | 1 / 1 PASS；一次配对、项目同步、刷新重连、AI 复用 |
| `pnpm run build` | PASS |
| `pnpm run build:portable` | PASS |
| `pnpm run test:portable` | Chromium 1 / 1 PASS，真实 `file://` 且无外部资源 |
| `pnpm run test:performance-browser` | 1 / 1 PASS；2,000 节点 + 20,000,000 字符 |
| Connector Python 测试 | 3 / 3 PASS |
| WebKit | hosted 用例逐项通过；portable 1 / 1 PASS |

便携文件：`artifacts/Echo-8.html`，1,492,392 bytes，SHA-256 `B9414A6C7FC72226C284EAEECE4E20EC673E876922602FDF617BE038E25DDEDE`。它是离线画布交付，不承诺 `file://` 实时连接本机服务。

## 已安装连接器实测

- 安装目录、ACL 令牌文件和当前用户启动快捷方式存在；监督器状态为 `RUNNING`。
- 强制终止桥子进程后，监督器 PID 保持不变，5 秒内创建新子进程与新监听 PID，认证健康检查恢复 HTTP 200。
- 授权 `http://localhost:3000` 的 CORS 预检返回 204；未授权 `https://evil.example` 返回 403。
- 恢复后的真实聊天经官方 Codex 返回 `7`、HTTP 200、`finish_reason=stop`；没有假 backend 或失败降级。
- 设备令牌未出现在命令行、测试输出、连接器日志、小说数据或画布文档中。

## 尚未声称完成

- 尚无最终生产域名，因此还未在实际 HTTPS 域名验证浏览器 Local Network Access 提示；正式发布必须以精确生产 origin 重装并复跑预检、同步和真实 AI。
- 本机 Playwright Firefox 在 20 秒和临时 60 秒启动上限内都未建立自动化控制通道，失败发生在页面代码运行前；Firefox 发布结论需由干净 CI/另一台主机补齐。
- 纯网页不能自行启动本机 Codex；每台电脑仍需用户主动安装一次当前用户连接器。这是浏览器安全边界，不是 Cloudflare 登录要求。
- 画布节点坐标、连线和自由文本不是 Runtime 时间轴、因果或 CompleteStory 权威。
