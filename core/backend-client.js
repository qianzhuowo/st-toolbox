const PREFIX = '/api/plugins/st-toolbox-server';
let discovery;
export async function discoverBackend({ refresh = false } = {}) {
    if (!discovery || refresh) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        discovery = fetch(`${PREFIX}/capabilities`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
            .then(async res => res.ok ? res.json() : null).catch(() => null).finally(() => clearTimeout(timeout));
    }
    return discovery;
}
export function moduleUrl(module, route = '') {
    if (!/^[a-z][a-z0-9-]*$/.test(module) || !route.startsWith('/')) throw new Error('Invalid module route');
    return `${PREFIX}/modules/${module}${route}`;
}
export async function backendRequest(module, route, body = {}, { signal } = {}) {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const res = await fetch(moduleUrl(module, route), { method: 'POST', credentials: 'same-origin', headers: ctx?.getRequestHeaders?.() || { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const message = typeof detail?.error === 'string' ? `：${detail.error.slice(0, 500)}` : '';
        throw Object.assign(new Error(`Backend ${module}${route}: HTTP ${res.status}${message}`), { status: res.status });
    }
    return res.json();
}
