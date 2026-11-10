// Stable host for the st-toolbox backend. Copy this directory ONCE to SillyTavern/plugins/st-toolbox-server.
// The backend implementation is loaded from the installed st-toolbox extension, so updating the extension
// updates the backend (restart SillyTavern to apply); this host never needs to be copied again unless HOST_ABI changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_ABI = 1;
export const info = {
    id: 'st-toolbox-server',
    name: 'ST Toolbox Server',
    description: 'Loads the st-toolbox backend from the globally installed st-toolbox extension',
};

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ID = 'st-toolbox';
let backend = null;

// Only the global (admin-installed) extension directory is trusted to provide server code;
// per-user extension directories can be written by non-admin users.
function locateBackendEntry() {
    const thirdParty = fs.realpathSync(path.resolve(process.cwd(), 'public', 'scripts', 'extensions', 'third-party'));
    const entry = path.join(thirdParty, EXTENSION_ID, 'server', 'index.mjs');
    if (!fs.existsSync(entry)) {
        throw new Error(`st-toolbox backend not found at ${entry}; install the st-toolbox extension for all users`);
    }
    const real = fs.realpathSync(entry);
    if (!real.startsWith(thirdParty + path.sep)) throw new Error('st-toolbox backend resolves outside the global extensions directory');
    return real;
}

export async function init(router) {
    const entry = locateBackendEntry();
    const implementation = await import(pathToFileURL(entry).href);
    if (implementation.HOST_ABI !== HOST_ABI) {
        throw new Error(`st-toolbox backend expects host ABI ${implementation.HOST_ABI}, installed host is ${HOST_ABI}; re-copy server-plugin/st-toolbox-server from the extension`);
    }
    await implementation.init(router, { hostDir: HOST_DIR });
    backend = implementation;
    console.log(`[st-toolbox-server] backend ${implementation.info?.version || ''} loaded from ${path.dirname(entry)}`);
}

export async function exit() {
    await backend?.exit?.();
    backend = null;
}
