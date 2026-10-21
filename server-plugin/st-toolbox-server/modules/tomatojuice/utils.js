// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SERVER_ROOT } from './constants.js';

export function sha256(input) {
    return crypto.createHash('sha256').update(String(input)).digest('hex');
}

export function stableStringify(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function getDataRoot() {
    return globalThis.DATA_ROOT || process.cwd();
}

function isSillyTavernRoot(root) {
    try {
        return !!root && fs.existsSync(path.join(root, 'server.js')) && fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(root, 'public', 'index.html'));
    } catch {
        return false;
    }
}

export function safeStatRecord(filePath, label = filePath) {
    try {
        const stat = fs.statSync(filePath);
        return { label, exists: true, file: stat.isFile(), directory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    } catch {
        return { label, exists: false };
    }
}

export function scanDirectoryShallow(dirPath, options = {}) {
    const out = [];
    if (!dirPath) return out;
    const exts = Array.isArray(options.extensions) ? options.extensions.map(x => String(x).toLowerCase()) : null;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (entry.isFile() && exts && !exts.includes(ext)) continue;
            out.push(safeStatRecord(path.join(dirPath, entry.name), `${options.label || dirPath}/${entry.name}`));
        }
    } catch {
        out.push({ label: options.label || dirPath, exists: false });
    }
    return out;
}

export function signatureFromRecords(records) {
    return sha256(stableStringify(records.slice().sort((a,b) => String(a.label).localeCompare(String(b.label)))));
}

export function readTextIfExists(filePath) {
    try {
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
        return '';
    }
}

export function getServerRoot() {
    const cwd = process.cwd();
    // In Termux/proot or symlinked installs, the plugin path and the running
    // process cwd can point at different SillyTavern copies. Prefer the actual
    // process cwd when it looks like an ST root; fall back to the plugin-derived root.
    if (isSillyTavernRoot(cwd)) return cwd;
    if (isSillyTavernRoot(SERVER_ROOT)) return SERVER_ROOT;
    return cwd;
}

export function getPathValue(obj, pathValue, fallback = undefined) {
    try {
        const parts = String(pathValue).split('.');
        let cur = obj;
        for (const part of parts) {
            if (cur === null || cur === undefined) return fallback;
            cur = cur[part];
        }
        return cur === undefined ? fallback : cur;
    } catch {
        return fallback;
    }
}

/** Only stat metadata; never follow symlinks or parse chats to invalidate the character list. */
export function scanChatMetadata(root) {
    const records = [];
    if (!root) return records;
    try {
        for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
            if (!directory.isDirectory()) continue;
            const folder = path.join(root, directory.name);
            records.push(safeStatRecord(folder, `chats/${directory.name}`));
            for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
                if (file.isFile() && file.name.endsWith('.jsonl')) records.push(safeStatRecord(path.join(folder, file.name), `chats/${directory.name}/${file.name}`));
            }
        }
    } catch { records.push({ label: 'chats', unavailable: true }); }
    return records;
}
