import { config } from './config.js';
import { VERSION } from './constants.js';
import { ENDPOINT_LIST, parseEndpointList } from './endpoint-registry.js';
import { handleFast, warmEntry } from './fast-handler.js';
import { makeRequestContext } from './request-context.js';
import { clearCacheStores, getUserStatus, invalidateForUser } from './cache-store.js';
import { makeEarlyBridgeScript, getEarlyBridgeStatus } from './early-bridge.js';
import { makeServiceWorkerScript } from './service-worker.js';
import { handleModuleProxy } from './module-proxy.js';
import { chatSaveEndpoint, groupChatSaveEndpoint, handleChatSaveFast, getChatSaveStatus } from './endpoints/chat-save.js';
import { handleSettingsGetFast, getSettingsGetStatus, clearSettingsGetCache } from './endpoints/settings-get.js';
import { handleSettingsSaveFast, getSettingsSaveStatus } from './endpoints/settings-save.js';
import { handleCharacterGetFast } from './endpoints/characters-get.js';
import { handleCharacterEditFast } from './endpoints/characters-edit.js';
import { handleRecentChatsFast } from './endpoints/recent-chats.js';
import { stats } from './stats.js';
import { getUserLogs, ingestUserLogs, clearUserLogs } from './user-logs.js';
import { validateRequest } from './security.js';
import { withUserWriteLock } from './write-lock.js';
import { createEarlyBridgeManager, registerEarlyManagement } from './early-management.js';
function publicBridgeStatus() {
    const { indexPath, backupDir, ...status } = getEarlyBridgeStatus();
    return status;
}
function aggregateMetrics(value) {
    // Global counters may be useful; never publish another user's last error/path/hash.
    return Object.fromEntries(Object.entries(value || {}).filter(([key, val]) => !/error|user|path|hash|signature/i.test(key) && (typeof val === 'number' || typeof val === 'boolean' || ['endpointKey', 'lastState', 'lastMode', 'lastAt'].includes(key) || val && typeof val === 'object')).map(([key, val]) => [key, val && typeof val === 'object' ? aggregateMetrics(val) : val]));
}
export const tomatojuice = {
    id: 'tomatojuice', version: VERSION,
    capabilities: ['persistent-cache', 'characters-refresh', 'settings-get', 'settings-patch-save', 'chat-patch-save', 'recent-chats', 'early-bridge', 'early-management', 'service-worker', 'module-proxy', 'user-logs'],
    async init(router, prefix) {
        const route = (method, name, handler, publicScript = false) => router[method](prefix + name, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                if (!publicScript) validateRequest(req);
                if (method === 'post' && /\/fast\/.*(?:save|edit)/.test(name)) await withUserWriteLock(req.user.profile.handle, () => handler(req, res));
                else await handler(req, res);
            }
            catch (error) { console.error('[st-toolbox-server:tomatojuice]', error.message); if (!res.headersSent) res.status(error.status || 500).json({ ok: false, error: error.message }); }
        });
        registerEarlyManagement(route, createEarlyBridgeManager());
        const status = req => ({ ok: true, version: VERSION, status: getUserStatus(makeRequestContext(req, { bodyOverride: {} })), stats: aggregateMetrics(stats), earlyBridge: publicBridgeStatus(), settingsSave: aggregateMetrics(getSettingsSaveStatus()), chatSave: aggregateMetrics(getChatSaveStatus()), settingsGet: aggregateMetrics(getSettingsGetStatus()), browserLogs: { total: getUserLogs(req).total }, serviceWorker: { enabled: config.serviceWorkerEnabled } });
        route('post', '/probe', (req, res) => res.json(status(req)));
        route('post', '/status', (req, res) => res.json(status(req)));
        route('post', '/early/status', (_req, res) => res.json({ ok: true, status: publicBridgeStatus() }));
        route('get', '/early/bridge.js', (_req, res) => res.type('application/javascript').send(makeEarlyBridgeScript()), true);
        route('get', '/sw.js', (_req, res) => { res.setHeader('Service-Worker-Allowed', '/'); res.type('application/javascript').send(makeServiceWorkerScript()); }, true);
        route('get', '/module', handleModuleProxy, true);
        for (const def of ENDPOINT_LIST) route(String(def.method || 'POST').toLowerCase(), def.fastPath, (req, res) => handleFast(req, res, def.key));
        route('post', '/fast/settings-get', handleSettingsGetFast);
        route('post', '/fast/settings-save', handleSettingsSaveFast);
        route('post', chatSaveEndpoint.fastPath, (req, res) => handleChatSaveFast(req, res, chatSaveEndpoint));
        route('post', groupChatSaveEndpoint.fastPath, (req, res) => handleChatSaveFast(req, res, groupChatSaveEndpoint));
        route('post', '/fast/characters-get', handleCharacterGetFast);
        route('post', '/fast/characters-edit', handleCharacterEditFast);
        route('post', '/fast/recent-chats', handleRecentChatsFast);
        route('post', '/warm', async (req, res) => {
            const keys = parseEndpointList(req.body?.endpoints);
            const tasks = keys.map(key => warmEntry(makeRequestContext(req, { bodyOverride: {} }), key, 'warm', req.body?.force === true));
            if (req.body?.wait) { const results = await Promise.all(tasks); res.json({ ok: true, results: results.map(r => ({ ok: r.result?.ok, cached: r.cached, skipped: r.skipped })) }); }
            else { void Promise.all(tasks).catch(e => console.warn('[tomatojuice] warm failed:', e.message)); res.json({ ok: true, waited: false }); }
        });
        for (const name of ['/invalidate', '/cache/clear']) route('post', name, (req, res) => {
            const keys = parseEndpointList(req.body?.endpoints);
            const removed = invalidateForUser(makeRequestContext(req, { bodyOverride: {} }), keys);
            clearSettingsGetCache();
            res.json({ ok: true, removed });
        });
        route('post', '/browser-logs/ingest', (req, res) => res.json(ingestUserLogs(req)));
        route('get', '/browser-logs/beacon', (req, res) => {
            const encoded = String(req.query?.d || '');
            const entry = encoded && encoded.length <= 8000 ? JSON.parse(encoded) : { level: req.query?.level, message: req.query?.message };
            ingestUserLogs({ user: req.user, body: { entries: [entry] } }); res.status(204).end();
        });
        route('post', '/browser-logs/list', (req, res) => res.json(getUserLogs(req)));
        route('post', '/browser-logs/clear', (req, res) => res.json(clearUserLogs(req)));
        route('get', '/browser-logs/text', (req, res) => res.type('text/plain').send(getUserLogs(req).text));
    },
    async exit() { clearCacheStores(); clearSettingsGetCache(); },
};
