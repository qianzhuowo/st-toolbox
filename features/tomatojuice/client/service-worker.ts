import { API_PREFIX } from './constants';
import { log } from './st-context';
import { state } from './state';

function getServiceWorkerScriptURL(reg: ServiceWorkerRegistration) {
  return reg.active?.scriptURL || reg.waiting?.scriptURL || reg.installing?.scriptURL || '';
}

function isOurRegistration(reg: ServiceWorkerRegistration) {
  const scriptURL = getServiceWorkerScriptURL(reg);
  try { const url = new URL(scriptURL); return url.origin === location.origin && url.pathname === `${API_PREFIX}/sw.js`; } catch { return false; }
}

export async function refreshServiceWorkerState() {
  state.sw.supported = 'serviceWorker' in navigator;
  state.sw.registered = false;
  state.sw.controlled = Boolean(navigator.serviceWorker?.controller);
  state.sw.scriptURL = '';
  state.sw.scope = '';

  if (!state.sw.supported) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  const reg = regs.find(isOurRegistration);
  if (reg) {
    state.sw.registered = true;
    state.sw.scriptURL = getServiceWorkerScriptURL(reg);
    state.sw.scope = reg.scope;
  }
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('当前浏览器不支持 Service Worker');
  const existing = await navigator.serviceWorker.getRegistrations();
  if (existing.some(reg => new URL(reg.scope).pathname === '/' && !isOurRegistration(reg))) throw new Error('根作用域已有其他 Service Worker；请先用原插件面板撤销，tomatojuice 不会覆盖它。');
  const reg = await navigator.serviceWorker.register(`${API_PREFIX}/sw.js`, { scope: '/' });
  await navigator.serviceWorker.ready.catch(() => undefined);
  await refreshServiceWorkerState();
  log(navigator.serviceWorker.controller ? 'Service Worker 已注册并控制当前页面' : 'Service Worker 已注册；通常需要刷新一次页面才会接管当前页面', {
    scope: reg.scope,
  });
}

export async function unregisterServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  let count = 0;
  for (const reg of regs) {
    if (isOurRegistration(reg)) {
      if (await reg.unregister()) count++;
    }
  }
  await refreshServiceWorkerState();
  log(`已注销 ${count} 个性能优化器 Service Worker；刷新页面后完全恢复原接口`);
}

export async function inspectMigrationWorkers() {
  if (!navigator.serviceWorker?.getRegistrations) return [];
  const registrations = await navigator.serviceWorker.getRegistrations();
  return registrations.flatMap(registration => {
    const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
    const urls = workers.map(worker => worker!.scriptURL);
    const recognized = urls.length > 0 && urls.every(value => {
      try { const url = new URL(value); return url.origin === location.origin && (url.pathname === '/api/plugins/cocktail-plus/sw.js' || url.pathname === API_PREFIX + '/sw.js'); } catch { return false; }
    });
    return recognized ? [{ registration, urls }] : [];
  });
}
export async function cleanupMigrationWorkers() {
  const entries = await inspectMigrationWorkers();
  if (!entries.length) return '未发现可识别的 cocktail-plus / tomatojuice SW。其他 SW 不会清理。';
  if (!globalThis.confirm('仅注销以下同源已识别 SW，不会清理其他 SW 或缓存。请先保存工作，完成 HTML 修复后再刷新。\n' + entries.flatMap(entry => entry.urls).join('\n'))) return '已取消';
  let count = 0;
  for (const entry of entries) if (await entry.registration.unregister()) count++;
  return '已注销 ' + count + ' 个已识别 SW；当前页面可能仍受控，保存工作并完成 HTML 修复后刷新。';
}
