import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { getEarlyBridgeStatus, installEarlyBridge, uninstallEarlyBridge } from './early-bridge.js';
import { getServerRoot } from './utils.js';
import { config } from './config.js';
import { validateRequest } from './security.js';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const LEGACY = /cocktail-plus|data-cp-module-proxy-original=["'][^"']+["'][^>]*\/api\/plugins\/cocktail-plus/i;

// Reject redirected targets, including junctions and dangling symlinks. Root itself may be a symlink.
function safeChild(root, relative, allowMissing = false) {
    let current = root;
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw fail('首屏入口或备份路径包含符号链接，已拒绝修改。');
        } catch (error) {
            if (error.code === 'ENOENT' && allowMissing) continue;
            throw error;
        }
    }
    return current;
}
function inspectRoot(candidate) {
    const root = fs.realpathSync(candidate);
    for (const file of ['server.js', 'package.json', 'public/index.html']) {
        if (!fs.statSync(safeChild(root, file)).isFile()) throw fail('无法确认当前酒馆目录，已拒绝修改。');
    }
    safeChild(root, 'data/_st-toolbox/html-backups', true);
    return root;
}
function safeError(error) {
    if (error.status) return error;
    return fail(error.code === 'EACCES' || error.code === 'EPERM'
        ? '酒馆进程没有读写入口或备份目录的权限；请检查文件权限。'
        : '无法安全读取或修改酒馆入口；请检查目录、备份及文件权限。', 500);
}
function csrfMatches(req) {
    const expected = req.session?.csrfToken;
    const supplied = req.headers?.['x-csrf-token'];
    if (typeof expected !== 'string' || !expected || typeof supplied !== 'string') return false;
    const a = Buffer.from(expected), b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Fixed root is captured at module init; never resolve a root/body/html supplied over HTTP. */
export function createEarlyBridgeManager(serverRoot = getServerRoot()) {
    const fixedRoot = path.resolve(serverRoot);
    function inspect() {
        const root = inspectRoot(fixedRoot);
        const raw = getEarlyBridgeStatus(root);
        const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
        const malformed = raw.markerStartCount !== raw.markerEndCount || raw.markerStartCount > 1
            || (raw.markerStartCount === 1 && html.indexOf('<!-- tomatojuice early bridge start -->') > html.indexOf('<!-- tomatojuice early bridge end -->'))
            || raw.scriptIdCount > 1 || (raw.scriptIdCount > 0 && raw.markerStartCount === 0);
        return { root, raw, malformed, conflict: LEGACY.test(html) ? '检测到旧 cocktail-plus 首屏入口，请先用旧工具撤销，避免叠加。' : null };
    }
    function status(req) {
        const admin = req ? req.user?.profile?.admin === true : true;
        const csrfReady = req ? csrfMatches(req) : true;
        const base = { canManage: admin && csrfReady, csrfReady, installed: false, needsRepair: false, conflict: null,
            reason: !admin ? '仅酒馆管理员可以安装或撤销全局首屏入口。' : !csrfReady ? '需要有效的酒馆 CSRF 会话。请刷新页面；如已关闭 CSRF 保护，请重新开启后重启。' : '',
            proxyEnabled: !!config.moduleProxyEnabled, bridgeEnabled: !!config.enabled && !!config.earlyBridgeEnabled };
        try {
            const { raw, malformed, conflict } = inspect();
            return { ...base, installed: raw.installed, needsRepair: raw.installed && !raw.upToDate, conflict,
                canManage: base.canManage && !malformed,
                reason: malformed ? '首屏入口标记不完整或重复；请使用备份手动核对 HTML，不能安全自动修改。' : base.reason };
        } catch (error) { return { ...base, canManage: false, reason: safeError(error).message }; }
    }
    function apply(action) {
        if (!['install', 'uninstall'].includes(action)) throw fail('未知首屏管理操作。', 400);
        let lock, lockFile;
        try {
            const { root, malformed, conflict } = inspect();
            if (malformed) throw fail('首屏入口标记不完整或重复；请先手动核对 HTML 与备份。');
            if (action === 'install' && conflict) throw fail(conflict);
            lockFile = path.join(root, 'public', 'index.html.st-toolbox.lock');
            try { lock = fs.openSync(lockFile, 'wx', 0o600); }
            catch (error) { if (error.code === 'EEXIST') throw fail('另一个首屏操作正在执行；若进程曾异常退出，请确认无操作后手动清理 index.html.st-toolbox.lock。'); throw error; }
            // Sync operations do not yield between validation, backup and rename. The lock also covers the CLI.
            const result = action === 'install' ? installEarlyBridge({ root, noBackup: false }) : uninstallEarlyBridge({ root, noBackup: false });
            if (!result.ok) throw fail('首屏入口操作未完成；原始入口未被确认更新。', 500);
            return { ok: true, changed: result.changed, backupCreated: !!result.backup, refreshRequired: true };
        } catch (error) { throw safeError(error); }
        finally { if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockFile); } }
    }
    return { status, apply };
}

export function registerEarlyManagement(route, manager = createEarlyBridgeManager()) {
    route('post', '/early/manage/status', (req, res) => {
        validateRequest(req);
        res.json({ ok: true, management: manager.status(req) });
    });
    for (const action of ['install', 'uninstall']) {
        route('post', `/early/${action}`, (req, res) => {
            validateRequest(req);
            if (req.user.profile.admin !== true) throw fail('仅酒馆管理员可以修改全局首屏入口。', 403);
            // Host CSRF middleware runs before plugins. Independently fail closed even if disabled upstream.
            if (!csrfMatches(req)) throw fail('缺少有效的 CSRF 会话；请启用酒馆 CSRF 保护并刷新页面。', 403);
            if (req.headers?.['sec-fetch-site'] === 'cross-site') throw fail('不允许跨站首屏管理请求。', 403);
            if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw fail('首屏管理请求必须使用 JSON。', 400);
            if (!req.body || req.body.confirm !== true || Object.keys(req.body).some(key => key !== 'confirm')) throw fail('必须明确确认操作；不接受路径、脚本或其他参数。', 400);
            const result = manager.apply(action);
            res.json({ ...result, management: manager.status(req) });
        });
    }
}
