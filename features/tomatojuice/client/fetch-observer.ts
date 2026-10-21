import { FETCH_OBSERVER_FLAG } from './constants';
import { scheduleCharactersRefresh } from './characters-refresh';
const mutations = new Set(['create', 'import', 'edit', 'edit-attribute', 'delete', 'rename', 'duplicate', 'merge-attributes']);
export function installFetchObserver() {
  if ((globalThis as any)[FETCH_OBSERVER_FLAG]) return;
  (globalThis as any)[FETCH_OBSERVER_FLAG] = true;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async function(input: RequestInfo | URL, init?: RequestInit) {
    const response = await baseFetch.call(this, input, init);
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin !== location.origin || method !== 'POST' || !response.ok) return response;
      const mutation = url.pathname.startsWith('/api/characters/') && mutations.has(url.pathname.split('/').pop() || '')
        || url.pathname.endsWith('/modules/tomatojuice/fast/characters-edit');
      if (mutation) scheduleCharactersRefresh(url.pathname);
    } catch (error) { console.warn('[tomatojuice] 角色写入观察失败', error); }
    return response;
  };
}
