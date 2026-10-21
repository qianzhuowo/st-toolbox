# 茄汁 / tomatojuice 移植、部署与验证

## 范围与来源

从本机 `cocktail` 0.1.17、`cocktail-plus` 0.1.24（作者均为 Limerence）迁入；以**实际入口与源码**而非过时 README 的“三模块”描述为准。保留优化器原算法及注释，前端模块统一命名 `tomatojuice`。没有修改源插件、运行中酒馆核心，也没有部署、重启或自动修改当前 HTML。

### 完整功能对照

| 上游功能 | 茄汁 / tomatojuice 位置 / 处理 | 默认与限制 |
|---|---|---|
| 启动解罩、提示、列表预取/去重 | `optimizers/modules/startup-optimizer.js` | 保留；启动列表快照改为单次消费，避免永久复用 |
| 分批聊天渲染、渲染调度 | `chat-render-optimizer.js` | 保留上游控制项 |
| 正则刷新调度 | `regex-refresh-optimizer.js` | 保留；仅 ST >= 1.14 且版本可判定时加载 |
| 预设拖拽优化 | `preset-drag-optimizer.js` | 保留 |
| 聊天保存解除 UI 阻塞 | `chat-saving-unblocker.js` | 保留；后端差量保存仍执行原生保存 |
| UI 动画优化 | `ui-animation-optimizer.js` | 保留 |
| 世界书拖拽优化 | `worldinfo-drag-optimizer.js` | 保留 |
| 正则拖拽优化 | `regex-drag-optimizer.js` | 保留 |
| 世界书面板精简 | `worldinfo-panel-slim.js` | 保留 |
| 上游自动更新检查器 | 安全替代：酒馆原生扩展更新 | 不再后台下载、执行命令或替换仓库 |
| cocktail-plus 安装器 | 安全替代：本目录部署说明、显式 CLI | 不再安装另一个旧扩展/后端 |
| HTML 渲染缓存实验 | `html-render-cache.js` | 与上游相同，**未加载**（上游因 bug 注释掉） |
| 预设面板优化实验 | `preset-panel-optimizer.js` | 与上游入口相同，**未加载** |
| plus TS 客户端/状态面板 | `client/` → `runtime.js`，统一设置内嵌 | 提供探测、预热、清理、状态、SW、用户日志 |
| `/version` 缓存 | 后端 `endpoints/version.js` | 默认首次获取真实原生结果，不伪造“最新版本”；后续持久复用 |
| `/api/characters/all` | 后端 `endpoints/characters-all.js` | 并行读卡、真实 shallow 列表、持久化；异常卡回退原生，不缓存部分空列表 |
| `/api/characters/get`、角色编辑差量 | `characters-get.js`、`characters-edit.js` | 保留；冲突 409，不自动覆盖新卡数据 |
| settings/get 并行读取/缓存 | `settings-get.js` | 保留原响应字段，不裁剪预设、主题等 |
| settings/save hash/no-op/patch | `settings-save.js` | 原型键校验、哈希验证，最终调用原生保存；按用户串行 |
| 单聊、群聊差量保存 | `chat-save.js` | 保留 metadata/force/identity 与完整聊天数组；最终调用原生保存 |
| 最近聊天、尾部读取/浅对象补全 | `recent-chats.js`、module proxy | 保留；增加路径边界检查 |
| 模板并行预载、XHR 复用、启动数据预取 | `early-bridge.js` | 晚加载可优化后续请求；真正首屏需显式注入 |
| 启动模块/i18n/system messages/extensions/welcome 改写 | `module-proxy.js` | 只改 HTTP 响应，严格白名单；默认不推迟扩展激活到 APP_READY 后 |
| Service Worker 原接口回退/模板能力 | `service-worker.js` | 生成器保留；**仅手动注册**，拒绝覆盖其他根 SW |
| 浏览器日志采集 | `user-logs.js` | 默认不挂全局采集；可配置启用，用户隔离、限长限量；不再劫持服务端全局 console |
| 自动 patch 核心 `chats.js` | **不迁移副作用** | 替换为原生保存/读取失败透传；不自动修补核心 |
| early HTML 安装/撤销、备份 | 管理员面板 + `tools/early-bridge.mjs` 共用固定操作 | 面板确认/CLI `--apply`；原子写 HTML；备份放 `data/_st-toolbox/html-backups` |
| 独立前后端下载更新、安装 shell helpers | **安全替代**：原生前端更新、手动复制后端 | 没有远程下载执行或任意命令路由 |

数量澄清：实际入口包含 **9 个优化功能模块 + 1 个更新检查器 + 1 个 plus 安装器**，合计 11 个导入项；另有 2 个未启用实验模块。最初进度中“10 个启用优化模块”是把更新检查器算入但未算安装器的粗分类；不是丢失第十个优化功能。

## 目录与架构

```text
features/tomatojuice/index.js            统一面板、冲突检测、模块加载
features/tomatojuice/client/             可维护 TS 客户端源码
features/tomatojuice/runtime.js          已提交的浏览器构建产物
features/tomatojuice/optimizers/         原优化器 + 面板/设置适配
core/backend-client.js                  通用能力发现、命名模块请求
server-plugin/st-toolbox-server/
  index.mjs                             通用入口 /capabilities 与模块生命周期
  modules/tomatojuice/                   独立模块、缓存及路由
  tools/early-bridge.mjs                 显式安装/撤销工具
```

后续模块只需导出 `{ id, version, capabilities, init(router, prefix), exit() }`，在通用入口的静态 `modules` 列表注册；不从请求参数动态 import。模块路由为 `/api/plugins/st-toolbox-server/modules/<id>/...`。能力发现列出成功初始化模块。

## 部署（本轮未执行）

1. **先迁出旧组件的运行状态**：在旧 plus 面板注销其 SW、用旧工具撤销旧 early bridge；禁用 `cocktail` / `cocktail-plus` 前端与旧后端，并刷新浏览器。不要在两个优化器叠加情况下比较性能。茄汁 / tomatojuice 会检查旧脚本、旧 bridge 和旧 SW，检测到便不叠加安装。
2. 前端文件已位于 `st-toolbox`，无需安装到另一个 `tomatojuice` 目录。普通使用不需要 Node 构建；修改 TS 后运行 `npm ci --ignore-scripts`、`npm run build:tomatojuice`。
3. 把**整个** `server-plugin/st-toolbox-server` 目录复制为 `SillyTavern/plugins/st-toolbox-server`，不是复制到 `third-party`。升级已有部署时保留目标目录中的 `tomatojuice.config.json` 等用户配置，只更新程序文件。后端无需 npm install，无额外运行依赖。酒馆 `config.yaml` 中启用 `enableServerPlugins: true`，由用户手动重启酒馆。
4. 进入“扩展设置 → ST Toolbox → 打开工具箱设置 → 茄汁 / tomatojuice”，后端应显示可用。后端缺失只进行一次能力探测，不安装加速 bridge，保留原生请求。
5. 可选：需要真正首屏加速和核心 dynamic-styles 响应修复时，在 茄汁 / tomatojuice 的“首屏优化与 dynamic-styles 兼容修复”管理区查看自动检查结果（也可点击 **检查首屏状态**），再点击 **安装／修复首屏接入**，阅读确认后执行，再保存当前工作并刷新页面。通常只需安装一次，不必打开终端或每次执行。

   此操作会修改所有用户共用的 `public/index.html`，添加带标记的提前加载脚本/import map 和指定模块标签；**不修改核心 JS 磁盘文件**。服务端先备份再原子写入，备份放在 `data/_st-toolbox/html-backups`，不在扩展扫描路径。重复安装幂等；旧 cocktail-plus HTML 接入、路径符号链接或异常标记会拒绝安装。酒馆更新覆盖 HTML 后，可重新检查／修复。

   **权限与升级**：必须更新部署后的后端（支持 `early-management` 能力），并使用管理员账户；关闭多用户账户时酒馆默认用户本身是管理员。写操作额外校验酒馆会话 CSRF token，即使宿主关闭保护也不会放行；若面板提示会话不可用，请重新开启酒馆 CSRF 保护并重启、刷新。后端需要目标目录读写权限，不执行 shell，也不接受客户端路径或 HTML。面板首次渲染会自动只读检查；重新打开设置或切回茄汁分类时通过 `st-toolbox:settings-visible` 再次检查，忙碌期间会合并检查请求；保留手动检查按钮。检查状态本身不会安装或注册 SW，安装及撤销始终需要显式确认。

   关闭前端优化开关或检测到旧插件冲突时，管理区仍可访问；冲突时禁止安装但保留本插件撤销入口。操作期间按钮锁定；失败或断网后先重新检查状态，不自动重试写入。成功后提示手动刷新，不打断当前聊天。首屏入口为全局设置，**不随前端优化开关或用户切换自动撤销**。

6. SW 不是必需项。仅在确认没有其他根作用域 SW 后，手动点击“注册可选 SW”；HTTP 非 localhost 一般不能注册（浏览器安全上下文限制）。不自动抢占其他 SW。

### 回滚

优先在管理区点击 **检查首屏状态 → 撤销首屏接入**，确认后执行；再注销本插件 SW，保存工作并刷新页面。也可用以下 CLI 恢复（从酒馆根目录执行）：

```powershell
node plugins/st-toolbox-server/tools/early-bridge.mjs uninstall . --apply
```

在面板注销 tomatojuice SW；关闭 茄汁 / tomatojuice，刷新页面。卸载前端/后端前先撤销 early 标签与 SW，否则浏览器可能仍请求已删除的后端脚本。撤销只移除本插件标记和代理标签，保留安装之后的用户 HTML 编辑；异常时可手动检查 `data/_st-toolbox/html-backups`。单独关闭前端开关不能撤销**用户先前显式安装**的 early HTML/SW，二者必须分别撤销。


**尚未执行真实浏览器和运行中酒馆端到端测试，不把源码迁入等同于功能验证。** 尤其须手动验收：

1. 真正重启后已有缓存命中，首次无缓存不清除 active_character；大型卡库首建仍可能较慢，这是保存正确性优先的取舍。
2. PNG/WebP/APNG/特殊卡片、嵌入世界书、角色创建/导入/编辑/删卡/重命名/复制，列表无需整页刷新；后端不支持的卡格式走原生。
3. 单聊/群聊长记录的追加、编辑、删除、续写、`force` 保存、跨标签冲突、断网后的“不确定写入”提示与手工恢复。
4. 九个优化器的真实 DOM、拖拽、正则刷新、聊天渲染、主题动画；这些保留了上游依赖核心 DOM/私有实现的版本敏感性。
5. 首屏 import map、脚本代理与其他插件的加载顺序；默认关闭上游“APP_READY 后再激活扩展”，避免生命周期竞态。升级酒馆后应检查代理诊断，再决定是否保留该模式。
6. 浏览器 CSSOM 的实际 selector 支持、scrollbar/主题的 focus-visible；只有生成逻辑和源码转换完成测试，未声称浏览器 SyntaxError 已现场消失。
7. 多用户登录切换、反向代理、HTTPS/自签名证书、SW 生命周期/CSP。内部请求使用真实 socket 本地端口与 loopback，不信任 Host；默认验证 TLS，自签名需服务器管理员在本地配置中显式选择信任策略。

不提供对第三方插件错误的全局屏蔽；不修改核心 JS 源码。HTML 入口只在管理员面板确认或 CLI `--apply` 后修改，不自动安装；不自动移动旧备份、不自动下载或执行升级命令。
