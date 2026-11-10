import { discoverBackend } from '../../../core/backend-client.js';
import { API_PREFIX } from './constants';
import { ensureLocalSettings } from './settings';
import { state } from './state';
import { applyReadPolicy, cacheEnabled } from './cache-policy';
import { fullProbe, warm } from './api';
export { renderPanel } from './panel';
export { renderEarlyManagement } from './early-management';
let started = false;
export async function startBackendClient() {
  if (started) return;
  started = true;
  ensureLocalSettings();
  // Character list refresh after writes belongs to native SillyTavern; the backend cache invalidates by file signature.
  const capabilities = await discoverBackend();
  if (!capabilities?.modules?.some((module: any) => module.id === 'tomatojuice')) return;
  await fullProbe();
  if (!state.backend?.ok) return;
  if (!(globalThis as any).__tomatojuiceEarlyBridge && state.backend.readPolicy?.enabled && (cacheEnabled('characters-all') || cacheEnabled('version'))) {
    // Optional late read acceleration. Never gate native startup or require the script to load.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2500);
      const done = () => { clearTimeout(timer); resolve(); };
      const script = document.createElement('script'); script.async = true; script.src = `${API_PREFIX}/early/bridge.js`;
      script.onload = done; script.onerror = () => { console.warn('[tomatojuice] bridge unavailable; native requests retained'); done(); };
      document.head.append(script);
    });
  }
  applyReadPolicy();
  if (state.localSettings.autoWarm) await warm(false).catch(error => console.warn('[tomatojuice] 预热失败', error));
}
