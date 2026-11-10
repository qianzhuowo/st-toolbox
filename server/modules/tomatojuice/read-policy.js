import { config } from './config.js';
import { getRequestBudget } from './budgets.js';

/** Public read-only policy. No filesystem paths, user data or write capabilities. */
export function makeReadPolicy() {
    return {
        enabled: !!config.enabled && !!config.earlyBridgeEnabled && !!config.earlyBridgePatchFetch,
        endpoints: Object.fromEntries([
            ['characters-all', 'cacheCharactersAll'],
            ['version', 'cacheVersion'],
        ].map(([key, flag]) => [key, {
            enabled: !!config.enabled && !!config[flag],
            timeoutMs: getRequestBudget(config, key).bridgeTimeoutMs,
        }])),
    };
}
