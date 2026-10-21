# Echo-8 Cloudflare BYOC 部署与验收

本文对应公开模式：所有人从你的统一网址进入；每位用户用自己的 Cloudflare 账户登录；每位用户的画布正文只写入其账户中的 Worker 和 D1。R2 是以后可选的容量升级，不是首次安装条件。

## 运行结构

```text
你的域名（主站 Worker + 静态资源）
  ├─ 浏览器下载前端并在本机执行画布交互
  ├─ 控制 D1：用户、OAuth 授权、安装位置（不存画布正文）
  └─ 为浏览器签发 10 分钟数据令牌
                  │
                  └── 浏览器直接访问用户账户
                        ├─ echo8-data-* Worker：鉴权、租约、同步协议
                        └─ D1：书籍目录、提交序列、版本头、编辑租约、检查点和 64 KiB 正文分块
```

用户第一次访问时只下载 HTML、CSS、JavaScript 等前端资源，不会安装桌面程序。后续静态资源由浏览器和 Cloudflare 边缘缓存；编辑计算在用户设备上进行，正文同步请求直接进入该用户自己的 Worker，所以用户数增加不会让一台应用服务器承担所有画布计算或正文流量。

## 已实现能力

- Cloudflare Authorization Code OAuth；服务端保管 client secret，浏览器不会收到长期 OAuth 令牌。
- 用户在 Cloudflare 授权页选择可访问账户，应用内再选择实际安装账户。
- 可重试的自动安装：D1、数据 Worker、数据库迁移和 workers.dev 开关。
- 已安装数据 Worker 的版本检测与一键原地升级；失败不切换版本，也不删除旧数据。
- 每位用户可以创建多本云书籍；启动后自动连接上次书籍。
- 本地 IndexedDB 恢复副本、16 MiB 待上传提交队列、增量操作和周期检查点。
- 正文块从操作 JSON 中外置到 D1 的独立分块表；结构检查点按 UTF-8 边界分片；云端共享书籍不携带浏览器撤销历史。
- 同一本书默认一台设备编辑；另一台只读，可明确接管。
- 本机和云端同时前进时不静默覆盖；先建立本机恢复点，再由用户载入云端。
- 短时数据 JWT、严格 CORS、OAuth token 加密保存、安装级签名密钥。

这不是多人实时协同编辑。当前策略是“单人、跨设备、一次一台设备编辑”，没有引入 CRDT。

## 一、准备主站 Cloudflare 账户

1. 将你的域名接入 Cloudflare，并确定最终网址，例如 `https://canvas.example.com`。
2. 在用于托管主站的账户启用 Workers 与 D1。
3. 登录仓库目录，执行：

```powershell
pnpm exec wrangler login
pnpm run cloud:db:create
```

4. 复制命令返回的 D1 UUID，同时修改两处：

   - `wrangler.jsonc` 的 `database_id`；
   - 本机 `.env.production.local` 的 `ECHO8_CONTROL_DB_ID`。

5. 初始化主站控制库：

```powershell
pnpm run cloud:db:migrate
```

主站控制库只存用户、加密后的 OAuth grant、用户所选账户、个人数据 Worker 地址和安装状态，不存画布正文。

## 二、创建公开 Cloudflare OAuth 客户端

Cloudflare Dashboard → Manage Account → OAuth clients → Create client：

- Flow：Authorization Code。
- Token authentication：`client_secret_basic`。
- Redirect URL：`https://canvas.example.com/api/cloud/oauth/callback`，必须逐字一致。
- Client URL：你的正式域名；完成 DNS TXT 域名所有权验证。
- Allowed CORS origin：`https://canvas.example.com`。
- 必需权限：
  - User Memberships Read；
  - Workers Scripts Write；
  - D1 Write；
  - OpenID `profile` / `email`；
  - 若控制台提供离线授权，加入 `offline_access`。
- 完成测试后把客户端永久提升为 Public。Cloudflare 的 Public 转换不可逆，先确认域名、名称、Logo、隐私政策和服务条款。

把 Cloudflare 控制台显示的精确 scope ID 以空格分隔写入 `CLOUDFLARE_OAUTH_SCOPES`。权限显示名和 OAuth scope ID 不是同一概念，不要凭文档示例猜 ID。

## 三、设置主站配置与秘密

编辑 `wrangler.jsonc`：

- `name` 改成你的 Worker 名；
- `PUBLIC_APP_ORIGIN` 改成正式 HTTPS Origin；
- `database_id` 改成第一步创建的控制 D1 UUID；
- 如需自定义域名，在 Cloudflare Dashboard 为主站 Worker 添加 Custom Domain。

写入运行时秘密：

```powershell
pnpm exec wrangler secret put CLOUDFLARE_OAUTH_CLIENT_ID
pnpm exec wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET
pnpm exec wrangler secret put CLOUDFLARE_OAUTH_SCOPES
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put TOKEN_ENCRYPTION_KEY
```

`SESSION_SECRET` 与 `TOKEN_ENCRYPTION_KEY` 必须分别生成、至少 32 个随机字节，不能相同。不要提交 `.env.production.local`、`.dev.vars` 或任何真实 secret；仓库已忽略这些文件。

## 四、构建与部署主站

发布前本机门禁：

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```

部署：

```powershell
pnpm run deploy:cloudflare
```

该项目由 Workers 托管动态 OAuth/API 路由和静态前端；无需再创建 Cloudflare Pages 项目。若你仍使用 Sites 发布路径，`.openai/hosting.json` 已声明同名 `CONTROL_DB` 逻辑绑定，但真实 Cloudflare 生产发布仍必须把 D1 UUID 与 secrets 配到目标环境。

## 五、手动验收

按以下顺序测试，任何一步失败都先看浏览器 Network 和主站 Worker 日志：

1. 未登录打开正式网址，画布可本地编辑，顶部显示“连接云端”。
2. 连接 Cloudflare，授权页明确显示上述四项资源权限和所选账户。
3. 回到画布，选择账户并安装；该账户中出现一个 `echo8-data-*` Worker 和一个 D1，不要求绑定付款方式。
4. 新建或编辑节点，顶部从“同步中”回到书籍名；点击“立即同步”无错误。
5. 用另一台设备或无痕窗口登录同一 Cloudflare 用户，打开同一本书，应看到第一台设备内容。
6. 第一台仍打开时，第二台显示只读；点“接管编辑权”后第二台可编辑，第一台下一次同步转只读。
7. 断网编辑几次，状态显示“离线保存”；恢复网络后待上传数字归零。
8. 人为制造两端同时前进，界面必须显示冲突，不得静默覆盖；选择“保存恢复点并载入云端”后，本机旧版本可从恢复点找回。
9. Cloudflare Dashboard 撤销 OAuth 授权后，主站不得继续创建资源；重新授权可恢复。

## 六、运维、升级与删除

- 数据 Worker 的 schema 在 `cloud/data-worker/schema.sql`；控制面 schema 在 `cloud/control/schema.sql`。
- 每次发布先备份控制 D1，并在测试账户完成完整安装与跨设备回归。
- 数据 Worker 源码随主站构建打包；已有安装不会在后台静默改写。修改数据 Worker、绑定或 D1 schema 时，递增 `CLOUD_DATA_WORKER_VERSION`。主站状态会提示版本落后，用户点击“一键升级”后在原 Worker 和原 D1 上执行幂等迁移。只改主站界面时不要递增该版本。
- 当前 UI 的“退出账户”只清除主站会话，不删除用户账户里的 Worker/D1/R2。删除云资源属于不可恢复操作，应在后续版本提供列出资源和二次确认的卸载页。
- 用户正文容量由其 Cloudflare 套餐决定。D1 免费计划更适合文字画布；需要更大对象容量时可按 ADR-0068 显式升级到 R2。应用本身不承诺固定免费容量。

## 常见失败

- “云同步尚未配置”：缺少 `CONTROL_DB` 绑定、Origin 或四个 secret 中任一项。
- OAuth callback 状态失败：访问时域名与 `PUBLIC_APP_ORIGIN` 不一致，或 Redirect URL 不完全匹配。
- 安装返回 403：OAuth 客户端缺少 D1 / Workers Scripts 写权限，或账户管理员禁用了 Public OAuth App access。
- 找不到 workers.dev 地址：用户账户尚未设置 workers.dev 子域名，先在该账户 Workers 页面完成一次子域名设置。
- 本地开发 OAuth 失败：OAuth 客户端没有登记 `http://localhost:3000/api/cloud/oauth/callback`；正式客户端应只保留 HTTPS 地址。
