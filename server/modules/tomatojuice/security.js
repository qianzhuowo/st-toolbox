import fs from 'node:fs';
import path from 'node:path';
function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
export function assertLeaf(value, label = 'file') {
    if (value === undefined || value === null || value === '') return;
    if (Number.isSafeInteger(value) && value >= 0) return; // Native group IDs may be numeric.
    if (typeof value !== 'string' || value === '.' || value === '..' || /[\\/\x00-\x1f:]/.test(value) || value.endsWith('.') || value.endsWith(' ')) throw invalid(`Invalid ${label}`);
}
export function assertUserPath(root, ...segments) {
    if (!root) throw invalid('User directory unavailable');
    segments.forEach(segment => assertLeaf(segment));
    const candidate = path.resolve(root, ...segments.map(String));
    const relative = path.relative(path.resolve(root), candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw invalid('Path escapes user directory');
    if (fs.existsSync(root)) {
        let existing = candidate;
        while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
        const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(existing));
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw invalid('External symlink rejected', 403);
    }
    return candidate;
}
export function validateRequest(req) {
    if (!req.user?.profile?.handle || !req.user?.directories) throw invalid('Authenticated SillyTavern user required', 401);
    const directories = req.user.directories;
    for (const body of [req.body, req.body?.identity]) {
        if (!body || typeof body !== 'object') continue;
        for (const key of ['avatar', 'avatar_url', 'file_name', 'chatfile', 'id', 'group_id']) assertLeaf(body[key], key);
        const avatar = body.avatar_url || body.avatar;
        if (avatar && directories.characters) assertUserPath(directories.characters, avatar);
        if (avatar && body.file_name && directories.chats) assertUserPath(directories.chats, String(avatar).replace(/\.png$/i, ''), `${body.file_name}.jsonl`);
        if (body.id !== undefined && directories.groupChats) assertUserPath(directories.groupChats, `${body.id}.jsonl`);
    }
}
