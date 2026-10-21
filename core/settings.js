import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { createSettingsWindow, createSettingsLauncher } from '../ui/settings-window.mjs';

export const EXTENSION_NAME = 'st-toolbox';

export const DEFAULT_SETTINGS = Object.freeze({
    version: 3,
    tomatojuice: { enabled: true },
    ui: {
        sections: {
            'qr-bar': false,
            notifications: false,
            screenshot: false,
            'chat-export': false,
            tomatojuice: false,
        },
    },
    qrBar: {
        enabled: true,
        collapsed: false,
    },
    notifications: {
        enabled: true,
        soundEnabled: true,
        flashEnabled: true,
        flashIconEnabled: true,
        flashIcon: '',
        onlyWhenUnfocused: false,
        volume: 0.5,
        successSound: 'builtin:success',
        errorSound: 'builtin:error',
    },
    chatExport: {
        enabled: true,
        role: 'all',
        format: 'txt',
        includeSystem: false,
        removeReasoning: true,
        tags: '',
    },
    screenshot: {
        enabled: true,
        showMessageButtons: true,
        buttonPlacement: 'inline',
        showMultiSelectButton: true,
        scale: 2,
        format: 'png',
        quality: 0.92,
        backgroundMode: 'current',
        neighborCount: 4,
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
    for (const key of Object.keys(DEFAULT_SETTINGS.ui.sections)) {
        settings.ui.sections[key] = Boolean(settings.ui.sections[key]);
    }
    settings.tomatojuice.enabled = Boolean(settings.tomatojuice.enabled);
    settings.qrBar.enabled = Boolean(settings.qrBar.enabled);
    settings.qrBar.collapsed = Boolean(settings.qrBar.collapsed);

    const notifications = settings.notifications;
    notifications.enabled = Boolean(notifications.enabled);
    notifications.soundEnabled = Boolean(notifications.soundEnabled);
    notifications.flashEnabled = Boolean(notifications.flashEnabled);
    notifications.flashIconEnabled = Boolean(notifications.flashIconEnabled);
    notifications.flashIcon = typeof notifications.flashIcon === 'string' && notifications.flashIcon.startsWith('data:image/')
        ? notifications.flashIcon
        : '';
    notifications.onlyWhenUnfocused = Boolean(notifications.onlyWhenUnfocused);
    notifications.volume = Math.min(1, Math.max(0, Number(notifications.volume) || 0));
    notifications.successSound = typeof notifications.successSound === 'string'
        ? notifications.successSound
        : DEFAULT_SETTINGS.notifications.successSound;
    notifications.errorSound = typeof notifications.errorSound === 'string'
        ? notifications.errorSound
        : DEFAULT_SETTINGS.notifications.errorSound;

    const chatExport = settings.chatExport;
    chatExport.enabled = Boolean(chatExport.enabled);
    chatExport.role = ['all', 'char', 'user'].includes(chatExport.role) ? chatExport.role : DEFAULT_SETTINGS.chatExport.role;
    chatExport.format = ['txt', 'md', 'jsonl'].includes(chatExport.format) ? chatExport.format : DEFAULT_SETTINGS.chatExport.format;
    chatExport.includeSystem = Boolean(chatExport.includeSystem);
    chatExport.removeReasoning = Boolean(chatExport.removeReasoning);
    chatExport.tags = typeof chatExport.tags === 'string' ? chatExport.tags.slice(0, 32768) : '';

    const screenshot = settings.screenshot;
    screenshot.enabled = Boolean(screenshot.enabled);
    screenshot.showMessageButtons = Boolean(screenshot.showMessageButtons);
    screenshot.buttonPlacement = ['inline', 'extra'].includes(screenshot.buttonPlacement)
        ? screenshot.buttonPlacement
        : DEFAULT_SETTINGS.screenshot.buttonPlacement;
    screenshot.showMultiSelectButton = Boolean(screenshot.showMultiSelectButton);
    screenshot.scale = Math.min(3, Math.max(1, Number(screenshot.scale) || DEFAULT_SETTINGS.screenshot.scale));
    screenshot.format = ['png', 'jpeg', 'webp'].includes(screenshot.format)
        ? screenshot.format
        : DEFAULT_SETTINGS.screenshot.format;
    screenshot.quality = Math.min(1, Math.max(0.1, Number(screenshot.quality) || DEFAULT_SETTINGS.screenshot.quality));
    screenshot.backgroundMode = ['current', 'solid', 'transparent'].includes(screenshot.backgroundMode)
        ? screenshot.backgroundMode
        : DEFAULT_SETTINGS.screenshot.backgroundMode;
    screenshot.neighborCount = Math.round(Math.min(4, Math.max(1, Number(screenshot.neighborCount) || DEFAULT_SETTINGS.screenshot.neighborCount)));
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

function replaceObjectInPlace(target, source) {
    for (const key of Object.keys(target)) {
        if (!(key in source)) delete target[key];
    }
    for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
                target[key] = {};
            }
            replaceObjectInPlace(target[key], value);
        } else {
            target[key] = Array.isArray(value) ? cloneDefault(value) : value;
        }
    }
}

export function synchronizeSettings(stableSettings) {
    const latest = ensureSettings();
    if (latest !== stableSettings) {
        replaceObjectInPlace(stableSettings, latest);
        extension_settings[EXTENSION_NAME] = stableSettings;
    }
    return stableSettings;
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

let settingsWindow = null;

export async function mountSettingsPanel(features) {
    const existing = document.getElementById('st-toolbox-settings');
    if (existing && settingsWindow?.dialog.isConnected) {
        settingsWindow.update(features);
        return true;
    }
    const host = await findSettingsHost();
    if (!host) {
        console.warn('[st-toolbox] 未找到 #extensions_settings2，设置入口未挂载。');
        return false;
    }
    // Multiple readiness events may be waiting for the host at the same time.
    if (!settingsWindow?.dialog.isConnected) settingsWindow = createSettingsWindow(features);
    else settingsWindow.update(features);
    let body = document.getElementById('st-toolbox-settings-body');
    if (!body) {
        const panel = createPanel();
        host.appendChild(panel.drawer);
        body = panel.body;
    }
    if (!body.querySelector('#st-toolbox-open-settings')) createSettingsLauncher(body, settingsWindow);
    return true;
}
