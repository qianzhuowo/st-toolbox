// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR } from './constants.js';
import { config } from './config.js';
import { ENDPOINTS } from './endpoint-registry.js';
import { sha256 } from './utils.js';
import { stats } from './stats.js';

/** @type {Map<string, any>} */
export const memoryCache = new Map();
export const generations = new Map();
/** @type {Map<string, Promise<any>>} */
export const inflight = new Map();
/** @type {Map<string, any>} */
export const refreshProgress = new Map();

const PROGRESS_RETENTION_MS = 30 * 1000;

export function getDiskRoot() {
    // Keep cache inside this server plugin folder so users can clearly see
    // the files belong to tomatojuice and can remove them with the plugin.
    return path.resolve(globalThis.DATA_ROOT || process.cwd(), '_st-toolbox', 'tomatojuice-cache-v1');
}

export function getCacheKey(ctx, endpointKey) {
    return `${ctx.userKey}:${endpointKey}:${sha256(ctx.bodyText + ':schema1:shallow=' + config.shallowCharactersAll).slice(0, 32)}`;
}

export function getDiskCachePath(ctx, endpointKey) {
    const bodyHash = sha256(ctx.bodyText + ':schema1:shallow=' + config.shallowCharactersAll).slice(0, 32);
    return path.join(getDiskRoot(), ctx.userKey, `${endpointKey}-${bodyHash}.json`);
}

function shouldUseDiskCache(endpointKey) {
    const endpoint = ENDPOINTS[endpointKey];
    if (!endpoint?.diskCacheConfigKey) return false;
    return !!config[endpoint.diskCacheConfigKey];
}

export function readDiskEntry(ctx, endpointKey) {
    if (!shouldUseDiskCache(endpointKey)) return null;
    try {
        const file = getDiskCachePath(ctx, endpointKey);
        if (!fs.existsSync(file)) return null;
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!entry || entry.schema !== 1 || entry.endpointKey !== endpointKey || typeof entry.bodyText !== 'string') return null;
        if (endpointKey === 'characters-all' && !Array.isArray(JSON.parse(entry.bodyText))) return null;
        return entry;
    } catch {
        return null;
    }
}

export function writeDiskEntry(ctx, endpointKey, entry) {
    if (!shouldUseDiskCache(endpointKey)) return;
    try {
        const file = getDiskCachePath(ctx, endpointKey);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({ ...entry, schema: 1 }), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporary, file);
    } catch (error) {
        console.warn('[tomatojuice] Persistent cache write failed; using memory only:', error.message);
    }
}

export function listDiskEntriesForUser(ctx) {
    const dir = path.join(getDiskRoot(), ctx.userKey);
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => path.join(dir, name));
    } catch {
        return [];
    }
}

export function getCachedEntry(ctx, endpointKey) {
    const key = getCacheKey(ctx, endpointKey);
    let entry = memoryCache.get(key);
    if (entry) return entry;
    entry = readDiskEntry(ctx, endpointKey);
    if (entry) memoryCache.set(key, entry);
    return entry || null;
}

function finiteNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function normalizeProgress(progress) {
    if (!progress) return null;
    const startedAt = finiteNumber(progress.startedAt, Date.now());
    const updatedAt = finiteNumber(progress.updatedAt, startedAt);
    const bytesReceived = Math.max(0, finiteNumber(progress.bytesReceived, 0) || 0);
    const totalBytesRaw = finiteNumber(progress.totalBytes, null);
    const totalBytes = totalBytesRaw && totalBytesRaw > 0 ? totalBytesRaw : null;
    const speedBps = Math.max(0, finiteNumber(progress.speedBps, 0) || 0);
    const percentRaw = finiteNumber(progress.percent, null);
    const percent = percentRaw === null ? null : Math.max(0, Math.min(100, percentRaw));
    const etaRaw = finiteNumber(progress.etaMs, null);
    return {
        endpointKey: progress.endpointKey || null,
        reason: progress.reason || null,
        phase: progress.phase || 'starting',
        startedAt,
        updatedAt,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        ageMs: Math.max(0, Date.now() - updatedAt),
        bytesReceived,
        totalBytes,
        speedBps,
        percent,
        etaMs: etaRaw === null ? null : Math.max(0, etaRaw),
        status: finiteNumber(progress.status, null),
        error: progress.error || null,
    };
}

export function setRefreshProgress(key, endpointKey, patch = {}) {
    if (!key) return null;
    const now = Date.now();
    const previous = refreshProgress.get(key) || {
        key,
        endpointKey,
        phase: 'starting',
        reason: null,
        startedAt: now,
        updatedAt: now,
        bytesReceived: 0,
        totalBytes: null,
        speedBps: 0,
        percent: null,
        etaMs: null,
        status: null,
        error: null,
    };
    const next = {
        ...previous,
        ...patch,
        key,
        endpointKey: endpointKey || previous.endpointKey,
        updatedAt: now,
    };
    if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
    if (!next.startedAt) next.startedAt = now;
    refreshProgress.set(key, next);
    return normalizeProgress(next);
}

export function getRefreshProgress(key) {
    return normalizeProgress(refreshProgress.get(key));
}

export function scheduleClearRefreshProgress(key, delayMs = PROGRESS_RETENTION_MS) {
    if (!key) return;
    const snapshot = refreshProgress.get(key);
    const updatedAt = snapshot?.updatedAt || Date.now();
    const timer = setTimeout(() => {
        const current = refreshProgress.get(key);
        if (current && (current.updatedAt || 0) <= updatedAt) refreshProgress.delete(key);
    }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
}

export function summarizeEntry(entry) {
    if (!entry) return null;
    return {
        endpointKey: entry.endpointKey,
        status: entry.status,
        bytes: typeof entry.bodyText === 'string' ? Buffer.byteLength(entry.bodyText, 'utf8') : 0,
        transform: entry.transform || null,
        createdAt: entry.createdAt,
        refreshedAt: entry.refreshedAt,
        ageMs: entry.refreshedAt ? Date.now() - entry.refreshedAt : null,
        durationMs: entry.durationMs,
        hitCount: entry.hitCount || 0,
        staleHitCount: entry.staleHitCount || 0,
        lastError: entry.lastError || null,
    };
}

export function getUserStatus(ctx) {
    const baseCtx = { ...ctx, body: {}, bodyText: '{}' };
    return Object.keys(ENDPOINTS).map(endpointKey => {
        const key = getCacheKey(baseCtx, endpointKey);
        return {
            endpointKey,
            entry: summarizeEntry(getCachedEntry(baseCtx, endpointKey)),
            refreshing: inflight.has(key),
            progress: getRefreshProgress(key),
        };
    });
}

export function invalidateForUser(ctx, endpointKeys) {
    let removed = 0;
    for (const endpointKey of endpointKeys) { const k = `${ctx.userKey}:${endpointKey}`; generations.set(k, (generations.get(k) || 0) + 1); }
    for (const endpointKey of endpointKeys) {
        const prefix = `${ctx.userKey}:${endpointKey}:`;
        for (const key of Array.from(memoryCache.keys())) {
            if (key.startsWith(prefix)) {
                memoryCache.delete(key);
                removed++;
            }
        }
        for (const key of Array.from(refreshProgress.keys())) {
            if (key.startsWith(prefix)) {
                refreshProgress.delete(key);
            }
        }
    }
    for (const file of listDiskEntriesForUser(ctx)) {
        const base = path.basename(file);
        if (endpointKeys.some(endpointKey => base.startsWith(`${endpointKey}-`))) {
            try { fs.rmSync(file, { force: true }); removed++; } catch { /* ignore */ }
        }
    }
    stats.invalidations++;
    return removed;
}

export function clearCacheStores() {
    memoryCache.clear();
    inflight.clear();
    refreshProgress.clear();
}
