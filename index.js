import { eventSource, event_types, isGenerating } from '../../../../script.js';
import { ensureSettings, mountSettingsPanel, saveToolboxSettings } from './core/settings.js';
import { createQrBarFeature } from './features/qr-bar/index.js';
import { createNotificationsFeature } from './features/notifications/index.js';

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

    qrBar.init();

    try {
        await notifications.init();
    } catch (error) {
        console.error('[st-toolbox] 提示通知模块初始化失败：', error);
    }

    const mountPanel = () => void mountSettingsPanel([
        { id: 'qr-bar', title: 'QR 栏', render: qrBar.renderSettings },
        { id: 'notifications', title: '提示通知', render: notifications.renderSettings },
    ]);

    mountPanel();
    eventSource.on(event_types.APP_READY, mountPanel);
    eventSource.on(event_types.SETTINGS_LOADED, mountPanel);

    console.info('[st-toolbox] 扩展已加载');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initialize(), { once: true });
} else {
    void initialize();
}
