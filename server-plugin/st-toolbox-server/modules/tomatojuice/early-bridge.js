import { scriptAttribute, replaceScriptAttribute } from './html-script.js';
// @ts-nocheck
import fs from 'node:fs';
import { makeSafeBridgeScript } from './safe-bridge.js';
import { cleanLegacyHtml } from './legacy-migration.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { API_PREFIX, HEADER_PREFIX, PLUGIN_DIR, VERSION } from './constants.js';
import { config } from './config.js';
import { getServerRoot } from './utils.js';

const MARKER_START = '<!-- tomatojuice early bridge start -->';
const MARKER_END = '<!-- tomatojuice early bridge end -->';
const BRIDGE_SCRIPT_ID = 'tomatojuice-early-bridge';
const BRIDGE_SRC = `${API_PREFIX}/early/bridge.js`;
function getBackupDir(root = getServerRoot()) { return path.join(root, 'data', '_st-toolbox', 'html-backups'); }
const MODULE_IMPORT_MAP_ID = 'tomatojuice-module-import-map';
// Legacy proxy targets remain recognizable for one-time restoration.
const MODULE_PROXY_IMPORT_PATHS = ['/scripts/dynamic-styles.js', '/script.js', '/scripts/i18n.js', '/scripts/system-messages.js', '/scripts/extensions.js', '/scripts/welcome-screen.js'];
const MODULE_SCRIPT_PROXY_EXCLUDED_PREFIXES = ['/scripts/extensions/third-party/'];

function getIndexPath(root = getServerRoot()) {
    return path.join(root, 'public', 'index.html');
}

function getBridgeBlock() {
    const lines = [MARKER_START];
    if (config.moduleProxyEnabled) {
        lines.push(`<script type="importmap" id="${MODULE_IMPORT_MAP_ID}" data-cp-module-proxy-importmap="1">${escapeScriptJson(getModuleProxyImportMap())}</script>`);
    }
    lines.push(`<script id="${BRIDGE_SCRIPT_ID}" async src="${BRIDGE_SRC}" data-tomatojuice-early="1"></script>`);
    lines.push(MARKER_END);
    return lines.join('\n');
}

function getModuleProxySrc(publicPath) {
    return `${API_PREFIX}/module?path=${encodeURIComponent(publicPath)}`;
}


function readIndexHtml(root = getServerRoot()) {
    const indexPath = getIndexPath(root);
    if (!fs.existsSync(indexPath)) return '';
    return fs.readFileSync(indexPath, 'utf8');
}

function countOccurrences(text, needle) {
    if (!needle) return 0;
    return String(text || '').split(needle).length - 1;
}

function getMarkerRegex() {
    return new RegExp(`${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`, 'g');
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeHtmlAtomic(indexPath, html) {
    const temporary = indexPath + `.st-toolbox-${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, html, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(indexPath).mode });
        fs.renameSync(temporary, indexPath);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function makeBackup(html, root = getServerRoot()) {
    fs.mkdirSync(getBackupDir(root), { recursive: true });
    const file = path.join(getBackupDir(root), `index.html.${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak`);
    fs.writeFileSync(file, html, { encoding: 'utf8', flag: 'wx' });
    return file;
}

function rewriteIndexModuleProxyTags(html) {
    return restoreIndexModuleProxyTags(html);
}

function restoreIndexModuleProxyTags(html) {
    const out = String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, tag => {
        const src = scriptAttribute(tag, 'src');
        if (!src?.startsWith(API_PREFIX + '/module')) return tag;
        const original = scriptAttribute(tag, 'data-cp-module-proxy-original');
        const canonical = original?.startsWith('/') ? original : '/' + original;
        if (!MODULE_PROXY_IMPORT_PATHS.includes(canonical) || src !== getModuleProxySrc(canonical)) throw Object.assign(new Error('无法核对旧 toolbox 核心模块 URL；拒绝修改 HTML。'), { status: 409 });
        return replaceScriptAttribute(replaceScriptAttribute(tag, 'src', original), 'data-cp-module-proxy-original', null);
    });
    if (out.includes(API_PREFIX + '/module')) throw Object.assign(new Error('仍有无法识别的 toolbox 模块依赖；拒绝修改 HTML。'), { status: 409 });
    return out;
}

function insertBridgeBlock(html) {
    const block = getBridgeBlock();
    const markerRegex = getMarkerRegex();

    if (markerRegex.test(html)) {
        markerRegex.lastIndex = 0;
        return { html: html.replace(markerRegex, block), mode: 'replace-marker' };
    }

    const headOpen = html.match(/<head\b[^>]*>/i);
    if (headOpen && typeof headOpen.index === 'number') {
        const pos = headOpen.index + headOpen[0].length;
        return { html: `${html.slice(0, pos)}\n${block}\n${html.slice(pos)}`, mode: 'after-head-open' };
    }

    const scriptJs = html.match(/<script\b[^>]*\bsrc=["']script\.js["'][^>]*><\/script>/i);
    if (scriptJs && typeof scriptJs.index === 'number') {
        return { html: `${html.slice(0, scriptJs.index)}${block}\n${html.slice(scriptJs.index)}`, mode: 'before-script-js' };
    }

    return { html: `${block}\n${html}`, mode: 'file-start' };
}

function assertKnownBridgeBlock(html) {
    const reject = () => Object.assign(new Error('首屏入口结构无法识别；请核对 HTML 与备份，拒绝自动修改。'), { status: 409 });
    const starts = countOccurrences(html, MARKER_START), ends = countOccurrences(html, MARKER_END);
    const ids = countOccurrences(html, `id="${BRIDGE_SCRIPT_ID}"`) + countOccurrences(html, `id='${BRIDGE_SCRIPT_ID}'`);
    if (starts !== ends || starts > 1 || ids > 1 || ids && !starts || starts && html.indexOf(MARKER_START) > html.indexOf(MARKER_END)) {
        throw Object.assign(new Error('首屏入口标记不完整、重复或异常；拒绝修改 HTML。'), { status: 409 });
    }
    const block = html.match(getMarkerRegex())?.[0];
    if (!block) return;
    const content = block.slice(MARKER_START.length, -MARKER_END.length);
    const rest = content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, tag => {
        const src = scriptAttribute(tag, 'src');
        const body = tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</'));
        if (src === BRIDGE_SRC && !body.trim()) return '';
        if (scriptAttribute(tag, 'id') === 'tomatojuice-module-import-map' && scriptAttribute(tag, 'type') === 'importmap') {
            let map;
            try { map = JSON.parse(body); } catch { throw reject(); }
            if (!map?.imports || Object.keys(map).some(key => key !== 'imports')) throw reject();
            for (const [source, target] of Object.entries(map.imports)) {
                if (!MODULE_PROXY_IMPORT_PATHS.includes(source) || target !== getModuleProxySrc(source)) throw reject();
            }
            return '';
        }
        throw reject();
    });
    if (rest.trim()) throw reject();
}

export function getEarlyBridgeStatus(root = getServerRoot()) {
    const indexPath = getIndexPath(root);
    const html = readIndexHtml(root);
    assertKnownBridgeBlock(html);
    const markerStartCount = countOccurrences(html, MARKER_START);
    const markerEndCount = countOccurrences(html, MARKER_END);
    const scriptIdCount = countOccurrences(html, `id="${BRIDGE_SCRIPT_ID}"`) + countOccurrences(html, `id='${BRIDGE_SCRIPT_ID}'`);
    const installed = markerStartCount > 0 || markerEndCount > 0 || scriptIdCount > 0 || html.includes(`${API_PREFIX}/module?`);
    const upToDate = installed && markerStartCount === 1 && markerEndCount === 1 && scriptIdCount === 1
        && html.includes(getBridgeBlock()) && rewriteIndexModuleProxyTags(html) === html;
    return {
        ok: true,
        enabled: !!config.earlyBridgeEnabled,
        autoInstall: !!config.autoInstallEarlyBridge,
        installed,
        upToDate,
        indexPath,
        bridgeSrc: BRIDGE_SRC,
        markerStartCount,
        markerEndCount,
        scriptIdCount,
        backupDir: getBackupDir(root),
    };
}

export function installEarlyBridge(options = {}) {
    const root = options.root || getServerRoot();
    const indexPath = getIndexPath(root);
    const html = readIndexHtml(root);
    if (!html) return { ok: false, error: `index.html not found: ${indexPath}`, status: getEarlyBridgeStatus(root) };

    assertKnownBridgeBlock(html);
    const beforeStatus = getEarlyBridgeStatus(root);
    const { html: nextHtml, mode } = insertBridgeBlock(html);
    const finalHtml = rewriteIndexModuleProxyTags(nextHtml);
    if (finalHtml === html) {
        return { ok: true, changed: false, mode: 'unchanged', backup: null, status: beforeStatus };
    }

    let backup = null;
    if (!options.noBackup) backup = makeBackup(html, root);
    writeHtmlAtomic(indexPath, finalHtml);
    return { ok: true, changed: true, mode, backup, status: getEarlyBridgeStatus(root) };
}

export function uninstallEarlyBridge(options = {}) {
    const root = options.root || getServerRoot();
    const indexPath = getIndexPath(root);
    const html = readIndexHtml(root);
    if (!html) return { ok: false, error: `index.html not found: ${indexPath}`, status: getEarlyBridgeStatus(root) };

    assertKnownBridgeBlock(html);
    const nextHtml = restoreIndexModuleProxyTags(html.replace(getMarkerRegex(), ''));
    if (nextHtml === html) {
        return { ok: true, changed: false, backup: null, status: getEarlyBridgeStatus(root) };
    }
    let backup = null;
    if (!options.noBackup) backup = makeBackup(html, root);
    writeHtmlAtomic(indexPath, nextHtml);
    return { ok: true, changed: true, backup, status: getEarlyBridgeStatus(root) };
}

export function cleanupLegacyBridge(options = {}) {
    const root = options.root || getServerRoot();
    const html = readIndexHtml(root);
    const nextHtml = cleanLegacyHtml(html);
    if (nextHtml === html) return { ok: true, changed: false, backup: null };
    const backup = makeBackup(html, root);
    writeHtmlAtomic(getIndexPath(root), nextHtml);
    return { ok: true, changed: true, backup };
}

export function makeEarlyBridgeScript() { return makeSafeBridgeScript(); }

export function autoEnsureEarlyBridge() {
    if (!config.earlyBridgeEnabled || !config.autoInstallEarlyBridge) return { ok: true, skipped: true, reason: 'disabled', status: getEarlyBridgeStatus() };
    try {
        return installEarlyBridge({ noBackup: false });
    } catch (error) {
        console.warn('[tomatojuice] Failed to install early bridge:', error);
        return { ok: false, error: error instanceof Error ? error.message : String(error), status: getEarlyBridgeStatus() };
    }
}
