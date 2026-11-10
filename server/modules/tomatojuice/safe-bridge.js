import { API_PREFIX, VERSION } from './constants.js';
import { makeReadPolicy } from './read-policy.js';

/** Deliberately read-only. No module rewriting, write retries, prefetch or SW registration. */
export function makeSafeBridgeScript() {
    return `/* tomatojuice optional read bridge ${VERSION} */
(() => {
  const policy = ${JSON.stringify(makeReadPolicy())};
  if (window.__tomatojuiceEarlyBridge) {
    // Refresh a current bridge without stacking fetch wrappers. Older bridges need a page reload.
    window.__tomatojuiceEarlyBridge.updatePolicy?.(policy);
    return;
  }
  const original = window.fetch.bind(window);
  const state = window.__tomatojuiceEarlyBridge = { version: ${JSON.stringify(VERSION)}, mode: 'optional-read-only', failures: 0, bypassUntil: 0, policy };
  state.updatePolicy = (next) => {
    if (!next || typeof next.enabled !== 'boolean' || !next.endpoints) return;
    state.policy = next;
  };
  const routes = new Map([['/api/characters/all', ['POST', 'characters-all']], ['/version', ['GET', 'version']]]);
  window.fetch = async function(input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const route = routes.get(url.pathname);
    const signal = init?.signal || input?.signal;
    const endpoint = route && state.policy.endpoints[route[1]];
    if (!state.policy.enabled || !endpoint?.enabled || !route || url.origin !== location.origin || method !== route[0] || url.search || Date.now() < state.bypassUntil || signal?.aborted) return original(input, init);
    // Clone before dispatch: the original request remains available for native read fallback.
    let request;
    try { request = new Request(input instanceof Request ? input.clone() : input, init); } catch { return original(input, init); }
    const controller = new AbortController();
    let timer, onAbort;
    const timeoutMs = Number.isFinite(endpoint.timeoutMs) ? Math.max(100, Math.min(11000, endpoint.timeoutMs)) : 2000;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('tomatojuice read deadline')); }, timeoutMs);
      onAbort = () => { controller.abort(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = (async () => {
        const response = await original(new URL(${JSON.stringify(API_PREFIX)} + '/fast/' + route[1], location.origin).href, {
          method, headers: request.headers, credentials: request.credentials, cache: 'no-store', signal: controller.signal,
        });
        if (response.headers.get('x-tomatojuice-bypass') === '1') {
          // A stale page learned that the server disabled this route; do not keep probing it.
          // Do not overwrite a newer policy received while this request was in flight.
          if (state.policy.endpoints[route[1]] === endpoint) endpoint.enabled = false;
          throw new Error('fast route disabled');
        }
        if (!response.ok || !/application\\/json/i.test(response.headers.get('content-type') || '')) throw new Error('invalid fast status/type');
        const value = await response.clone().json();
        const cacheState = response.headers.get('x-tomatojuice-state') || response.headers.get('x-cocktail-cache') || '';
        if (/STALE-ERROR/i.test(cacheState) || (url.pathname === '/api/characters/all' ? !Array.isArray(value) || response.headers.get('x-tomatojuice-async') === '1' || /ASYNC-MISS/i.test(cacheState) : !value || typeof value !== 'object' || Array.isArray(value) || typeof value.pkgVersion !== 'string')) throw new Error('invalid fast response shape/state');
        return response;
      })();
      const response = await Promise.race([work, deadline]);
      if (!state.policy.enabled || !state.policy.endpoints[route[1]]?.enabled) throw new Error('fast route disabled during request');
      state.failures = 0;
      return response;
    } catch (error) {
      controller.abort(); // Stop rejected status/type bodies before native fallback.
      if (signal?.aborted) throw signal.reason || error; // Caller cancellation is not a backend failure.
      state.failures++;
      state.bypassUntil = Date.now() + 30000;
      return original(input, init);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
})();`;
}
