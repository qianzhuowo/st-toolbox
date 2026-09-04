# ST Toolbox

一个按功能分目录组织的 SillyTavern 前端扩展，目前包含：

1. **QR 栏收起/展开**：在发送区加入切换按钮，并持久化收起状态。
2. **回复提示通知**：成功/错误提示音、自定义本地音频、标签页标题闪烁，以及生成事件去重。

## 安装位置

```text
SillyTavern/public/scripts/extensions/third-party/st-toolbox
```

重新加载 SillyTavern 后，设置页面位于：

```text
扩展设置 → 右侧栏（#extensions_settings2）→ ST Toolbox
```

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

## 注意事项

- 请停用 `SillyTavern-SimpleQRBarToggle` 和 `vertin-tips` 中对应的旧功能，否则可能出现两个 QR 按钮或重复提示音。
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
   └─ notifications/
      ├─ index.js
      ├─ style.css
      └─ audio/
         ├─ success.mp3
         └─ error.mp3
```
