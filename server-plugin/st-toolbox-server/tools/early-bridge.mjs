#!/usr/bin/env node
import { createEarlyBridgeManager } from '../modules/tomatojuice/early-management.js';
// Local recovery tool; same guarded fixed operations as the administrator UI, never exec/shell.
const [action, serverRoot, confirmation] = process.argv.slice(2);
if (!['status', 'install', 'uninstall'].includes(action) || !serverRoot || action !== 'status' && confirmation !== '--apply') {
    console.error('Usage: node early-bridge.mjs status|install|uninstall <SillyTavern-root> [--apply]');
    process.exit(2);
}
try {
    const manager = createEarlyBridgeManager(serverRoot);
    const result = action === 'status' ? { ok: true, management: manager.status() } : { ...manager.apply(action), management: manager.status() };
    console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
