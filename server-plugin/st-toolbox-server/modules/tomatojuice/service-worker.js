import { VERSION, SW_MESSAGE_SOURCE } from './constants.js';

/** Compatibility update for installed toolbox workers. Never intercept navigation, core modules or writes.
 * Old frontends may still explicitly register this URL; activation makes those registrations harmless.
 * Do not unregister here: only explicit user action may remove a registration.
 */
export function makeServiceWorkerScript() {
    return `/* tomatojuice compatibility Service Worker v${VERSION} */
const VERSION = ${JSON.stringify(VERSION)};
const MESSAGE_SOURCE = ${JSON.stringify(SW_MESSAGE_SOURCE)};
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type === 'PING' || event.data?.type === 'GET_STATUS') {
    const message = { source: MESSAGE_SOURCE, type: 'STATUS', version: VERSION, mode: 'native-passthrough' };
    event.ports?.[0]?.postMessage(message);
    event.source?.postMessage(message);
  }
});
// Intentionally no fetch listener. Native networking remains functional without the backend.
`;
}
