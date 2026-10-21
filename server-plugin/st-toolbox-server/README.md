# st-toolbox-server

通用 SillyTavern 后端，当前包含 `tomatojuice` 性能模块。Node >=18，无第三方运行依赖。

把此**整个目录**手动复制到 `SillyTavern/plugins/st-toolbox-server`，在酒馆配置中启用 `enableServerPlugins: true`，由用户手动重启。不要将它安装到前端 `third-party` 扫描路径。

- 入口：`index.mjs`，导出 `info / init(router) / exit()`。
- 能力：`GET /api/plugins/st-toolbox-server/capabilities`。
- 模块：`/api/plugins/st-toolbox-server/modules/tomatojuice/*`。
- 本地配置：可选 `tomatojuice.config.json`（本目录），启动时读取，不提供网络修改接口。可参考 `modules/tomatojuice/config.js`；强制禁止占位空列表、自动核心修补和自动 HTML 安装。
- 缓存：`DATA_ROOT/_st-toolbox/tomatojuice-cache-v1`，不是此插件目录；不会因卸载时清空内存而删除磁盘。
- 诊断：默认不采集全局浏览器日志；启用 `browserLogCaptureEnabled` 后仅提供当前用户的限量日志，不捕获服务端全局 console。
- 安装 early bridge：在 Tomatojuice 管理区点击“检查首屏状态 → 安装／修复首屏接入”，管理员确认后备份并修改全站 `public/index.html`，刷新页面生效；撤销同理。管理区在前端优化关闭时仍可访问。必须启用宿主 CSRF 保护且具有有效会话；缺权限/旧后端/路径异常会明确提示。后端更新部署后需重启酒馆。
- 固定管理接口：POST `modules/tomatojuice/early/manage/status`、`early/install`、`early/uninstall`；写入仅管理员+有效会话 CSRF+JSON `{ "confirm": true }`，不接受路径/HTML。能力为 `early-management`；不提供通用文件编辑。
- CLI 保留为恢复工具：`node plugins/st-toolbox-server/tools/early-bridge.mjs install . --apply`，撤销为 `uninstall . --apply`。两者共用固定安装器及全局锁；不自动刷新页面或注销 SW。
- 没有 command-exec、任意 shell、在线下载更新或任意核心文件改写接口；仅上述显式确认的 HTML 入口安装/撤销。

完整对照、保存冲突策略、日志归因和验收清单见前端仓库的 `docs/tomatojuice-migration.md`。

扩展模块：静态注册到入口 `modules`，实现 `{ id, version, capabilities, init(router, prefix), exit() }`。所有私有请求必须从酒馆认证用户上下文取得路径，不从客户端接收用户目录或身份。
