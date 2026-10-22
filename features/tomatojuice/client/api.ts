import { backendRequest } from '../../../core/backend-client.js';
import { API_PREFIX } from './constants';
import { refreshServiceWorkerState } from './service-worker';
import { state } from './state';
import type { BackendProbe, BrowserLogList, CacheEndpoint } from './types';
import { applyReadPolicy, cacheEnabled } from './cache-policy';
export async function postJson<T>(url: string, body: unknown = {}, options: { signal?: AbortSignal } = {}): Promise<T> {
  if (!url.startsWith(API_PREFIX + '/')) throw new Error('Invalid tomatojuice backend route');
  return backendRequest('tomatojuice', url.slice(API_PREFIX.length), body, options);
}
export async function probeBackend() {
  try { state.backend = await postJson<BackendProbe>(`${API_PREFIX}/probe`); }
  catch (error) { state.backend = null; console.info('[tomatojuice] 可选后端不可用，保留原生请求', String(error)); }
  applyReadPolicy();
}
export async function warm(wait = false) {
  const endpoints = (['characters-all', 'version'] as CacheEndpoint[]).filter(cacheEnabled);
  if (!endpoints.length) return { ok: true, skipped: true, reason: 'cache-disabled-or-unavailable' };
  const result = await postJson(`${API_PREFIX}/warm`, { endpoints, wait });
  await refreshStatus(); return result;
}
export async function clearCache() {
  const result = await postJson(`${API_PREFIX}/cache/clear`, { endpoints: ['characters-all', 'version'] });
  await refreshStatus(); return result;
}
export async function refreshStatus() {
  await refreshServiceWorkerState();
  if (state.backend) state.backend = { ...state.backend, ...await postJson<BackendProbe>(`${API_PREFIX}/status`) };
  applyReadPolicy();
}
export async function fullProbe() { await Promise.allSettled([probeBackend(), refreshServiceWorkerState()]); }
export async function refreshBrowserLogs(limit = 1000) {
  if (!state.backend?.ok) return null;
  const result = await postJson<BrowserLogList>(`${API_PREFIX}/browser-logs/list`, { limit });
  state.browserLogs = result; return result;
}
export async function clearBrowserLogs() {
  await postJson(`${API_PREFIX}/browser-logs/clear`);await refreshBrowserLogs();
}
