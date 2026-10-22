import { API_PREFIX } from './constants';
import { log } from './st-context';
import { cacheEnabled } from './cache-policy';
let pending: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let repeat = false;
export function markAppReady() {}
export function scheduleCharactersRefreshAfterAsyncMiss(source: string) { scheduleCharactersRefresh(source); }
export function scheduleCharactersRefresh(source: string) {
  clearTimeout(pending);
  pending = setTimeout(() => { void refresh(source); }, 250);
}
async function refresh(source: string) {
  if (refreshing) { repeat = true; return; }
  refreshing = true;
  try {
    if (cacheEnabled('characters-all')) {
      // Optional preparation must not prevent the native list refresh when the backend fails.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const { postJson } = await import('./api');
        await postJson(`${API_PREFIX}/invalidate`, { endpoints: ['characters-all'], reason: source }, { signal: controller.signal });
        await postJson(`${API_PREFIX}/warm`, { endpoints: ['characters-all'], wait: false }, { signal: controller.signal });
      } catch (error) { console.warn('[tomatojuice] 可选角色缓存准备失败，继续原生刷新', error); }
      finally { clearTimeout(timer); }
    }
    const mod = await import(/* @vite-ignore */ '/script.js');
    if (typeof mod.getCharacters !== 'function') throw new Error('Core getCharacters export not available');
    // Native list load/re-render, no page reload and no synthetic empty list.
    await mod.getCharacters();
    log('角色列表已更新', { source });
  } catch (error) { console.warn('[tomatojuice] 角色列表刷新失败，可使用酒馆原生刷新', error); }
  finally { refreshing = false; if (repeat) { repeat = false; scheduleCharactersRefresh('queued-mutation'); } }
}
