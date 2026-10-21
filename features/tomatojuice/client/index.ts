import { discoverBackend } from '../../../core/backend-client.js';
import { API_PREFIX } from './constants';
import { ensureLocalSettings } from './settings';
import { state } from './state';
import { fullProbe, warm } from './api';
import { installFetchObserver } from './fetch-observer';
import { scheduleCharactersRefresh } from './characters-refresh';
export { renderPanel } from './panel';
export { renderEarlyManagement } from './early-management';
let started = false;
export async function startBackendClient() {
  if (started) return;
  started = true;
  ensureLocalSettings();
  installFetchObserver(); // Native successful writes refresh the list even with no backend.
  const ctx = (globalThis as any).SillyTavern?.getContext?.();
  for (const key of ['CHARACTER_CREATED', 'CHARACTER_DELETED', 'CHARACTER_EDITED', 'CHARACTER_IMPORTED', 'CHARACTER_DUPLICATED', 'CHARACTER_RENAMED']) {
    const event = ctx?.eventTypes?.[key];
    if (event) ctx.eventSource.on(event, () => scheduleCharactersRefresh(key));
  }
  const capabilities = await discoverBackend();
  if (!capabilities?.modules?.some((module: any) => module.id === 'tomatojuice')) return;
  await fullProbe();
  if (!state.backend?.ok) return;
  if (!(globalThis as any).__tomatojuiceEarlyBridge) {
    // Late fetch/template acceleration; only the explicit installer can optimize pre-module startup.
    await new Promise<void>((resolve) => {
      const script = document.createElement('script'); script.src = `${API_PREFIX}/early/bridge.js`;
      script.onload = () => resolve(); script.onerror = () => { console.warn('[tomatojuice] bridge unavailable; native requests retained'); resolve(); };
      document.head.append(script);
    });
  }
  if (state.localSettings.autoWarm) await warm(false).catch(error => console.warn('[tomatojuice] 预热失败', error));
}
