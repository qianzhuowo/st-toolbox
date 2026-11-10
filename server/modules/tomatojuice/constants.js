// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ID = 'tomatojuice';
export const PLUGIN_NAME = 'tomatojuice';
export const DISPLAY_NAME = 'tomatojuice';

export const API_PREFIX = '/api/plugins/st-toolbox-server/modules/tomatojuice';
export const HEADER_PREFIX = 'x-tomatojuice';
export const SW_MESSAGE_SOURCE = `${PLUGIN_ID}-sw`;

export const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
// Local configuration lives in the installed host plugin directory (SillyTavern/plugins/st-toolbox-server).
export const CONFIG_FILE_NAME = 'tomatojuice.config.json';

function readVersion() {
    try {
        const raw = fs.readFileSync(path.join(PLUGIN_DIR, 'version.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const version = String(parsed?.version || '').trim();
        if (version) return version;
    } catch {}
    return '1.0.0';
}

export const VERSION = readVersion();

export const info = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version: VERSION,
    description: 'Optional SillyTavern tomatojuice plugin for frontend/backend startup and interaction paths.',
};
