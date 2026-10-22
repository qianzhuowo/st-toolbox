// @ts-nocheck
import { HEADER_PREFIX, VERSION, info } from './constants.js';
import { config } from './config.js';
import { ENDPOINTS } from './endpoint-registry.js';
import { fetchOriginal } from './original-fetch.js';
import { makeRequestContext } from './request-context.js';
import { nextRequestId, stats } from './stats.js';
import { getRequestBudget, SHARED_BUILD_TIMEOUT_MS } from './budgets.js';
import { cacheEpoch, generations, getCacheKey, getCachedEntry, inflight, memoryCache, scheduleClearRefreshProgress, setRefreshProgress, writeDiskEntry } from './cache-store.js';

export function makeEntryFromBody(ctx, endpointKey, status, statusText, headers, bodyText, signature, durationMs, transform = null) {
    const now = Date.now();
    return { endpointKey, status, statusText, headers, bodyText, createdAt: now, refreshedAt: now, signature, durationMs, transform, hitCount: 0, staleHitCount: 0, lastError: null };
}

function defaultTransformBodyForCache(bodyText) {
    return { bodyText, transformed: false, sourceBytes: Buffer.byteLength(bodyText || '', 'utf8'), cachedBytes: Buffer.byteLength(bodyText || '', 'utf8') };
}

function isStateCurrent(ctx, endpointKey, state) {
    return state.epoch === cacheEpoch
        && state.generation === (generations.get(`${ctx.userKey}:${endpointKey}`) || 0)
        && state.cacheKey === getCacheKey(ctx, endpointKey);
}

function disabledWarmResult(endpoint) {
    if (!config.enabled || !config[endpoint.configKey]) return { result: null, entry: null, cached: false, skipped: true, reason: !config.enabled ? 'disabled' : 'endpoint-disabled' };
    return null;
}

function sendDisabled(res) {
    setCacheHeaders(res, 'BYPASS');
    res.setHeader('x-tomatojuice-bypass', '1');
    return res.status(503).json({ ok: false, skipped: true, reason: 'disabled', plugin: info });
}

export async function refreshEntry(ctx, endpointKey, reason = 'refresh', initialState = null) {
    const endpoint = ENDPOINTS[endpointKey];
    const key = getCacheKey(ctx, endpointKey);
    const startedAt = Date.now();
    const generationKey = `${ctx.userKey}:${endpointKey}`;
    const generation = initialState?.generation ?? (generations.get(generationKey) || 0);
    const epoch = initialState?.epoch ?? cacheEpoch;
    const assertCurrent = () => {
        if (cacheEpoch !== epoch || (generations.get(generationKey) || 0) !== generation || getCacheKey(ctx, endpointKey) !== key || !config.enabled || !config[endpoint.configKey]) throw new Error('Cache build invalidated; use native endpoint');
    };
    if (initialState && !isStateCurrent(ctx, endpointKey, initialState)) throw new Error('Cache build invalidated; use native endpoint');
    const updateProgress = (patch = {}) => setRefreshProgress(key, endpointKey, patch);
    if (inflight.has(key)) {
        const refreshed = await inflight.get(key);
        assertCurrent();
        return refreshed;
    }

    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(new Error('Shared cache build deadline exceeded')); reject(controller.signal.reason); }, Math.max(1, SHARED_BUILD_TIMEOUT_MS - (Date.now() - (initialState?.scanStartedAt ?? startedAt))));
    });
    const work = (async () => {
        stats.refreshes++;
        updateProgress({ phase: 'starting', reason, startedAt, bytesReceived: 0, totalBytes: null, speedBps: 0, percent: null, etaMs: null, status: null, error: null });
        const snapshot = initialState?.snapshot ?? (endpoint.scan ? await endpoint.scan(ctx, config, { signal: controller.signal }) : null);
        const signature = initialState?.signature ?? snapshot?.signature ?? await endpoint.getSignature(ctx);
        let result = null;
        if (typeof endpoint.fetchForCache === 'function') {
            result = await endpoint.fetchForCache(ctx, config, { onProgress: updateProgress, startedAt, reason, signal: controller.signal, snapshot });
        }
        controller.signal.throwIfAborted();
        if (!result) result = await fetchOriginal(ctx, endpoint, { onProgress: updateProgress, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (result.ok && result.status >= 200 && result.status < 300) {
            const now = Date.now();
            updateProgress({ phase: 'transforming', status: result.status, bytesReceived: result.bytesReceived ?? Buffer.byteLength(result.bodyText || '', 'utf8'), totalBytes: result.totalBytes ?? null, etaMs: 0 });
            const transformed = result.transform
                ? { bodyText: result.bodyText, ...result.transform }
                : endpoint.transformBodyForCache
                ? endpoint.transformBodyForCache(ctx, result.bodyText, config)
                : defaultTransformBodyForCache(result.bodyText);
            const entry = {
                endpointKey,
                status: result.status,
                statusText: result.statusText,
                headers: result.headers,
                bodyText: transformed.bodyText,
                createdAt: now,
                refreshedAt: now,
                signature,
                durationMs: result.durationMs,
                transform: {
                    transformed: transformed.transformed,
                    sourceBytes: transformed.sourceBytes,
                    cachedBytes: transformed.cachedBytes,
                    count: transformed.count,
                    error: transformed.error,
                    direct: transformed.direct,
                    errors: transformed.errors,
                },
                hitCount: 0,
                staleHitCount: 0,
                lastError: null,
            };
            const finalSignature = await endpoint.getSignature(ctx, config, { signal: controller.signal });
            controller.signal.throwIfAborted();
            assertCurrent();
            if (finalSignature !== signature) {
                throw new Error('Cache build invalidated; use native endpoint');
            }
            memoryCache.set(key, entry);
            writeDiskEntry(ctx, endpointKey, entry);
            updateProgress({ phase: 'cached', status: result.status, bytesReceived: result.bytesReceived ?? Buffer.byteLength(result.bodyText || '', 'utf8'), totalBytes: result.totalBytes ?? null, percent: result.totalBytes ? 100 : null, etaMs: 0, error: null });
            scheduleClearRefreshProgress(key);
            return { result, entry, cached: true };
        }
        updateProgress({ phase: 'error', status: result.status, bytesReceived: result.bytesReceived ?? Buffer.byteLength(result.bodyText || '', 'utf8'), totalBytes: result.totalBytes ?? null, error: `HTTP ${result.status || 0}` });
        scheduleClearRefreshProgress(key);
        return { result, entry: null, cached: false };
    })();
    const promise = Promise.race([work, deadline])
        .catch((error) => {
            stats.errors++;
            stats.lastError = error instanceof Error ? error.message : String(error);
            updateProgress({ phase: 'error', error: stats.lastError, status: null });
            scheduleClearRefreshProgress(key);
            throw error;
        })
        .finally(() => clearTimeout(timer));
    // Do not launch replacement work while an uncancellable OS filesystem call is pending.
    // The shared rejected promise provides immediate bounded errors until the worker settles.
    void work.finally(() => { if (inflight.get(key) === promise) inflight.delete(key); }).catch(() => {});

    inflight.set(key, promise);
    const refreshed = await promise;
    assertCurrent();
    return refreshed;
}

export async function getFreshCacheState(ctx, endpointKey, { signal } = {}) {
    const endpoint = ENDPOINTS[endpointKey];
    const signatureStartedAt = Date.now();
    const generation = generations.get(`${ctx.userKey}:${endpointKey}`) || 0;
    const epoch = cacheEpoch;
    const cacheKey = getCacheKey(ctx, endpointKey);
    const snapshot = endpoint.scan ? await endpoint.scan(ctx, config, { signal }) : null;
    const signature = snapshot?.signature ?? await endpoint.getSignature(ctx, config, { signal });
    signal?.throwIfAborted();
    const signatureMs = Date.now() - signatureStartedAt;
    const entry = getCachedEntry(ctx, endpointKey);
    if (!entry) return { entry: null, fresh: false, signature, signatureMs, snapshot, generation, epoch, cacheKey, scanStartedAt: signatureStartedAt, reason: 'missing' };

    const ageMs = Date.now() - Number(entry.refreshedAt || entry.createdAt || 0);
    const signatureMatches = entry.signature === signature;
    const withinMaxStale = config.maxStaleMs <= 0 || ageMs <= config.maxStaleMs;
    return { entry, snapshot, generation, epoch, cacheKey, scanStartedAt: signatureStartedAt, fresh: signatureMatches && withinMaxStale && isStateCurrent(ctx, endpointKey, { epoch, generation, cacheKey }), signature, signatureMs, ageMs, signatureMatches, withinMaxStale, reason: signatureMatches ? (withinMaxStale ? 'fresh' : 'expired') : 'signature-changed' };
}

async function readStateWithinBudget(ctx, endpointKey, budgetMs) {
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            getFreshCacheState(ctx, endpointKey, { signal: controller.signal }),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error('Cache signature scan deadline exceeded; use native endpoint');
                    controller.abort(error); reject(error);
                }, budgetMs);
            }),
        ]);
    } finally { clearTimeout(timer); }
}

export async function warmEntry(ctx, endpointKey, reason = 'warm', force = false) {
    const endpoint = ENDPOINTS[endpointKey];
    if (!endpoint) throw new Error('Unknown cache endpoint');
    const disabled = disabledWarmResult(endpoint);
    if (disabled) return disabled;
    if (!force) {
        const state = await readStateWithinBudget(ctx, endpointKey, SHARED_BUILD_TIMEOUT_MS);
        const disabled = disabledWarmResult(endpoint);
        if (disabled) return disabled;
        if (!isStateCurrent(ctx, endpointKey, state)) throw new Error('Cache scan invalidated; retry warm');
        if (state.fresh && state.entry) {
            return { result: { ok: true, status: state.entry.status, statusText: state.entry.statusText, durationMs: 0 }, entry: state.entry, cached: true, skipped: true };
        }
        return await refreshEntry(ctx, endpointKey, reason, state);
    }
    return await refreshEntry(ctx, endpointKey, reason);
}

export function setCacheHeaders(res, state, entry = null) {
    res.setHeader(HEADER_PREFIX, VERSION);
    res.setHeader(`${HEADER_PREFIX}-state`, state);
    res.setHeader('x-cocktail-cache', state);
    if (entry?.refreshedAt) res.setHeader(`${HEADER_PREFIX}-age-ms`, String(Math.max(0, Date.now() - entry.refreshedAt)));
}

function setExtraHeaders(res, extraHeaders = null) {
    if (!extraHeaders) return;
    for (const [key, value] of Object.entries(extraHeaders)) {
        if (value !== undefined && value !== null) res.setHeader(key, String(value));
    }
}

export function sendEntry(res, entry, state, extraHeaders = null) {
    setCacheHeaders(res, state, entry);
    setExtraHeaders(res, extraHeaders);
    res.status(entry.status || 200);
    res.setHeader('content-type', entry.headers?.['content-type'] || 'application/json; charset=utf-8');
    res.send(entry.bodyText);
}

export function sendFetchResult(res, result, state, entry = null, extraHeaders = null) {
    setCacheHeaders(res, state, entry);
    setExtraHeaders(res, extraHeaders);
    res.status(result.status || 200);
    res.setHeader('content-type', result.headers?.['content-type'] || 'application/json; charset=utf-8');
    res.send(result.bodyText ?? '');
}

function logFastDecision(endpointKey, decision, detail = {}) {
    if (endpointKey !== 'characters-all') return;
    try {
        console.info('[tomatojuice:fast-diag]', decision, {
            endpointKey,
            at: new Date().toISOString(),
            ...detail,
        });
    } catch {
        // diagnostics must never affect the request path
    }
}

export async function handleFast(req, res, endpointKey) {
    const startedAt = Date.now();
    stats.requests++;
    const endpoint = ENDPOINTS[endpointKey];
    const ctx = makeRequestContext(req, { bodyOverride: {} }); // Both cached read endpoints ignore request bodies; bound cache cardinality.
    ctx.requestId = nextRequestId(endpointKey);

    logFastDecision(endpointKey, 'request-enter', {
        requestId: ctx.requestId,
        method: req.method,
        cacheEnabled: !!config.enabled && !!config[endpoint.configKey],
        asyncCharactersAllOnMiss: !!config.asyncCharactersAllOnMiss,
        allowEmptyCharactersAllOnMiss: !!config.allowEmptyCharactersAllOnMiss,
        blockCharactersAllOnMiss: !!config.blockCharactersAllOnMiss,
    });

    if (!config.enabled || !config[endpoint.configKey]) {
        return sendDisabled(res);
    }

    let initialState;
    try { initialState = await readStateWithinBudget(ctx, endpointKey, getRequestBudget(config, endpointKey).fastWaitMs); }
    catch (error) { return res.status(502).json({ ok: false, error: error.message, plugin: info }); }
    if (!config.enabled || !config[endpoint.configKey]) return sendDisabled(res);
    if (!isStateCurrent(ctx, endpointKey, initialState)) return res.status(502).json({ ok: false, error: 'Cache scan invalidated; use native endpoint', plugin: info });
    const { signature, entry } = initialState;
    const now = Date.now();
    const cacheKey = getCacheKey(ctx, endpointKey);

    if (entry) {
        const ageMs = now - Number(entry.refreshedAt || entry.createdAt || 0);
        const signatureMatches = entry.signature === signature;
        const withinMaxStale = config.maxStaleMs <= 0 || ageMs <= config.maxStaleMs;
        if (initialState.fresh) {
            stats.hits++;
            entry.hitCount = Number(entry.hitCount || 0) + 1;
            memoryCache.set(cacheKey, entry);
            logFastDecision(endpointKey, 'hit-return', { requestId: ctx.requestId, status: entry.status, ageMs, signatureMatches, durationMs: Date.now() - startedAt, bodyBytes: Buffer.byteLength(entry.bodyText || '', 'utf8') });
            return sendEntry(res, entry, 'HIT');
        }
        if (config.staleWhileRevalidate && (signatureMatches || endpoint.staleOnSignatureChange)) {
            stats.staleHits++;
            entry.staleHitCount = Number(entry.staleHitCount || 0) + 1;
            memoryCache.set(cacheKey, entry);
            const state = signatureMatches ? 'STALE' : 'STALE-SIGNATURE';
            const reason = signatureMatches ? 'max-stale-expired' : 'signature-changed';
            void refreshEntry(ctx, endpointKey, reason, initialState).catch(() => {});
            logFastDecision(endpointKey, 'stale-return', { requestId: ctx.requestId, state, reason, ageMs, signatureMatches, durationMs: Date.now() - startedAt, bodyBytes: Buffer.byteLength(entry.bodyText || '', 'utf8') });
            return sendEntry(res, entry, state);
        }
    }

    const fastMiss = endpoint.makeFastMiss?.(ctx, signature, config);
    if (fastMiss) {
        stats.misses++;
        const fastEntry = makeEntryFromBody(
            ctx,
            endpointKey,
            fastMiss.status,
            fastMiss.statusText,
            fastMiss.headers,
            fastMiss.bodyText,
            signature,
            fastMiss.durationMs || 0,
            fastMiss.transform || null,
        );
        memoryCache.set(cacheKey, fastEntry);
        writeDiskEntry(ctx, endpointKey, fastEntry);
        if (fastMiss.refreshReason) void refreshEntry(ctx, endpointKey, fastMiss.refreshReason).catch(() => {});
        logFastDecision(endpointKey, 'fast-miss-return', { requestId: ctx.requestId, state: fastMiss.state, refreshReason: fastMiss.refreshReason, durationMs: Date.now() - startedAt, bodyBytes: Buffer.byteLength(fastMiss.bodyText || '', 'utf8') });
        return sendEntry(res, fastEntry, fastMiss.state, fastMiss.extraResponseHeaders);
    }

    const asyncMiss = !entry ? endpoint.makeAsyncMiss?.(ctx, signature, config) : null;
    if (asyncMiss) {
        stats.misses++;
        if (asyncMiss.refreshReason) void refreshEntry(ctx, endpointKey, asyncMiss.refreshReason).catch(() => {});
        logFastDecision(endpointKey, 'async-miss-return', { requestId: ctx.requestId, state: asyncMiss.state, refreshReason: asyncMiss.refreshReason, durationMs: Date.now() - startedAt, bodyBytes: Buffer.byteLength(asyncMiss.bodyText || '', 'utf8') });
        return sendFetchResult(res, asyncMiss, asyncMiss.state, null, asyncMiss.extraResponseHeaders);
    }

    stats.misses++;
    try {
        logFastDecision(endpointKey, 'blocking-refresh-start', { requestId: ctx.requestId, hasEntry: !!entry, durationMs: Date.now() - startedAt });
        // Bound the optional fast route, not the native request. Cache building may finish in
        // background; a timeout returns an error so clients fall back without a synthetic [].
        let deadline;
        let refreshed;
        try {
            refreshed = await Promise.race([
                refreshEntry(ctx, endpointKey, entry ? 'blocking-refresh' : 'miss', initialState),
                new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Fast cache build deadline exceeded; use native endpoint')), Math.max(1, getRequestBudget(config, endpointKey).fastWaitMs - (Date.now() - startedAt))); }),
            ]);
        } finally { clearTimeout(deadline); }
        // Promise consumers may invalidate/disable after the shared worker resolves but
        // before this HTTP continuation runs. Recheck at the actual delivery boundary.
        if (!config.enabled || !config[endpoint.configKey]) return sendDisabled(res);
        if (!isStateCurrent(ctx, endpointKey, initialState)) throw new Error('Cache result invalidated before delivery; use native endpoint');
        const { result, entry: refreshedEntry } = refreshed;
        if (refreshedEntry) {
            logFastDecision(endpointKey, 'blocking-refresh-entry-return', { requestId: ctx.requestId, status: refreshedEntry.status, durationMs: Date.now() - startedAt, bodyBytes: Buffer.byteLength(refreshedEntry.bodyText || '', 'utf8') });
            return sendEntry(res, refreshedEntry, entry ? 'REFRESH' : 'MISS');
        }
        logFastDecision(endpointKey, 'blocking-refresh-result-return', { requestId: ctx.requestId, status: result?.status, durationMs: Date.now() - startedAt, bodyBytes: Buffer.byteLength(result?.bodyText || '', 'utf8') });
        return sendFetchResult(res, result, entry ? 'REFRESH' : 'MISS');
    } catch (error) {
        res.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error), plugin: info });
    }
}
