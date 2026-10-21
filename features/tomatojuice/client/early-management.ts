import { backendRequest, discoverBackend } from '../../../core/backend-client.js';

type Management = {
    canManage: boolean; csrfReady: boolean; installed: boolean; needsRepair: boolean;
    conflict: string | null; reason: string; proxyEnabled: boolean; bridgeEnabled: boolean;
};
type Reply = { ok: boolean; management: Management; changed?: boolean; backupCreated?: boolean; refreshRequired?: boolean };
const status = {
    phase: 'unchecked' as 'unchecked' | 'ready' | 'missing' | 'unsupported' | 'error',
    management: null as Management | null, busy: false, message: '', reloadNeeded: false,
};
const views = new Map<HTMLElement, () => void>();
function publish() {
    for (const [node, render] of views) {
        if (!node.isConnected) views.delete(node);
        else render();
    }
}
function accept(reply: Reply) {
    if (!reply?.ok || !reply.management || typeof reply.management.canManage !== 'boolean' || typeof reply.management.installed !== 'boolean') {
        throw new Error('后端管理状态格式不兼容，请更新 st-toolbox-server。');
    }
    status.management = reply.management;
    status.phase = 'ready';
}
async function check() {
    if (status.busy) return;
    status.busy = true; status.message = ''; publish();
    try {
        const info = await discoverBackend({ refresh: true });
        const module = info?.modules?.find((entry: any) => entry.id === 'tomatojuice');
        status.management = null;
        if (!info || !module) status.phase = 'missing';
        else if (info.protocol !== 1 || !module.capabilities?.includes('early-management')) status.phase = 'unsupported';
        else accept(await backendRequest('tomatojuice', '/early/manage/status') as Reply);
    } catch (error) { status.phase = 'error'; status.message = String(error); }
    finally { status.busy = false; publish(); }
}
async function change(action: 'install' | 'uninstall', blockedReason: string) {
    const current = status.management;
    if (status.busy || status.phase !== 'ready' || !current?.canManage) return;
    if (action === 'install' && (blockedReason || current.conflict)) return;
    if (action === 'uninstall' && !current.installed) return;
    const explanation = action === 'install'
        ? '安装／修复首屏接入将修改酒馆 public/index.html，影响此服务器的所有用户。会先自动备份，再添加 Tomatojuice 提前加载入口和模块映射（含 dynamic-styles 修复）。不执行系统命令，也不自动刷新页面。\n\n确认继续？'
        : '撤销将移除 public/index.html 中属于 Tomatojuice 的首屏入口与模块映射，影响所有用户。会先备份并保留其他编辑；不会注销 SW 或停止当前页面已加载的代码。\n\n确认继续？';
    if (!globalThis.confirm(explanation)) return;
    status.busy = true; status.message = ''; publish();
    try {
        // Exactly one mutation request. Unknown outcomes must be inspected, never automatically retried.
        const reply = await backendRequest('tomatojuice', `/early/${action}`, { confirm: true }) as Reply;
        accept(reply);
        status.reloadNeeded = true;
        status.message = `${reply.changed ? (action === 'install' ? '首屏接入已安装／修复。' : '首屏接入已撤销。') : '入口已处于目标状态，无需重复修改。'}${reply.backupCreated ? '已保存 HTML 备份。' : ''}请保存当前工作后刷新页面。${action === 'uninstall' ? '若注册过 Tomatojuice SW，请另行注销。' : ''}`;
    } catch (error) {
        status.phase = 'error';
        status.message = `操作未确认成功：${String(error)}。请先点击“检查首屏状态”，不要盲目重复提交。`;
    } finally { status.busy = false; publish(); }
}

/** Always available, including when optimizers are disabled/conflicting. Does not load a bridge or SW. */
export function renderEarlyManagement(host: HTMLElement, { installBlockedReason = '' } = {}) {
    const root = document.createElement('section'); root.className = 'st-toolbox-feature-body tomatojuice-early-management';
    root.dataset.tomatojuiceEarlyManagement = 'true'; host.append(root);
    const title = document.createElement('h4'); title.textContent = '首屏优化与 dynamic-styles 兼容修复';
    const description = document.createElement('p');
    description.textContent = '通常只需安装一次：让优化早于酒馆核心启动，并修复滚动条 focus 样式生成。此操作会备份并修改全站 public/index.html；不改核心 JS，不需要终端。酒馆更新覆盖入口后可再次检查／修复。';
    const line = document.createElement('p'); line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite');
    const message = document.createElement('p'); message.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div'); actions.className = 'flex-container flexGap5';
    function button(text: string, action: () => unknown) {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'menu_button'; node.textContent = text;
        node.addEventListener('click', () => { void action(); }); actions.append(node); return node;
    }
    const checkButton = button('检查首屏状态', check);
    const install = button('安装／修复首屏接入', () => change('install', installBlockedReason));
    const remove = button('撤销首屏接入', () => change('uninstall', ''));
    const reload = button('刷新页面使其生效', () => {
        if (globalThis.confirm('请先保存当前聊天和设置。确定现在刷新页面？')) globalThis.location.reload();
    });
    root.append(title, description, line, actions, message);
    const render = () => {
        const value = status.management;
        const states = { unchecked: '正在获取首屏安装状态……', missing: '后端不可用：请先部署并启用 st-toolbox-server，然后重新检查。', unsupported: '当前后端不支持面板管理，请更新 st-toolbox-server 并重启酒馆。', error: '无法确认当前状态。', ready: value?.installed ? (value.needsRepair ? '已安装，但需要修复／更新。' : '已安装，入口为当前版本。') : '尚未安装首屏入口。' };
        line.textContent = status.busy ? '正在检查或执行首屏操作，请稍候……' : states[status.phase];
        const warnings = [status.message, value?.reason, value?.conflict, installBlockedReason];
        if (value && (!value.proxyEnabled || !value.bridgeEnabled)) warnings.push('后端配置关闭了部分首屏功能；安装入口不会自动开启这些配置，dynamic-styles 修复需要 moduleProxyEnabled。');
        if (status.reloadNeeded && !status.message) warnings.push('本页操作已完成，保存当前工作后刷新页面；当前已加载的代码不会被热撤销。');
        message.textContent = warnings.filter(Boolean).join(' ');
        checkButton.disabled = status.busy;
        const blocked = status.busy || status.phase !== 'ready' || !value?.canManage;
        install.disabled = blocked || !!value?.conflict || !!installBlockedReason;
        remove.disabled = blocked || !value?.installed;
        reload.hidden = !status.reloadNeeded; reload.disabled = status.busy;
        root.setAttribute('aria-busy', String(status.busy));
    };
    for (const node of views.keys()) if (!node.isConnected) views.delete(node);
    views.set(root, render); render();
    // Retained panels are not re-rendered when the settings dialog reopens.
    // Revalidate on activation; the busy guard merges simultaneous read requests.
    const panel = host.closest?.('[role="tabpanel"]');
    panel?.addEventListener('st-toolbox:settings-visible', () => {
        if (root.isConnected) void check();
    });
    void check();
}
