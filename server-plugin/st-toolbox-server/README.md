# st-toolbox-server（宿主）

st-toolbox 的通用 SillyTavern 后端宿主。Node >=18，无第三方依赖。

**只需首次安装**：把此目录复制到 `SillyTavern/plugins/st-toolbox-server`，在酒馆 `config.yaml` 启用 `enableServerPlugins: true`，手动重启。

- 宿主不含业务代码：启动时从全局扩展目录 `public/scripts/extensions/third-party/st-toolbox/server/index.mjs` 加载后端实现（当前含 `tomatojuice` 模块）。更新 st-toolbox 扩展即更新后端，重启酒馆生效，无需再复制。
- 只信任全局（管理员“为所有用户安装”）的扩展目录；用户级扩展目录不会被加载为服务端代码。
- 宿主与实现之间的协议为 `HOST_ABI`；不一致时插件初始化失败并在日志提示重新复制本目录。
- 本地配置：可选 `tomatojuice.config.json` 放在**本目录**（扩展更新不会覆盖），启动时读取，不提供网络修改接口。字段见扩展 `server/modules/tomatojuice/config.js`。
- 缓存：`DATA_ROOT/_st-toolbox/tomatojuice-cache-v2`。
- 接口：`GET /api/plugins/st-toolbox-server/capabilities`，模块 `/api/plugins/st-toolbox-server/modules/tomatojuice/*`。
- 恢复 CLI：`node public/scripts/extensions/third-party/st-toolbox/server/tools/early-bridge.mjs status .`（在酒馆根目录）。
- TauriTavern 没有 Node 服务端插件，st-toolbox 在 TT 下不使用本后端，角色列表等全部走 TT 原生实现。

安全策略、保存冲突策略、日志归因和验收清单见扩展仓库 `docs/tomatojuice-migration.md`。扩展模块静态注册在 `server/index.mjs` 的 `modules`，实现 `{ id, version, capabilities, init(router, prefix), exit() }`；所有私有请求必须从酒馆认证用户上下文取得路径。
