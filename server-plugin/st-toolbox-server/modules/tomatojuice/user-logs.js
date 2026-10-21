const stores = new Map();
const LIMIT = 1000;
const key = req => req.user.profile.handle;
export function ingestUserLogs(req) {
    const list = stores.get(key(req)) || [];
    for (const raw of (Array.isArray(req.body?.entries) ? req.body.entries : []).slice(0, 100)) {
        list.push({ time: Date.now(), level: String(raw.level || 'log').slice(0, 16), message: String(raw.message || '').slice(0, 4000), source: String(raw.source || '').slice(0, 500) });
    }
    stores.set(key(req), list.slice(-LIMIT)); return { ok: true, total: Math.min(list.length, LIMIT) };
}
export function getUserLogs(req) {
    const entries = stores.get(key(req)) || [];
    return { ok: true, entries, total: entries.length, maxEntries: LIMIT, maxFieldChars: 4000, text: entries.map(e => `${new Date(e.time).toISOString()} [${e.level}] ${e.source} ${e.message}`).join('\n') };
}
export function clearUserLogs(req) { stores.delete(key(req)); return { ok: true }; }
