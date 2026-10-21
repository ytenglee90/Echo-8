# NovelForge 网址画布接入与使用

这套接入让作者打开托管画布网址后，查看和编辑自己电脑上的 NovelForge 小说，并在画布原有 AI 助手中使用自己已登录的 Codex。首次需安装本机程序并粘贴一次配对令牌；以后登录 Windows 时静默启动，刷新网页会自动重连，不用保持黑色窗口。

小说的 SQLite、不可变 blob、审批、质量门和 Seal 仍由本机 Runtime 掌握。画布编辑只会形成待审提案，不会直接改权威数据。

## 一、首次准备

### 1. 安装 Engine

```powershell
cd C:\path\to\NovelForge-Engine
.\scripts\install.ps1
```

Codex 登录由官方 Codex 自己管理。不要复制 `auth.json`，也不要放宽 `.codex` 目录权限。

### 2. 安装画布本机连接器

本地开发画布默认是 `http://localhost:3000`：

```text
双击 Canvas-App\infinite-canvas\connector\install.cmd
```

正式画布网址要在 PowerShell 中把实际 origin 授权给连接器（只写协议、域名和可选端口，不带路径）：

```powershell
cd C:\path\to\Canvas-App\infinite-canvas\connector
.\install.ps1 -CanvasOrigin https://canvas.example.com
```

安装结果显示 endpoint（默认 `http://127.0.0.1:32147`）和 `pairing_token`。安装器会在当前用户的 Windows 启动文件夹创建快捷方式；无需管理员，也不安装特权服务。

### 3. 在网址画布配对一次

1. 用 HTTP(S) 打开画布，进入画布工作区。
2. 打开命令面板，选“打开 NovelForge 小说工程”，或按 `Ctrl+Alt+N`。
3. 确认 endpoint，粘贴安装器显示的 `pairing_token`，点“保存并连接（只需一次）”。
4. 浏览器如询问是否允许该网站访问本地网络，由作者本人允许。

令牌保存在这台设备上的浏览器个人偏好中，不进入 `.echo8`、TXT 备份、画布正文、Cloudflare 或小说数据库。清空该网站的浏览器数据、换浏览器或换域名后，需重新配对。

## 二、把一部书放上画布

1. NovelForge 面板会列出本机 Runtime 项目。
2. 选择一部书，点“连接并同步”。
3. 画布分页读取 Runtime 投影，校验 manifest、每个 artifact 与快照 digest，再创建普通文本节点。
4. Runtime 产生新版本后，点“同步权威投影”。

首次坐标来自 Runtime 建议。之后拖动节点只改画布布局，不改时间轴章位。误删映射节点后再次同步会从 Runtime 重建。

## 三、在画布里修改

直接编辑已映射的文本节点，然后点“提交本地改动提案”。插件会重读完整节点，绑定画布节点 revision、Runtime 基础 revision、authority/content/candidate digest 和确定性 request ID，批量提交到 Runtime。

这一步只会生成 `REVIEW_REQUIRED`、`CONFLICT`、`BLOCKED` 等提案/回执，不会自动改权威文件。

- 素材卡：作者查看完整候选和精确 digest 后，在 Runtime 中明确提交。
- 正文：仍要通过 Seal、故事事件、事实披露、章节顺序、双审和批次门禁。
- 时间轴、主线、主线节点、CompleteStory：画布自由文本不能直接成为权威事实，必须进入对应阶段编辑或事务式修复、五层回归和必要审批。

需要命令行处理时，使用：

```powershell
.\scripts\novelforge.ps1 canvas-proposal-list <project_id>
.\scripts\novelforge.ps1 canvas-proposal-show <proposal_id>
.\scripts\novelforge.ps1 canvas-proposal-commit <proposal_id> <candidate_digest> --confirm AUTHOR
```

AI 和网页不能代替作者执行 `--confirm AUTHOR`。

## 四、在画布 AI 助手里用 Codex

NovelForge 面板已配对后：

1. 打开“AI 助手 → 配置模型平台与 KEY”。
2. 选择“NovelForge Codex（本机）”并保存；不再粘贴第二份令牌。
3. 回到原来的 AI 对话输入框，直接下令。

AI Provider 通过 NovelForge 版本化能力发送聊天 body，本身看不到配对令牌。首个 AI 请求才会懒启动官方 Codex App Server。Codex 未登录或 App Server 失败时会显示真实错误，不会用模拟回答冒充联调成功。

## 五、什么时候需要 Cloudflare

本机连接器、NovelForge Runtime 和 Codex 都不要求登录 Cloudflare。只有作者自愿把画布书籍保存到自己的 Cloudflare Worker/D1/R2 时，才使用画布的 BYOC 登录。NovelForge 本机 SQLite 和 blob 不会因此自动上传。

## 六、兼容的手工目录模式

在无法安装连接器的机器上，仍可以用旧的 exchange 目录：

```powershell
.\scripts\novelforge.ps1 canvas-export <project_id>
```

在 NovelForge 面板展开“兼容模式”，选择返回的 `exchange\<project_id>` 目录。画布提案写入 `requests/` 后，手工执行 `canvas-process`。此模式不实时调用 Runtime/Codex，但保留同样的 digest、冲突和权威边界。

## 七、恢复、轮换与卸载

- 网页刷新：画布自动探测，不用重贴令牌。
- 重启电脑：登录 Windows 后连接器静默启动。
- 更换正式域名：重跑 `install.ps1 -CanvasOrigin https://新域名`。
- 令牌怀疑泄漏：重跑安装器并加 `-RotateToken`，然后在画布清除并重新配对。
- 卸载：运行 `connector\uninstall.ps1`。它不删 Engine、小说、画布书籍或 Codex 登录。
- 端口占用：用 `-Port <端口>` 重新安装，画布 endpoint 同步改为该端口。

## 八、`file://` 便携版限制

直接双击 `artifacts/Echo-8.html` 时，页面 origin 是 `null`。连接器会故意拒绝它，否则任意本地 HTML 都可以冒充画布。便携版仍可离线编辑 `.echo8` 和使用手工 exchange 目录；需要实时画布↔Engine↔Codex 时，必须使用 HTTP(S) 托管画布。

## 九、开发自检

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:e2e
pnpm run build:portable
pnpm run test:portable
```

手工目录投影仍可用以下命令只读校验：

```powershell
pnpm run verify:novelforge-exchange -- C:\path\to\exchange\BOOK-id
```
