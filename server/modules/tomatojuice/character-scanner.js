// Metadata is always re-scanned: caches accelerate parsing, never decide freshness by TTL/watch.
import fs from 'node:fs/promises';
import path from 'node:path';
import { signatureFromRecords, stableStringify } from './utils.js';

export const SCAN_CONCURRENCY = 6;
const IO_LIMIT = 16;
const MAX_USERS = 16;
const MAX_ENTRIES_PER_USER = 4096;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const users = new Map();
let cacheBytes = 0;
let active = 0;
const waiting = [];
const abortQueues = new WeakMap();
function watchQueuedAbort(signal, callback) {
    if (!signal) return () => {};
    let group = abortQueues.get(signal);
    if (!group) {
        group = { callbacks: new Set(), abort: null };
        group.abort = () => { for (const abort of [...group.callbacks]) abort(); };
        abortQueues.set(signal, group);
        signal.addEventListener('abort', group.abort, { once: true });
    }
    group.callbacks.add(callback);
    return () => {
        group.callbacks.delete(callback);
        if (!group.callbacks.size) {
            signal.removeEventListener('abort', group.abort);
            abortQueues.delete(signal);
        }
    };
}
export const scannerMetrics = { scans: 0, readdir: 0, stat: 0, pngReads: 0, cardHits: 0, chatAggregations: 0, chatHits: 0, maxActive: 0 };
export function resetScannerMetrics() { for (const key of Object.keys(scannerMetrics)) scannerMetrics[key] = 0; }

// Global cap in addition to each scan's fan-out; many users cannot multiply file descriptors.
export async function withScanSlot(work, signal) {
    signal?.throwIfAborted();
    if (active >= IO_LIMIT) await new Promise((resolve, reject) => {
        const waiter = { grant: null };
        let unwatch = () => {};
        const abort = () => {
            const index = waiting.indexOf(waiter);
            if (index >= 0) waiting.splice(index, 1);
            unwatch();
            reject(signal.reason);
        };
        waiter.grant = () => { unwatch(); resolve(); };
        waiting.push(waiter);
        unwatch = watchQueuedAbort(signal, abort);
    });
    else active++;
    scannerMetrics.maxActive = Math.max(scannerMetrics.maxActive, active);
    try { signal?.throwIfAborted(); return await work(); }
    finally { const next = waiting.shift(); if (next) next.grant(); else active--; }
}
export async function mapBounded(items, iterator, signal) {
    const output = new Array(items.length);
    let cursor = 0;
    // Wait for all workers on error, avoiding orphaned work after a failed scan.
    const results = await Promise.allSettled(Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, async () => {
        while (cursor < items.length) {
            signal?.throwIfAborted();
            const index = cursor++;
            output[index] = await iterator(items[index], index);
        }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return output;
}
function userKey(ctx) { return stableStringify([ctx.userKey, ctx.directories?.characters, ctx.directories?.chats]); }
function dropUser(key) {
    const store = users.get(key);
    if (store) { for (const entry of store.values()) cacheBytes -= entry.bytes; users.delete(key); }
}
export function clearCharacterCaches(ctx) {
    if (ctx) dropUser(userKey(ctx));
    else { users.clear(); cacheBytes = 0; }
}
function userStore(ctx) {
    const key = userKey(ctx);
    const store = users.get(key) || new Map();
    users.delete(key); users.set(key, store);
    while (users.size > MAX_USERS) dropUser(users.keys().next().value);
    return store;
}
function remove(store, key) { const entry = store.get(key); if (entry) cacheBytes -= entry.bytes; store.delete(key); }
function put(store, key, token, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8') * 2 + key.length * 2 + token.length * 2 + 256;
    remove(store, key);
    if (bytes > MAX_CACHE_BYTES / 4) return;
    store.set(key, { token, value, bytes }); cacheBytes += bytes;
    while (store.size > MAX_ENTRIES_PER_USER) remove(store, store.keys().next().value);
    while (cacheBytes > MAX_CACHE_BYTES && users.size) {
        const oldest = users.values().next().value;
        if (oldest.size) remove(oldest, oldest.keys().next().value);
        else dropUser(users.keys().next().value);
    }
}
function get(store, key, token) {
    const entry = store.get(key);
    if (!entry || entry.token !== token) return null;
    store.delete(key); store.set(key, entry);
    return entry.value;
}
async function readDir(folder, signal, missingAllowed = false) {
    scannerMetrics.readdir++;
    try { return await withScanSlot(() => fs.readdir(folder, { withFileTypes: true }), signal); }
    catch (error) { if (missingAllowed && error.code === 'ENOENT') return []; throw error; }
}
async function statRecord(file, label, signal) {
    scannerMetrics.stat++;
    const stat = await withScanSlot(() => fs.stat(file), signal);
    return { label, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs, ino: stat.ino, directory: stat.isDirectory() };
}
export async function scanCharacters(ctx, _config = {}, { signal } = {}) {
    scannerMetrics.scans++;
    const directories = ctx.directories || {};
    if (!directories.characters || !directories.chats) throw new Error('Character/chat directories unavailable');
    const entries = await readDir(directories.characters, signal);
    const names = entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.png').map(entry => entry.name).sort();
    const cards = await mapBounded(names, async name => {
        const stat = await statRecord(path.join(directories.characters, name), `characters/${name}`, signal);
        return { name, stat, token: signatureFromRecords([stat]) };
    }, signal);
    const store = userStore(ctx);
    // Delete/rename pruning bounds retained state even when no parse/build follows this scan.
    const present = new Set(names.flatMap(name => [`card:${name}`, `chat:${name}`]));
    for (const key of store.keys()) if (!present.has(key)) remove(store, key);
    const chats = new Map();
    const chatRecords = [];
    // Folder and file fan-out are both bounded; the shared limiter caps combined I/O at 16.
    await mapBounded(cards, async ({ name }) => {
        signal?.throwIfAborted();
        const folder = path.join(directories.chats, name.replace(/\.png$/i, ''));
        const entries = await readDir(folder, signal, true);
        // Native calculateChatSize stats ALL direct entries (including non-jsonl and directories).
        // Match that metadata-only behavior; do not read content or recurse into symlink targets.
        const records = await mapBounded(entries, entry => statRecord(path.join(folder, entry.name), `chats/${name}/${entry.name}`, signal), signal);
        for (const record of records) chatRecords.push(record);
        const token = signatureFromRecords(records);
        let totals = get(store, `chat:${name}`, token);
        if (totals) scannerMetrics.chatHits++;
        else {
            scannerMetrics.chatAggregations++;
            totals = records.reduce((total, record) => ({ chatSize: total.chatSize + record.size, dateLastChat: Math.max(total.dateLastChat, record.mtimeMs) }), { chatSize: 0, dateLastChat: 0 });
            if (users.get(userKey(ctx)) === store) put(store, `chat:${name}`, token, totals);
        }
        chats.set(name, totals);
    }, signal);
    signal?.throwIfAborted();
    return { cards, chats, signature: signatureFromRecords([{ label: 'schema', value: 'tomatojuice-characters-v2-all-chat-entries' }, ...cards.map(card => card.stat), ...chatRecords]) };
}
export async function getParsedCard(ctx, card, loader, signal) {
    const store = userStore(ctx);
    const key = `card:${card.name}`;
    const cached = get(store, key, card.token);
    if (cached) { scannerMetrics.cardHits++; return cached; }
    const value = await withScanSlot(async () => { scannerMetrics.pngReads++; return await loader(); }, signal);
    signal?.throwIfAborted();
    // A concurrent clear/eviction must not repopulate a detached store or corrupt accounting.
    if (users.get(userKey(ctx)) === store && value) put(store, key, card.token, value);
    return value;
}
export function characterCacheSize() { return { users: users.size, bytes: cacheBytes, entries: [...users.values()].reduce((n, store) => n + store.size, 0) }; }
