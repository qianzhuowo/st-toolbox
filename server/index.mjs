import path from 'node:path';
import { tomatojuice } from './modules/tomatojuice/index.js';
import { loadConfigFile } from './modules/tomatojuice/config.js';
import { CONFIG_FILE_NAME } from './modules/tomatojuice/constants.js';

// Contract with the stable host plugin (server-plugin/st-toolbox-server). Bump only when init/exit semantics change;
// users must then re-copy the host once.
export const HOST_ABI = 1;
export const info = { id: 'st-toolbox-server', name: 'ST Toolbox Server', description: 'Modular ST Toolbox backend', version: '2.0.0' };
// Modules are statically registered: never resolve a request-supplied import or execute commands.
export const modules = [tomatojuice];
let active = [];
/**
 * @param {import('express').Router} router
 * @param {{ hostDir?: string }} [host] hostDir: installed host plugin directory that owns local configuration.
 */
export async function init(router, host = {}) {
    if (host.hostDir) loadConfigFile(path.join(host.hostDir, CONFIG_FILE_NAME));
    router.get('/capabilities', (_req, res) => res.json({ ok: true, ...info, protocol: 1, modules: active.map(m => ({ id: m.id, version: m.version, capabilities: m.capabilities })) }));
    for (const module of modules) {
        try { await module.init(router, `/modules/${module.id}`); active.push(module); }
        catch (error) { console.error(`[st-toolbox-server] ${module.id} init failed`, error); }
    }
}
export async function exit() {
    for (const module of active.reverse()) await module.exit?.();
    active = [];
}
