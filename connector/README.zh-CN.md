# NovelForge Canvas 本机连接器

它是网址画布与用户电脑之间的受信本机边界，属于 Canvas-App，不属于
NovelForge Engine。连接器只监听 `127.0.0.1`，复用用户本机 Engine 与 Codex
登录，不把小说、Codex 登录凭据或 SQLite 上传到网站服务器。

## 一次安装

1. 先安装相邻的 `NovelForge-Engine`。
2. 双击 `install.cmd`。开发地址默认授权 `http://localhost:3000`。
3. 正式网站使用 PowerShell 运行：

   ```powershell
   .\install.ps1 -CanvasOrigin https://你的画布域名
   ```

4. 安装结果只显示一次 `pairing_token`。把它粘贴到网址画布的 NovelForge
   面板并保存。该令牌只是本机回环传输凭据，不是 Codex/OpenAI 登录凭据。

安装器在当前 Windows 用户的启动目录创建快捷方式。以后登录 Windows 后连接器
静默启动，网页会自动重连；不需要每次打开黑色窗口。配置、令牌、状态和限长日志位于
`%LOCALAPPDATA%\NovelForge\CanvasConnector`，令牌文件 ACL 仅允许当前用户和
SYSTEM。

## 安全边界

- 网站来源必须在安装时明确授权；`file://` / `Origin: null` 永远不能连接。
- 浏览器只持有设备配对令牌，拿不到 Codex 登录凭据。
- Runtime HTTP 只公开项目列表、分页权威投影和提案提交；不能批准、Seal 或直接
  写 SQLite/blob。
- AI 请求仍使用 `approvalPolicy=never`；需要作者批准的业务操作继续走 Runtime。
- 卸载运行 `uninstall.ps1`。加 `-KeepPairing` 可保留本机配对配置。
