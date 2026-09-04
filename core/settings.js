import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

export const EXTENSION_NAME = 'st-toolbox';

export const DEFAULT_SETTINGS = Object.freeze({
    version: 1,
    qrBar: {
        enabled: true,
        collapsed: false,
    },
    notifications: {
        enabled: true,
        soundEnabled: true,
        flashEnabled: true,
        onlyWhenUnfocused: false,
        volume: 0.5,
        successSound: 'builtin:success',
        errorSound: 'builtin:error',
    },
});

function cloneDefault(value) {
    return JSON.parse(JSON.stringify(value));
}

function applyDefaults(target, defaults) {
    for (const [key, defaultValue] of Object.entries(defaults)) {
        if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
            if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
                target[key] = {};
            }
            applyDefaults(target[key], defaultValue);
        } else if (target[key] === undefined) {
            target[key] = defaultValue;
        }
    }

    return target;
}

function normalizeSettings(settings) {
    settings.version = DEFAULT_SETTINGS.version;
    settings.qrBar.enabled = Boolean(settings.qrBar.enabled);
    settings.qrBar.collapsed = Boolean(settings.qrBar.collapsed);

    const notifications = settings.notifications;
    notifications.enabled = Boolean(notifications.enabled);
    notifications.soundEnabled = Boolean(notifications.soundEnabled);
    notifications.flashEnabled = Boolean(notifications.flashEnabled);
    notifications.onlyWhenUnfocused = Boolean(notifications.onlyWhenUnfocused);
    notifications.volume = Math.min(1, Math.max(0, Number(notifications.volume) || 0));
    notifications.successSound = typeof notifications.successSound === 'string'
        ? notifications.successSound
        : DEFAULT_SETTINGS.notifications.successSound;
    notifications.errorSound = typeof notifications.errorSound === 'string'
        ? notifications.errorSound
        : DEFAULT_SETTINGS.notifications.errorSound;
}

export function ensureSettings() {
    const current = extension_settings[EXTENSION_NAME];
    let changed = false;

    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        extension_settings[EXTENSION_NAME] = cloneDefault(DEFAULT_SETTINGS);
        changed = true;
    } else {
        const beforeDefaults = JSON.stringify(current);
        applyDefaults(current, DEFAULT_SETTINGS);
        changed = beforeDefaults !== JSON.stringify(current);
    }

    const resolved = extension_settings[EXTENSION_NAME];
    const beforeNormalization = JSON.stringify(resolved);
    normalizeSettings(resolved);
    changed ||= beforeNormalization !== JSON.stringify(resolved);

    if (changed) {
        saveSettingsDebounced();
    }

    return resolved;
}

export function saveToolboxSettings() {
    saveSettingsDebounced();
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function findSettingsHost() {
    for (let attempt = 0; attempt < 120; attempt++) {
        const host = document.getElementById('extensions_settings2');
        if (host instanceof HTMLElement) {
            return host;
        }
        await delay(250);
    }

    return null;
}

function createPanel() {
    const drawer = document.createElement('div');
    drawer.id = 'st-toolbox-settings';
    drawer.className = 'inline-drawer';

    const header = document.createElement('div');
    header.id = 'st-toolbox-settings-header';
    header.className = 'inline-drawer-header interactable';
    header.tabIndex = 0;
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', 'false');
    header.innerHTML = '<b>ST Toolbox</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>';

    const content = document.createElement('div');
    content.className = 'inline-drawer-content';
    content.style.display = 'none';

    const body = document.createElement('div');
    body.id = 'st-toolbox-settings-body';
    content.appendChild(body);

    const toggle = () => {
        const shouldOpen = header.getAttribute('aria-expanded') !== 'true';
        header.setAttribute('aria-expanded', String(shouldOpen));
        content.style.display = shouldOpen ? 'block' : 'none';
        const icon = header.querySelector('.inline-drawer-icon');
        icon?.classList.toggle('up', shouldOpen);
        icon?.classList.toggle('down', !shouldOpen);
    };

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });

    drawer.append(header, content);
    return { drawer, body };
}

export async function mountSettingsPanel(features) {
    const existing = document.getElementById('st-toolbox-settings');
    if (existing) {
        return true;
    }

    const host = await findSettingsHost();
    if (!host || document.getElementById('st-toolbox-settings')) {
        if (!host) {
            console.warn('[st-toolbox] 未找到 #extensions_settings2，设置页面未挂载。');
        }
        return Boolean(document.getElementById('st-toolbox-settings'));
    }

    const { drawer, body } = createPanel();

    for (const feature of features) {
        try {
            feature.render(body);
        } catch (error) {
            console.error(`[st-toolbox] 设置小节渲染失败：${feature.id}`, error);
            const message = document.createElement('div');
            message.className = 'st-toolbox-help';
            message.textContent = `${feature.title}设置加载失败，请查看控制台。`;
            body.appendChild(message);
        }
    }

    host.appendChild(drawer);
    return true;
}
