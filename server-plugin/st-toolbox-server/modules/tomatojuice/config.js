// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, PLUGIN_ID } from './constants.js';

export const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    serviceWorkerEnabled: false,
    cacheCharactersAll: true,
    cacheVersion: true,
    staleWhileRevalidate: true,
    maxStaleMs: 0,
    // Store/return SillyTavern-compatible shallow character objects for /api/characters/all.
    shallowCharactersAll: true,
    // Persist shallow characters cache to survive backend restarts.
    diskCacheCharactersAll: true,
    // /version is tiny and non-sensitive; persist it to survive backend restarts.
    diskCacheVersion: true,
    fastVersionOnMiss: false,
    // No synthetic empty list: it can clear active_character / auto-loaded chats.
    asyncCharactersAllOnMiss: false,
    allowEmptyCharactersAllOnMiss: false,
    // Optional longer fast budget (10s); the generated browser bridge allows 11s for transport/JSON.
    blockCharactersAllOnMiss: false,
    // Optional async HTML bridge. It may arrive after the native startup requests.
    earlyBridgeEnabled: true,
    autoInstallEarlyBridge: false,
    earlyBridgePatchFetch: true,
    // Legacy fast save APIs only. Current bridge/SW NEVER intercept settings/chat saves.
    optimizeSettingsSave: true,
    settingsSaveNoopEnabled: true,
    settingsSavePatchEnabled: true,
    settingsSaveMaxPatchOperations: 2000,
    // If the patch request is too close to the full payload size, the browser falls back to the original full save.
    settingsSaveMaxPatchBytesRatio: 0.85,
    // Retained chat-patch API configuration for explicit compatibility callers.
    optimizeChatSave: true,
    chatSaveNoopEnabled: true,
    chatSavePatchEnabled: true,
    chatSaveMaxPatchOperations: 5000,
    chatSaveMaxPatchBytesRatio: 0.85,
    chatSaveCacheMaxEntries: 64,
    // Retained settings-get fast API; not automatically routed by the current bridge.
    optimizeSettingsGet: true,
    cacheSettingsGet: true,
    // Legacy compatibility values. The current read bridge does not preload templates or version.
    templatePreloadEnabled: true,
    // Legacy startup-prefetch switch (inactive in the read-only bridge).
    startupPreloadEnabled: true,
    // Compatibility SW has no fetch listener; these legacy flags do not enable interception.
    serviceWorkerFastRouteFallback: false,
    serviceWorkerSettingsGetFallback: false,
    serviceWorkerSettingsSaveFallback: false,
    serviceWorkerChatSaveFallback: false,
    serviceWorkerTemplateFallback: false,
    // Retired proxy configuration, retained for migration only; normalize always disables it.
    moduleProxyEnabled: false,
    patchStartupInit: true,
    patchI18nInit: true,
    patchSystemMessagesInit: true,
    patchExtensionManifests: true,
    patchParallelActivateExtensions: true,
    // Fast-start mode: extension scripts/styles activate after APP_READY. Event replay keeps common extension hooks compatible.
    deferExtensionActivationUntilAppReady: false,
    // Legacy logging switch; the read-only bridge installs no console/error collector.
    browserLogCaptureEnabled: false,
    // Retired automatic core patch; normalize always disables it.
    autoPatchChatsEnoentGuard: false,
    // Internal self-fetches target loopback (127.0.0.1/localhost). When ST uses a self-signed HTTPS
    // certificate, skip TLS verification only for these loopback requests so fast paths keep working.
    internalFetchSkipTlsVerify: false,
});

function asBool(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(s)) return true;
        if (['0', 'false', 'no', 'off'].includes(s)) return false;
    }
    return fallback;
}

function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.trunc(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
}

export function normalizeConfig(input = {}) {
    const out = { ...DEFAULT_CONFIG };
    out.enabled = asBool(input.enabled, DEFAULT_CONFIG.enabled);
    out.serviceWorkerEnabled = asBool(input.serviceWorkerEnabled, DEFAULT_CONFIG.serviceWorkerEnabled);
    out.cacheCharactersAll = asBool(input.cacheCharactersAll, DEFAULT_CONFIG.cacheCharactersAll);
    out.cacheVersion = asBool(input.cacheVersion, DEFAULT_CONFIG.cacheVersion);
    out.staleWhileRevalidate = asBool(input.staleWhileRevalidate, DEFAULT_CONFIG.staleWhileRevalidate);
    out.maxStaleMs = clampInt(input.maxStaleMs, 0, 24 * 60 * 60 * 1000, DEFAULT_CONFIG.maxStaleMs);
    out.shallowCharactersAll = asBool(input.shallowCharactersAll, DEFAULT_CONFIG.shallowCharactersAll);
    out.diskCacheCharactersAll = asBool(input.diskCacheCharactersAll, DEFAULT_CONFIG.diskCacheCharactersAll);
    out.diskCacheVersion = asBool(input.diskCacheVersion, DEFAULT_CONFIG.diskCacheVersion);
    out.fastVersionOnMiss = asBool(input.fastVersionOnMiss, DEFAULT_CONFIG.fastVersionOnMiss);
    out.blockCharactersAllOnMiss = asBool(input.blockCharactersAllOnMiss, DEFAULT_CONFIG.blockCharactersAllOnMiss);
    // Empty synthetic lists can clear active_character and auto-loaded chat. Never emit them.
    out.asyncCharactersAllOnMiss = false;
    out.allowEmptyCharactersAllOnMiss = false;
    out.earlyBridgeEnabled = asBool(input.earlyBridgeEnabled, DEFAULT_CONFIG.earlyBridgeEnabled);
    out.autoInstallEarlyBridge = false;
    out.earlyBridgePatchFetch = asBool(input.earlyBridgePatchFetch, DEFAULT_CONFIG.earlyBridgePatchFetch);
    out.optimizeSettingsSave = asBool(input.optimizeSettingsSave, DEFAULT_CONFIG.optimizeSettingsSave);
    out.settingsSaveNoopEnabled = asBool(input.settingsSaveNoopEnabled, DEFAULT_CONFIG.settingsSaveNoopEnabled);
    out.settingsSavePatchEnabled = asBool(input.settingsSavePatchEnabled, DEFAULT_CONFIG.settingsSavePatchEnabled);
    out.settingsSaveMaxPatchOperations = clampInt(input.settingsSaveMaxPatchOperations, 1, 100000, DEFAULT_CONFIG.settingsSaveMaxPatchOperations);
    out.settingsSaveMaxPatchBytesRatio = Math.max(0.05, Math.min(2, Number(input.settingsSaveMaxPatchBytesRatio) || DEFAULT_CONFIG.settingsSaveMaxPatchBytesRatio));
    out.optimizeChatSave = asBool(input.optimizeChatSave, DEFAULT_CONFIG.optimizeChatSave);
    out.chatSaveNoopEnabled = asBool(input.chatSaveNoopEnabled, DEFAULT_CONFIG.chatSaveNoopEnabled);
    out.chatSavePatchEnabled = asBool(input.chatSavePatchEnabled, DEFAULT_CONFIG.chatSavePatchEnabled);
    out.chatSaveMaxPatchOperations = clampInt(input.chatSaveMaxPatchOperations, 1, 100000, DEFAULT_CONFIG.chatSaveMaxPatchOperations);
    out.chatSaveMaxPatchBytesRatio = Math.max(0.05, Math.min(2, Number(input.chatSaveMaxPatchBytesRatio) || DEFAULT_CONFIG.chatSaveMaxPatchBytesRatio));
    out.chatSaveCacheMaxEntries = clampInt(input.chatSaveCacheMaxEntries, 0, 1024, DEFAULT_CONFIG.chatSaveCacheMaxEntries);
    out.optimizeSettingsGet = asBool(input.optimizeSettingsGet, DEFAULT_CONFIG.optimizeSettingsGet);
    out.cacheSettingsGet = asBool(input.cacheSettingsGet, DEFAULT_CONFIG.cacheSettingsGet);
    out.templatePreloadEnabled = asBool(input.templatePreloadEnabled, DEFAULT_CONFIG.templatePreloadEnabled);
    out.startupPreloadEnabled = asBool(input.startupPreloadEnabled, DEFAULT_CONFIG.startupPreloadEnabled);
    // Compatibility worker is pass-through; never force a persistent interception layer.
    out.serviceWorkerFastRouteFallback = false;
    out.serviceWorkerSettingsGetFallback = asBool(input.serviceWorkerSettingsGetFallback, DEFAULT_CONFIG.serviceWorkerSettingsGetFallback);
    out.serviceWorkerSettingsSaveFallback = asBool(input.serviceWorkerSettingsSaveFallback, DEFAULT_CONFIG.serviceWorkerSettingsSaveFallback);
    out.serviceWorkerChatSaveFallback = asBool(input.serviceWorkerChatSaveFallback, DEFAULT_CONFIG.serviceWorkerChatSaveFallback);
    out.serviceWorkerTemplateFallback = asBool(input.serviceWorkerTemplateFallback, DEFAULT_CONFIG.serviceWorkerTemplateFallback);
    out.moduleProxyEnabled = false; // Retired: persistent core URLs must remain native.
    out.patchStartupInit = asBool(input.patchStartupInit, DEFAULT_CONFIG.patchStartupInit);
    out.patchI18nInit = asBool(input.patchI18nInit, DEFAULT_CONFIG.patchI18nInit);
    out.patchSystemMessagesInit = asBool(input.patchSystemMessagesInit, DEFAULT_CONFIG.patchSystemMessagesInit);
    out.patchExtensionManifests = asBool(input.patchExtensionManifests, DEFAULT_CONFIG.patchExtensionManifests);
    out.patchParallelActivateExtensions = asBool(input.patchParallelActivateExtensions, DEFAULT_CONFIG.patchParallelActivateExtensions);
    out.deferExtensionActivationUntilAppReady = asBool(input.deferExtensionActivationUntilAppReady, DEFAULT_CONFIG.deferExtensionActivationUntilAppReady);
    out.browserLogCaptureEnabled = asBool(input.browserLogCaptureEnabled, DEFAULT_CONFIG.browserLogCaptureEnabled);
    out.autoPatchChatsEnoentGuard = false;
    out.internalFetchSkipTlsVerify = asBool(input.internalFetchSkipTlsVerify, DEFAULT_CONFIG.internalFetchSkipTlsVerify);
    return out;
}

export function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return normalizeConfig({});
        return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (error) {
        console.warn(`[${PLUGIN_ID}] Failed to read config.json, using defaults:`, error);
        return normalizeConfig({});
    }
}

export function saveConfig(nextConfig) {
    const normalized = normalizeConfig(nextConfig);
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 4), 'utf8');
    config = normalized;
    return config;
}

export function asBoolean(value, fallback = false) {
    return asBool(value, fallback);
}

export let config = loadConfig();
