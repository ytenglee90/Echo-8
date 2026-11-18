# Echo-8 本地工作区动作正式发布

2026-11-18 10:26:34（北京时间）发布至 https://echo8.ytenglee90.workers.dev，Cloudflare 确认新版本承载 100% 流量。

- 当前 Worker：`2436d44e-729e-4d38-8e13-cb457e312d89`。
- 回退参考：`8a6e87f0-fb05-4e02-95be-2e64cfd6744d`。
- 生产构建、Wrangler 打包预检及生产依赖审计通过；没有已知生产依赖漏洞。
- 已按发布流程备份控制 D1，备份仅在本机忽略目录；没有数据库、个人数据服务或书籍格式迁移。

## 发布内容

本地工作区动作、发送时选区绑定、完整子句编排、书库助手入口、明确对象及内部关系复制、运行时协议来源和六项跨类别动作映射。助手意图解析与定位继续在本机执行。运行时共 166 个动作适配及界面入口，目录存在与验收通过分别登记。

原始 528 条均已发送，262 条结果核验通过，22 条仍有识别或路由问题；新增复制动作独立三条语料均通过，未混入旧通过率。本轮本地自由生成验收仍缺少生成式模型，完整动作覆盖尚未关闭。

## 生产验证

- 本机运行生产构建包，Chromium 与 WebKit 共 14 项定向检查通过。
- 正式站 Chromium、WebKit、Firefox 各 7 项，共 21 项关键流程通过；使用独立浏览器上下文及测试书籍，没有写入真实用户书籍或调用真实模型。
- 覆盖具名复制及一次撤销、视口/设置组合、存档原文回读、窗格比例、书库返回、固定计划和 60% 聚焦。
- 正式站首页与匿名 `/api/cloud/status` 返回 200，匿名云状态配置有效。
- 新版前端脚本与本地构建 SHA-256 相同：`1086add8ecc2be6b3c713ba346367aefad49e09002aca946f530df9a2665134a`。
- 便携 HTML SHA-256：`49cde72a019db4a7ad7e6d30ffb8d517be167b4fc2aaf514272c9b76ace9f519`。

首次受限环境的 WebKit 正式站检查因 TLS 证书校验错误未进入应用；保持校验开启，在宿主环境复查 7/7 通过。Firefox 受限环境建页失败，宿主环境正式站 7/7 通过。未通过关闭证书校验或更改系统安全设置绕过问题。

## 完整跨浏览器回归的限制

| 入口 | Firefox | WebKit |
|---|---|---|
| 托管开发入口 | 275 项在 browserContext.newPage 阶段失败，未进入应用 | 265 通过，10 未通过 |
| 真实 file:// | 66 项在 browserContext.newPage 阶段失败，未进入应用 | 66 通过 |

完整门禁未全量通过，保留原始失败。托管 WebKit 的三项宿主串行复查为 2 通过、1 仍失败；持续失败项为纵向文本框标题连线在移动、形态转换及撤销中的端点侧向核对。其余七项未在本次追加复查中重复，不能因生产定向通过而关闭。

托管 WebKit 原始未通过用例：

- a node can connect into a junction and its separate port can pull out a new connection without moving the point
- vertically stacked text-box title links use the same side in preview, after commit, movement, conversion and undo
- mixed selection moves nodes, a box, a group and a junction together when dragging the node
- the reported short-wide, tall fan-out has a continuous trunk and shared junction tangents on both sides
- split-delete-reconnect follows the complete user workflow with the junction on either side
- free point drags use the point centre even when all existing legs approach from the opposite side
- selecting then dragging a junction keeps the last preview after release without rotating its preference
- edge panning follows a held box drag and stops on release
- edge panning follows a held junction drag and stops on release
- overlap cycling also works in batched rendering and survives deleting one of 601 coincident curves

发布前已有类型检查、ESLint、718 项单元、275 项 Chromium 托管、66 项 Chromium 便携及两千万字压力测试通过。新增接口有版本，旧调用与书籍数据保持兼容。

本轮生产日志、资源校验、备份及原始跨浏览器结果保存在忽略目录 `local-data/workspace-release-*`。完整跨浏览器失败与串行复查结果分别保存，没有以复查替换原始全量记录。
