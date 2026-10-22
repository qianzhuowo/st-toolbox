import { state } from './state';
import type { CacheEndpoint, ReadPolicy } from './types';

// Missing policy (older backend / TT) is not permission to install optional interception.
export function cacheEnabled(endpoint: CacheEndpoint): boolean {
  return state.backend?.ok === true && state.backend.readPolicy?.endpoints?.[endpoint]?.enabled === true;
}

export function applyReadPolicy() {
  const disabled: ReadPolicy = {
    enabled: false,
    endpoints: {
      'characters-all': { enabled: false, timeoutMs: 2000 },
      version: { enabled: false, timeoutMs: 2000 },
    },
  };
  const bridge = (globalThis as any).__tomatojuiceEarlyBridge;
  bridge?.updatePolicy?.(state.backend?.ok ? state.backend.readPolicy || disabled : disabled);
}
