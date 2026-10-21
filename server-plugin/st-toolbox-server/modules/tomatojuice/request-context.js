// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { getDataRoot, getServerRoot, sha256, stableStringify } from './utils.js';

export function getUserHandleFromRequest(req) {
    if (!req?.user?.profile?.handle) throw new Error('Authenticated user handle required');
    return String(req.user.profile.handle);
}

export function getUserKeyFromHandle(handle) {
    return sha256(`${getDataRoot()}\n${handle}`).slice(0, 32);
}

let cachedLocalOrigin = null;

function parsePortFromArgv() {
    const argv = Array.isArray(process.argv) ? process.argv : [];
    for (let i = 0; i < argv.length; i++) {
        const arg = String(argv[i] || '');
        if (arg === '--port' && argv[i + 1] !== undefined) {
            const n = Number(argv[i + 1]);
            if (Number.isInteger(n) && n > 0 && n < 65536) return n;
        }
        const inline = arg.match(/^--port=(\d+)$/);
        if (inline) {
            const n = Number(inline[1]);
            if (Number.isInteger(n) && n > 0 && n < 65536) return n;
        }
    }
    return null;
}

function parseServerConfigYaml() {
    try {
        const text = fs.readFileSync(path.join(getServerRoot(), 'config.yaml'), 'utf8');
        const lines = text.split(/\r?\n/);
        let port = null;
        let sslEnabled = false;
        let inSslBlock = false;
        for (const line of lines) {
            // Top-level `port:` only (no indentation), so the nested browserLaunch.port is ignored.
            const portMatch = line.match(/^port:\s*(\d+)/);
            if (portMatch) port = Number(portMatch[1]);
            if (/^ssl:\s*$/.test(line)) {
                inSslBlock = true;
                continue;
            }
            if (inSslBlock) {
                if (/^\S/.test(line)) {
                    inSslBlock = false;
                } else {
                    const sslMatch = line.match(/^\s+enabled:\s*(true|false)\b/);
                    if (sslMatch) sslEnabled = sslMatch[1] === 'true';
                }
            }
        }
        return { port: Number.isInteger(port) && port > 0 ? port : null, sslEnabled };
    } catch {
        return { port: null, sslEnabled: false };
    }
}

// The backend re-fetches SillyTavern's own endpoints to build/refresh caches (e.g. /api/characters/get
// for unshallow, /api/settings/save). That self-request must target the ST process on local loopback,
// NOT the client's Host header. Behind an HTTPS reverse proxy the client Host is a public domain + proxy
// port, and a server-side fetch back to it fails (TLS/loopback), which returned 500 and broke character
// cards + their embedded world info. 127.0.0.1 also matches the default whitelist; `localhost` is
// avoided on purpose so we never resolve to ::1 when the server only listens on IPv4.
export function resolveLocalServerOrigin() {
    if (cachedLocalOrigin) return cachedLocalOrigin;
    const fromYaml = parseServerConfigYaml();
    const port = parsePortFromArgv() || fromYaml.port || 8000;
    const protocol = fromYaml.sslEnabled ? 'https' : 'http';
    cachedLocalOrigin = { protocol, host: `127.0.0.1:${port}`, sslEnabled: fromYaml.sslEnabled };
    return cachedLocalOrigin;
}

export function makeRequestContext(req, options = {}) {
    const handle = getUserHandleFromRequest(req);
    const userKey = getUserKeyFromHandle(handle);
    const body = options.bodyOverride !== undefined ? options.bodyOverride : (req.body ?? {});
    const protocol = req.socket?.encrypted ? 'https' : 'http';
    const host = `127.0.0.1:${req.socket?.localPort || 8000}`;

    return {
        requestId: options.requestId || null,
        handle,
        userKey,
        directories: req.user?.directories || {},
        body,
        bodyText: options.bodyTextOverride !== undefined ? String(options.bodyTextOverride) : stableStringify(body),
        protocol,
        host,
        headers: {
            authorization: req.headers?.authorization,
            cookie: req.headers?.cookie,
            'x-csrf-token': req.headers?.['x-csrf-token'],
            'content-type': req.headers?.['content-type'] || 'application/json',
            accept: req.headers?.accept,
            'user-agent': req.headers?.['user-agent'],
        },
    };
}
