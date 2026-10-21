import { listTomatojuiceSubpanels } from './optimizers/core/subpanels.js';
import { startBackendClient, renderPanel, renderEarlyManagement } from './runtime.js';
const MODULES = ['startup-optimizer', 'chat-render-optimizer', 'preset-drag-optimizer', 'chat-saving-unblocker', 'ui-animation-optimizer', 'worldinfo-drag-optimizer', 'regex-drag-optimizer', 'worldinfo-panel-slim'];
const url = new URL('./optimizers/style.css', import.meta.url);
let loaded = false;
let conflict = '';
// Compatibility-only legacy names below identify old extensions/bridges/SWs, not this feature.
function legacyConflict() {
    const early = globalThis.__cocktailPlusEarlyBridge;
    const scripts = [...document.scripts].map(s => s.src);
    return early || scripts.some(src => /\/third-party\/(cocktail|cocktail-plus)\//.test(src)) || navigator.serviceWorker?.controller?.scriptURL?.includes('/api/plugins/cocktail-plus/');
}
export function createTomatojuiceFeature({ settings, saveSettings }) {
    async function init() {
        if (loaded) return;
        const oldWorker = await navigator.serviceWorker?.getRegistrations?.().then(registrations => registrations.some(registration => [registration.active, registration.waiting, registration.installing].some(worker => worker?.scriptURL.includes('/api/plugins/cocktail-plus/')))).catch(() => false);
        if (legacyConflict() || oldWorker) { conflict = '检测到旧 cocktail / cocktail-plus 或其 SW：本轮不叠加优化。请禁用旧扩展、用旧面板注销旧 SW 并撤销旧 early bridge，刷新后再启用 tomatojuice。'; console.warn('[st-toolbox:tomatojuice]', conflict); return; }
        if (!settings.tomatojuice.enabled) return;
        loaded = true;
        const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = url.href; document.head.append(style);
        for (const name of MODULES) {
            try { await import(`./optimizers/modules/${name}.js`); }
            catch (error) { console.error(`[tomatojuice] ${name} 初始化失败`, error); }
        }
        try {
            const { displayVersion } = await import('/script.js');
            const match = String(displayVersion).match(/(\d+)\.(\d+)\.(\d+)/);
            if (match && (Number(match[1]) > 1 || Number(match[1]) === 1 && Number(match[2]) >= 14)) await import('./optimizers/modules/regex-refresh-optimizer.js');
            else console.info('[tomatojuice] 正则刷新优化需 ST >= 1.14；未确定版本时保留原生行为');
        } catch (error) { console.warn('[tomatojuice] 版本门控失败，保留原生正则', error); }
        void startBackendClient().then(() => {
            const host = document.getElementById('tomatojuice-backend-panel');
            if (host) renderPanel(host);
        }).catch(error => console.warn('[tomatojuice] 后端初始化失败，前端保留原生请求', error));
    }
    function renderSettings(container) {
        const label = document.createElement('label');
        const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = settings.tomatojuice.enabled;
        toggle.addEventListener('change', () => { settings.tomatojuice.enabled = toggle.checked; saveSettings(); });
        label.append(toggle, ' 启用茄汁前端优化'); container.append(label);
        const help = document.createElement('p'); help.className = 'st-toolbox-help';
        help.textContent = '修改后刷新生效。此开关不控制已安装的全站首屏入口，请在下方单独管理。'; container.append(help);
        renderEarlyManagement(container, { installBlockedReason: conflict || (legacyConflict() ? '检测到旧 cocktail / cocktail-plus：请停用旧插件及其 bridge/SW 后刷新，再安装首屏入口。' : '') });
        if (conflict) { const warning = document.createElement('p'); warning.textContent = conflict; container.append(warning); return; }
        if (!settings.tomatojuice.enabled) return;
        const backend = document.createElement('div'); backend.id = 'tomatojuice-backend-panel'; container.append(backend); renderPanel(backend);
        const ctx = globalThis.SillyTavern?.getContext?.();
        for (const panel of listTomatojuiceSubpanels()) {
            const details = document.createElement('details'); const title = document.createElement('summary'); title.textContent = panel.title; details.append(title);
            const content = document.createElement('div'); content.className = 'st-toolbox-feature-body'; details.append(content); container.append(details);
            try { panel.render(content, ctx); } catch (error) { content.textContent = `面板渲染失败：${error.message}`; }
        }
        const note = document.createElement('p'); note.textContent = '后端需手动部署；首屏入口在上方安装或撤销。更新使用酒馆扩展更新，不执行服务器命令。html-render-cache / preset-panel-optimizer 为实验模块，默认不启用。'; container.append(note);
    }
    return { init, renderSettings, syncSettings() {} };
}
