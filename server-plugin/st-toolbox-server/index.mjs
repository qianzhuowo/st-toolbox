import { tomatojuice } from './modules/tomatojuice/index.js';
export const info = { id: 'st-toolbox-server', name: 'ST Toolbox Server', description: 'Modular ST Toolbox backend', version: '1.1.0' };
// Modules are statically registered: never resolve a request-supplied import or execute commands.
export const modules = [tomatojuice];
let active = [];
export async function init(router) {
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
