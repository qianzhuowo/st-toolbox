# st-toolbox-server

通用 SillyTavern 后端，当前包含 `tomatojuice` 性能模块。Node >=18，无第三方运行依赖。

把此**整个目录**手动复制到 `SillyTavern/plugins/st-toolbox-server`，在酒馆配置中启用 `enableServerPlugins: true`，由用户手动重启。不要将它安装到前端 `third-party` 扫描路径。

- 入口：`index.mjs`，导出 `info / init(router) / exit()`。
- 能力：`GET /api/plugins/st-toolbox-server/capabilities`。
- 模块：`/api/plugins/st-toolbox-server/modules/tomatojuice/*`。
- 本地配置：可选 `tomatojuice.config.json`（本目录），启动时读取，不提供网络修改接口。可参考 `modules/tomatojuice/config.js`；强制禁止占位空列表、自动核心修补和自动 HTML 安装。
- 缓存：`DATA_ROOT/_st-toolbox/tomatojuice-cache-v1`，不是此插件目录；不会因卸载时清空内存而删除磁盘。
- 安全默认：不注册 SW，不代理核心模块，不桥接保存请求。可选异步桥接仅加速角色列表/version，含响应体最多等待 2 秒，失败走原生读取；后端删除不会使新版 HTML 的原生核心模块 URL 失效。旧 HTML / 尚未更新的旧 SW 需先完成一次性迁移。
- 冷缓存：默认等待 1.5 秒，超时返回快速接口错误而不是空角色列表；显式 `blockCharactersAllOnMiss: true` 最多等待 10 秒。共享构建总期限 10 秒，并传播取消信号；原生读取耗时不受该期限限制。
- 诊断：不再挂载全局浏览器日志采集；保留有界、按用户隔离的日志 API，不捕获服务端全局 console。
- 安装 early bridge：在 Tomatojuice 管理区点击“检查首屏状态 → 安装／修复首屏接入”，管理员确认后备份并修改全站 `public/index.html`，刷新页面生效；撤销同理。管理区在前端优化关闭时仍可访问。必须启用宿主 CSRF 保护且具有有效会话；缺权限/旧后端/路径异常会明确提示。后端更新部署后需重启酒馆。
- 固定管理接口：POST `modules/tomatojuice/early/manage/status`、`early/install`、`early/uninstall`、`early/cleanup-legacy`；写入仅管理员+有效会话 CSRF+JSON `{ "confirm": true }`，不接受路径/HTML。能力为 `early-management`；不提供通用文件编辑。
- CLI 保留为恢复工具：`node plugins/st-toolbox-server/tools/early-bridge.mjs status .` 只读检查，`install . --apply` 安装可选桥接，`uninstall . --apply` 恢复 toolbox 原生入口，`cleanup-legacy . --apply` 清理可识别 cocktail-plus HTML。共用固定安装器及全局锁；先备份，拒绝未知标记内容，不自动刷新或注销 SW。页面打不开时，也可直接运行前端仓库随附目录内的 CLI，无需先部署后端。
- 没有 command-exec、任意 shell、在线下载更新或任意核心文件改写接口；仅上述显式确认的 HTML 入口安装/撤销。

完整对照、保存冲突策略、日志归因和验收清单见前端仓库的 `docs/tomatojuice-migration.md`。

扩展模块：静态注册到入口 `modules`，实现 `{ id, version, capabilities, init(router, prefix), exit() }`。所有私有请求必须从酒馆认证用户上下文取得路径，不从客户端接收用户目录或身份。
