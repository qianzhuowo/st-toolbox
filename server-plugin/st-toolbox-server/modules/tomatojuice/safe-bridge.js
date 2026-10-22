import { API_PREFIX, VERSION } from './constants.js';
import { config } from './config.js';

/** Deliberately read-only. No module rewriting, write retries, prefetch or SW registration. */
export function makeSafeBridgeScript() {
    return `/* tomatojuice optional read bridge ${VERSION} */
(() => {
  if (window.__tomatojuiceEarlyBridge || !${JSON.stringify(!!config.enabled && !!config.earlyBridgeEnabled && !!config.earlyBridgePatchFetch)}) return;
  const original = window.fetch.bind(window);
  const state = window.__tomatojuiceEarlyBridge = { version: ${JSON.stringify(VERSION)}, mode: 'optional-read-only', failures: 0, bypassUntil: 0 };
  const routes = new Map([['/api/characters/all', ['POST', '/fast/characters-all']], ['/version', ['GET', '/fast/version']]]);
  window.fetch = async function(input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const route = routes.get(url.pathname);
    const signal = init?.signal || input?.signal;
    if (!route || url.origin !== location.origin || method !== route[0] || url.search || Date.now() < state.bypassUntil || signal?.aborted) return original(input, init);
    // Clone before dispatch: the original request remains available for native read fallback.
    let request;
    try { request = new Request(input instanceof Request ? input.clone() : input, init); } catch { return original(input, init); }
    const controller = new AbortController();
    let timer, onAbort;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('tomatojuice read deadline')); }, 2000);
      onAbort = () => { controller.abort(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = (async () => {
        const response = await original(new URL(${JSON.stringify(API_PREFIX)} + route[1], location.origin).href, {
          method, headers: request.headers, credentials: request.credentials, cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok || !/application\\/json/i.test(response.headers.get('content-type') || '')) throw new Error('invalid fast status/type');
        const value = await response.clone().json();
        if (url.pathname === '/api/characters/all' ? !Array.isArray(value) || response.headers.get('x-tomatojuice-async') === '1' || /ASYNC-MISS/i.test(response.headers.get('x-tomatojuice-state') || response.headers.get('x-cocktail-cache') || '') : !value || typeof value !== 'object' || Array.isArray(value) || typeof value.pkgVersion !== 'string') throw new Error('invalid fast response shape');
        return response;
      })();
      const response = await Promise.race([work, deadline]);
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
