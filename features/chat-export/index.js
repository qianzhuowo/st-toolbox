import { createNativeMenuItem } from '../../core/native-menu.mjs';
import { getContext } from '../../../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../../../popup.js';
import { power_user } from '../../../../../power-user.js';
import { buildFilename } from './output.js';

const MENU_ID = 'st-toolbox-chat-export-menu';
const pendingUrls = new Map();

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    try {
        link.click();
    } finally {
        link.remove();
        pendingUrls.set(url, setTimeout(() => {
            URL.revokeObjectURL(url);
            pendingUrls.delete(url);
        }, 60000));
    }
}

function currentReasoningTags() {
    const prefix = String(power_user.reasoning?.prefix || '').trim();
    const suffix = String(power_user.reasoning?.suffix || '').trim();
    const match = /^<([\p{L}_][\p{L}\p{N}_.:-]*)>$/u.exec(prefix);
    return match && match[1].length <= 128 && suffix.toLowerCase() === `</${match[1].toLowerCase()}>` ? [match[1].toLowerCase()] : [];
}

export function createChatExportFeature({ eventSource, eventTypes, settings, saveSettings, isGenerating }) {
    let initialized = false;
    let opening = false;
    let activeDialog = null;
    let settingsContainer = null;

    const notify = message => globalThis.toastr?.warning(message, '对话导出');

    async function openDialog() {
        if (opening || activeDialog || !settings.chatExport.enabled) return;
        const context = getContext();
        if (!context.chat?.length || (!context.groupId && context.characterId == null)) {
            notify('请先打开一个有消息的聊天。');
            return;
        }
        opening = true;
        try {
            // Load parsing and scheduling code only after an explicit user action.
            const [{ parseTagNames }, { runExportTask }, { snapshotChat }] = await Promise.all([
                import('./processor.js'), import('./runner.js'), import('./snapshot.js'),
            ]);
            const root = document.createElement('div');
            root.className = 'st-toolbox-export-dialog';
            root.innerHTML = `
                <h3>导出当前对话</h3>
                <p class="st-toolbox-export-help" data-ui="scope"></p>
                <fieldset data-ui="fields">
                    <div class="st-toolbox-export-grid">
                        <label>导出对象
                            <select class="text_pole" data-ui="role">
                                <option value="all">全部（char + user）</option>
                                <option value="char">仅角色（char，群聊含所有角色）</option>
                                <option value="user">仅用户（user）</option>
                            </select>
                        </label>
                        <label>文件格式
                            <select class="text_pole" data-ui="format">
                                <option value="txt">TXT 纯文本</option>
                                <option value="md">Markdown</option>
                                <option value="jsonl">JSONL（可导入 SillyTavern）</option>
                            </select>
                        </label>
                    </div>
                    <label>楼层（留空或 * 表示全部）
                        <input class="text_pole" data-ui="floors" maxlength="4096" placeholder="例如：0-10,15,20-30" autocomplete="off" aria-describedby="st-toolbox-export-floor-summary">
                        <small id="st-toolbox-export-floor-summary" data-ui="floorSummary" aria-live="polite"></small>
                    </label>
                    <label class="checkbox_label"><input type="checkbox" data-ui="includeSystem">全部导出时包含系统消息</label>
                    <label class="checkbox_label"><input type="checkbox" data-ui="removeReasoning">移除思维链（独立思维链及正文思维链标签）</label>
                    <p class="st-toolbox-export-help">思维链标签包括 think、thinking、reasoning、analysis，以及当前 ST 思维链模板中的成对标签。其他自定义标签请在下方指定。</p>
                    <label>移除这些标签及包裹内容（逗号或空格分隔）
                        <input class="text_pole" data-ui="tags" maxlength="32768" placeholder="例如：status, StatusBlock, 状态栏" autocomplete="off">
                    </label>
                    <div class="st-toolbox-export-actions">
                        <button type="button" class="menu_button" data-ui="detect"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>探测所选楼层的标签</button>
                        <button type="button" class="menu_button" data-ui="clear">清空标签选择</button>
                    </div>
                    <div class="st-toolbox-export-candidates" data-ui="candidates">点击探测后可勾选标签，也可以直接输入标签名。</div>
                </fieldset>
                <p class="st-toolbox-export-help">使用原始文本，楼层从 0 开始，不依赖页面是否已加载。每楼只导出当前回复，不含历史 swipe、附件文件及扩展元数据。清理不会修改原聊天。</p>
                <p class="st-toolbox-export-help">标签大小写不敏感，支持属性、嵌套与跨行；代码块内的真实标签也会被处理，转义的 &amp;lt;tag&amp;gt; 不会。所选标签若未闭合，将删除至该楼末尾。普通 HTML 标签不会默认勾选。</p>
                <div class="st-toolbox-export-actions">
                    <button type="button" class="menu_button" data-ui="export"><i class="fa-solid fa-file-export" aria-hidden="true"></i>导出文件</button>
                    <button type="button" class="menu_button" data-ui="cancel" hidden>取消任务</button>
                </div>
                <progress data-ui="progress" max="1" value="0" hidden></progress>
                <div class="st-toolbox-export-status" data-ui="status" role="status" aria-live="polite"></div>`;
            const ui = Object.fromEntries(Array.from(root.querySelectorAll('[data-ui]'), node => [node.dataset.ui, node]));
            const preferences = settings.chatExport;
            ui.role.value = preferences.role;
            ui.format.value = preferences.format;
            ui.includeSystem.checked = preferences.includeSystem;
            ui.removeReasoning.checked = preferences.removeReasoning;
            ui.tags.value = preferences.tags;
            const chatKey = { chat: context.chat, chatId: context.chatId, characterId: context.characterId, groupId: context.groupId };
            const sameChat = () => {
                const now = getContext();
                return now.chat === chatKey.chat && now.chatId === chatKey.chatId
                    && now.characterId === chatKey.characterId && now.groupId === chatKey.groupId;
            };
            const updateScope = () => {
                const total = context.chat.length;
                ui.scope.textContent = `当前聊天：${String(context.chatId || context.name2 || '聊天')}。范围先按原始楼层选择，再筛选对象。`;
                ui.floorSummary.textContent = total
                    ? `当前共 ${total} 楼，可填写编号：0–${total - 1}（含首尾；按筛选前的全部消息计数）。`
                    : '当前共 0 楼，暂无可导出的消息。';
                ui.includeSystem.disabled = ui.role.value !== 'all';
            };
            let controller = null;
            let closed = false;
            let stale = false;
            let revision = 0;
            let cancelReason = '';
            const resetCandidates = () => {
                ui.candidates.textContent = '筛选或聊天内容已变化，请重新探测；手动填写的标签仍保留。';
            };
            const synchronizeCheckboxes = () => {
                try {
                    const selected = new Set(parseTagNames(ui.tags.value));
                    ui.candidates.querySelectorAll('input').forEach(input => { input.checked = selected.has(input.value); });
                } catch { /* Validation is shown when a task starts, not while typing. */ }
            };
            const setBusy = busy => {
                ui.fields.disabled = busy || stale;
                ui.export.disabled = busy || stale;
                ui.cancel.hidden = !busy;
                ui.progress.hidden = !busy;
                root.setAttribute('aria-busy', String(busy));
            };
            const invalidate = switched => {
                revision++;
                stale ||= switched;
                cancelReason = switched ? '聊天已切换，请关闭此窗口后重新打开。' : '聊天内容已变化，任务已取消，请重新探测或导出。';
                controller?.abort();
                resetCandidates();
                ui.status.textContent = cancelReason;
                if (!switched) updateScope();
                if (!controller) setBusy(false);
            };
            activeDialog = { invalidate };

            function optionsFor(action) {
                const tags = parseTagNames(ui.tags.value);
                return {
                    action, role: ui.role.value, format: ui.format.value, floors: ui.floors.value,
                    includeSystem: ui.includeSystem.checked, removeReasoning: ui.removeReasoning.checked,
                    tags, reasoningTags: currentReasoningTags(),
                    header: { user_name: context.name1 || 'User', character_name: context.name2 || 'Character' },
                };
            }

            function showCandidates(result) {
                const fragment = document.createDocumentFragment();
                const selected = new Set(parseTagNames(ui.tags.value));
                for (const candidate of result.candidates) {
                    const label = document.createElement('label');
                    label.className = 'checkbox_label';
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.value = candidate.name;
                    input.checked = selected.has(candidate.name);
                    const text = document.createElement('span');
                    // Never insert chat-controlled names or content as HTML.
                    text.textContent = `<${candidate.name}> (${candidate.count})`;
                    label.append(input, text);
                    input.addEventListener('change', () => {
                        try {
                            const names = new Set(parseTagNames(ui.tags.value));
                            if (input.checked) names.add(input.value);
                            else names.delete(input.value);
                            const value = [...names].join(', ');
                            parseTagNames(value);
                            ui.tags.value = value;
                        } catch (error) {
                            input.checked = !input.checked;
                            ui.status.textContent = error.message;
                        }
                    });
                    fragment.appendChild(label);
                }
                ui.candidates.replaceChildren(fragment);
                if (!result.candidates.length) ui.candidates.textContent = '所选内容中未发现成对或自闭合标签；未闭合标签可手动填写。';
            }

            async function perform(action) {
                if (controller || closed || stale) return;
                controller = new AbortController();
                const taskController = controller;
                const taskRevision = revision;
                cancelReason = '';
                setBusy(true);
                ui.progress.value = 0;
                ui.status.textContent = '正在准备所选消息…';
                try {
                    if (!sameChat()) { invalidate(true); return; }
                    const current = getContext();
                    if (isGenerating?.() || (current.streamingProcessor && !current.streamingProcessor.isFinished)) {
                        throw new Error('请等待当前回复生成完成或停止生成后再导出。');
                    }
                    const options = optionsFor(action);
                    const isCurrent = () => !closed && taskRevision === revision && sameChat();
                    const messages = await snapshotChat(context.chat, options, { signal: taskController.signal, isCurrent });
                    const result = await runExportTask(messages, options, {
                        signal: taskController.signal,
                        onProgress: ({ processed, total }) => {
                            if (closed || taskController.signal.aborted) return;
                            ui.progress.value = total ? processed / total : 1;
                            ui.status.textContent = `${action === 'detect' ? '探测' : '导出'}中：${processed} / ${total} 楼`;
                        },
                    });
                    if (taskController.signal.aborted || !isCurrent()) return;
                    if (!result.count) throw new Error('没有符合条件的消息，请检查楼层范围和导出对象。');
                    Object.assign(settings.chatExport, {
                        role: options.role, format: options.format, includeSystem: options.includeSystem,
                        removeReasoning: options.removeReasoning, tags: options.tags.join(', '),
                    });
                    saveSettings();
                    if (action === 'detect') {
                        showCandidates(result);
                        ui.status.textContent = `已探测 ${result.count} 条消息；显示 ${result.candidates.length} 种标签（括号内为成对／自闭合次数）。${result.candidatesTruncated ? '候选种类超过 200，仅显示部分；其他标签可手动填写。' : ''}`;
                    } else {
                        downloadBlob(result.blob, buildFilename(context.chatId || context.name2, options.role, options.format));
                        ui.status.textContent = `已发起下载：${result.count} 条消息，${(result.blob.size / 1024).toFixed(1)} KB。${result.unclosedCount ? `注意：${result.unclosedCount} 个所选标签未闭合，已删除至对应楼末尾。` : ''}`;
                    }
                } catch (error) {
                    if (!closed) ui.status.textContent = error.name === 'AbortError' ? cancelReason || '操作已取消。' : `操作失败：${error.message}`;
                    if (error.name !== 'AbortError') console.warn('[st-toolbox] 对话导出：', error);
                } finally {
                    controller = null;
                    if (!closed) setBusy(false);
                }
            }

            for (const control of [ui.role, ui.floors, ui.includeSystem, ui.removeReasoning]) {
                control.addEventListener('change', () => { resetCandidates(); updateScope(); });
            }
            ui.tags.addEventListener('input', synchronizeCheckboxes);
            ui.clear.addEventListener('click', () => { ui.tags.value = ''; synchronizeCheckboxes(); });
            ui.detect.addEventListener('click', () => void perform('detect'));
            ui.export.addEventListener('click', () => void perform('export'));
            ui.cancel.addEventListener('click', () => { cancelReason = '操作已取消。'; controller?.abort(); });
            updateScope();
            const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
                okButton: '关闭', wide: true, leftAlign: true,
                onClosing: () => {
                    closed = true;
                    controller?.abort();
                    return true;
                },
            });
            await popup.show();
        } catch (error) {
            console.error('[st-toolbox] 无法打开对话导出：', error);
            notify(`无法打开导出窗口：${error.message}`);
        } finally {
            activeDialog = null;
            opening = false;
        }
    }

    function mountMenu() {
        let menu = document.getElementById(MENU_ID);
        if (!settings.chatExport.enabled) { menu?.remove(); return; }
        const host = document.querySelector('#options .options-content');
        if (!host) return;
        if (menu?.tagName === 'A') {
            if (menu.parentElement !== host) host.appendChild(menu);
            return;
        }
        menu?.remove();
        menu = createNativeMenuItem({
            document, id: MENU_ID, icon: 'fa-file-export', label: '对话导出',
            onClick: () => { void openDialog(); },
        });
        host.appendChild(menu);
    }

    function syncSettings() {
        mountMenu();
        if (settingsContainer) {
            settingsContainer.querySelector('input').checked = settings.chatExport.enabled;
            settingsContainer.querySelector('button').disabled = !settings.chatExport.enabled;
        }
        if (!settings.chatExport.enabled) activeDialog?.invalidate(true);
    }

    function init() {
        if (initialized) return;
        initialized = true;
        mountMenu();
        eventSource.on(eventTypes.APP_READY, mountMenu);
        eventSource.on(eventTypes.CHAT_CHANGED, () => { activeDialog?.invalidate(true); mountMenu(); });
        // Constant-time invalidation only: no background scans or DOM observers.
        for (const name of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_FILE_EMBEDDED']) {
            if (eventTypes[name]) eventSource.on(eventTypes[name], () => activeDialog?.invalidate(false));
        }
        eventSource.on(eventTypes.GENERATION_STARTED, (_type, _options, dryRun) => {
            if (!dryRun) activeDialog?.invalidate(false);
        });
        window.addEventListener('pagehide', () => {
            activeDialog?.invalidate(true);
            for (const [url, timer] of pendingUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
            pendingUrls.clear();
        });
    }

    function renderSettings(container) {
        settingsContainer = container;
        container.innerHTML = `
            <div class="st-toolbox-section">
                <label class="checkbox_label"><input type="checkbox">启用对话导出（聊天选项菜单入口）</label>
                <div class="st-toolbox-row"><button type="button" class="menu_button">导出当前对话</button></div>
                <p class="st-toolbox-help">支持 char／user／全部、楼层范围、思维链和自选标签清理，输出 TXT、Markdown 或 JSONL。仅在点击探测或导出时扫描；记住上次成功操作的选项，不记住楼层范围。</p>
            </div>`;
        container.querySelector('input').addEventListener('change', event => {
            settings.chatExport.enabled = event.target.checked;
            saveSettings();
            syncSettings();
        });
        container.querySelector('button').addEventListener('click', () => void openDialog());
        syncSettings();
    }

    return { init, renderSettings, syncSettings };
}
