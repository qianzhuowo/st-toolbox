# ST Toolbox

一个按功能分目录组织的 SillyTavern 前端扩展，目前包含：

1. **QR 栏收起/展开**：在发送区加入切换按钮，并持久化收起状态。
2. **回复提示通知**：成功/错误提示音、自定义本地音频、标签页标题闪烁，以及生成事件去重。
3. **消息截图**：单条、相邻范围和任意多选截图，显式合成 SillyTavern 与 Moonlit Echoes 背景。

## 安装位置

```text
SillyTavern/public/scripts/extensions/third-party/st-toolbox
```

重新加载 SillyTavern 后，设置页面位于：

```text
扩展设置 → 右侧栏（#extensions_settings2）→ ST Toolbox
```

ST Toolbox 内的每个功能都有独立折叠栏，展开状态会保存到 `extension_settings['st-toolbox'].ui.sections`，刷新后恢复；后续增加功能时不会让整个设置页面持续变长。

## QR 栏

- “启用 QR 栏切换按钮”打开时，切换按钮会出现在发送区扩展菜单按钮旁。
- 点击按钮，或在按钮聚焦时按 `Enter` / 空格，可收起和展开 Quick Reply 栏。
- 状态保存在 `extension_settings['st-toolbox'].qrBar.collapsed` 中，刷新页面和切换聊天后会恢复。
- 若 Quick Reply 栏尚未创建，插件会等待其出现；界面重绘后也会自动重新挂载。

## 提示通知

### 判定规则

- 只跟踪真正进入生成流程的可见回复。
- `dry-run`、`quiet`、`impersonate` 和被斜杠命令提前终止的生成不会提醒。
- 可见角色消息写入并完成渲染，且当前生成链不再继续：成功提醒。
- 流处理器明确失败，或生成进入空闲后持续没有有效角色消息：错误提醒。
- 点击停止按钮属于用户取消，不播放错误音。
- 自动续写、自动换页和函数工具递归按独立 generation leg 跟踪，只以生成链的最后结果提醒，避免中间步骤连续提示。
- 群聊按成员划分 generation leg，并只在整轮 `GROUP_WRAPPER_FINISHED` 后汇总提醒一次。

### 自定义音频

- 成功音和错误音可以分别选择、试听、上传和删除。
- 支持浏览器可播放的常见格式，包括 mp3、wav、ogg、m4a、aac、flac；单个文件上限 15 MB，最多保存 30 个。
- 上传内容只保存在当前浏览器的 IndexedDB，不上传到 SillyTavern 服务器；设置列表只常驻元数据，播放时才按 ID 读取 Blob。若另一浏览器缺少所选文件，设置页会保留选择并标为“本浏览器不可用”，不会反向清空服务器设置。
- 插件不会扫描或 HEAD 请求猜测的文件名，因此不会像候选文件扫描方案那样主动产生大量 404。

### 标签页闪烁

- 页面隐藏或窗口失焦时，标题会在原始标题和提醒标题之间切换。
- 页面重新可见或窗口重新获得焦点后立即停止；仅当当前标题仍是插件写入的值时恢复原始标题，避免覆盖其它扩展的新标题。
- 不替换 favicon，因此不需要额外 favicon 请求。

## 消息截图

### 使用方式

- 每条消息按钮区会出现相机按钮，单击截取当前消息。
- 长按相机按钮 500 ms，可选择截取当前消息及前后 1–4 条消息。
- 扩展菜单中的“多选截图”可任选多条消息，再拼接为一张长图。
- 消息新增或聊天重绘后会自动补挂按钮；同一时间只执行一个截图任务。
- 一次截图只创建并复用一个消息渲染上下文，loading 只旋转原相机图标、不替换按钮子节点；截图前冻结布局，并像参考插件一样完全不写入 `#chat.scrollTop`、document 或 window 滚动位置。
- 切换聊天后会先等待 SillyTavern 的滚动、字体和媒体布局稳定，再一次性补挂固定尺寸按钮；第一次点击会等待当前聊天稳定，不会被插件自身的按钮 mutation 取消。

### 输出设置

- 支持 1–3 倍缩放；倍率会同时放大输出宽度和高度，例如 2× 的总像素数约为 1× 的 4 倍。过长图片会自动降低倍率，超过浏览器安全 Canvas 尺寸时停止并提示。
- 支持 PNG、JPEG、WebP；图片质量只控制 JPEG/WebP 的压缩程度，数值越高细节越完整、文件越大，PNG 不受该设置影响。
- 背景模式包括：当前 SillyTavern 背景、主题纯色、透明背景。JPEG 不支持透明，选择透明模式时会自动铺主题底色。

### Moonlit Echoes 背景修复

Moonlit Echoes 将 `#chat` 设为透明，并把真实视觉背景拆分到 `body`、负层级 `#bg1` 和 `#sheld::before`。直接克隆 `.mes` 时这些祖先/兄弟层不会被截入，因此旧插件导出的 PNG/WebP 可能透明。

ST Toolbox 会为每次截图单独构建背景 Canvas：

1. 先铺经过 alpha 合成的 body 主题底色，保证基础像素不透明。
2. 在克隆中把负层级背景改为可绘制层；若 DOM 渲染失败，再按 `background-size/position/opacity/filter` 直接绘制背景图片。
3. 合成 `#sheld::before` 的半透明色和 backdrop blur，再叠加 `#chat` tint；复杂的消息内部 backdrop-filter 采用近似效果。
4. 最后绘制消息前景。背景图片读取失败时仍保留不透明主题底色，不会重新变成透明图。

处理过程不会修改真实 `#bg1/#sheld/#chat` 的 inline style，也不会像参考插件那样临时隐藏聊天区域。

## 注意事项

- 请停用 `SillyTavern-SimpleQRBarToggle`、`vertin-tips` 和 `html2canvas-pro` 中对应的旧功能，否则可能出现重复 QR 按钮、提示音或截图按钮。
- 如果 SillyTavern 自带的 **Message Sound** 仍处于启用状态，它会与本插件的自定义成功音各播放一次；只需要一套声音时请关闭其中一项。
- 浏览器可能在用户首次与页面交互前阻止自动播放；通常发送第一条消息后即可正常播放，也可先在设置页点击试听。
- 两个内置提示音来自本地 `vertin-tips` 参考扩展中实际存在的音频，并复制到本扩展自己的固定资源路径；运行时不会依赖参考扩展。

## 目录

```text
st-toolbox/
├─ manifest.json
├─ index.js
├─ style.css
├─ core/
│  └─ settings.js
└─ features/
   ├─ qr-bar/
   │  ├─ index.js
   │  └─ style.css
   ├─ notifications/
   │  ├─ index.js
   │  ├─ style.css
   │  └─ audio/
   │     ├─ success.mp3
   │     └─ error.mp3
   └─ screenshot/
      ├─ index.js
      ├─ style.css
      └─ vendor/
         ├─ modern-screenshot.umd.js
         ├─ worker.js
         └─ NOTICE.md
```

截图 vendor 来自 MIT 许可的 `modern-screenshot`；来源、原始本地文件哈希和许可全文记录在 `features/screenshot/vendor/NOTICE.md`。
