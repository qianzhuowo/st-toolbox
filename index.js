import { eventSource, event_types, isGenerating } from '../../../../script.js';
import { ensureSettings, mountSettingsPanel, saveToolboxSettings, synchronizeSettings } from './core/settings.js';
import { createQrBarFeature } from './features/qr-bar/index.js';
import { createNotificationsFeature } from './features/notifications/index.js';
import { createScreenshotFeature } from './features/screenshot/index.js';
import { createChatExportFeature } from './features/chat-export/index.js';
import { createTomatojuiceFeature } from './features/tomatojuice/index.js';

const LOAD_GUARD = '__stToolboxLoaded';

async function initialize() {
    if (globalThis[LOAD_GUARD]) {
        return;
    }

    globalThis[LOAD_GUARD] = true;

    const settings = ensureSettings();
    const featureContext = {
        eventSource,
        eventTypes: event_types,
        settings,
        saveSettings: saveToolboxSettings,
        isGenerating,
    };

    const qrBar = createQrBarFeature(featureContext);
    const notifications = createNotificationsFeature(featureContext);
    const screenshot = createScreenshotFeature(featureContext);
    const chatExport = createChatExportFeature(featureContext);
    const tomatojuice = createTomatojuiceFeature(featureContext);

    qrBar.init();
    screenshot.init();
    chatExport.init();

    try {
        await notifications.init();
    } catch (error) {
        console.error('[st-toolbox] 提示通知模块初始化失败：', error);
    }

    try { await tomatojuice.init(); }
    catch (error) { console.error('[st-toolbox] tomatojuice 初始化失败，保留原生行为：', error); }

    const mountPanel = () => void mountSettingsPanel([
        { id: 'qr-bar', title: 'QR 栏收起/展开', render: qrBar.renderSettings },
        { id: 'notifications', title: '回复提示通知', render: notifications.renderSettings },
        { id: 'screenshot', title: '消息截图', render: screenshot.renderSettings },
        { id: 'chat-export', title: '对话导出', render: chatExport.renderSettings },
        { id: 'tomatojuice', title: '茄汁 · 启动与交互优化', render: tomatojuice.renderSettings },
    ]);
    const synchronize = () => {
        synchronizeSettings(settings);
        qrBar.syncSettings?.();
        notifications.syncSettings?.();
        screenshot.syncSettings?.();
        chatExport.syncSettings?.();
        tomatojuice.syncSettings?.();
        mountPanel();
    };

    mountPanel();
    eventSource.on(event_types.APP_READY, mountPanel);
    eventSource.on(event_types.SETTINGS_LOADED, synchronize);
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, synchronize);

    console.info('[st-toolbox] 扩展已加载');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initialize(), { once: true });
} else {
    void initialize();
}
