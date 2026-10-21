// View-only settings shell. Feature renderers retain ownership of their settings and saves.
const META = {
    'qr-bar': { label: '快捷回复栏', icon: 'fa-keyboard', description: '管理 QR 栏的显示与收起方式，让聊天区域更清爽。' },
    notifications: { label: '回复通知', icon: 'fa-bell', description: '调整提示音、音量与标签页提醒，按自己的节奏接收回复。' },
    screenshot: { label: '消息截图', icon: 'fa-camera', description: '设置截图范围、图像质量与导出样式。' },
    'chat-export': { label: '对话导出', icon: 'fa-file-arrow-down', description: '选择导出入口及默认行为，保留你需要的对话内容。' },
    tomatojuice: { label: '茄汁 · tomatojuice', icon: 'fa-gauge-high', description: '前端优化、后端加速与首屏接入，在一个地方管理。' },
};

export function createSettingsWindow(features, { document: doc = document } = {}) {
    const make = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const icon = name => { const node = make('i', `fa-solid ${name}`); node.setAttribute('aria-hidden', 'true'); return node; };
    const dialog = make('dialog', 'st-toolbox-window');
    dialog.id = 'st-toolbox-settings-window';
    dialog.setAttribute('aria-labelledby', 'st-toolbox-window-title');
    const header = make('header', 'st-toolbox-window-header');
    const brand = make('div', 'st-toolbox-window-brand');
    const mark = make('span', 'st-toolbox-window-mark'); mark.append(icon('fa-toolbox'));
    const brandText = make('div');
    const title = make('h2', '', 'ST Toolbox'); title.id = 'st-toolbox-window-title';
    brandText.append(title, make('span', 'st-toolbox-window-subtitle', '工具箱设置'));
    brand.append(mark, brandText);
    const closeButton = make('button', 'st-toolbox-window-close');
    closeButton.type = 'button'; closeButton.title = '关闭设置'; closeButton.setAttribute('aria-label', '关闭设置'); closeButton.append(icon('fa-xmark'));
    header.append(brand, closeButton);
    const layout = make('div', 'st-toolbox-window-layout');
    const sidebar = make('aside', 'st-toolbox-window-sidebar');
    const nav = make('div', 'st-toolbox-window-nav');
    nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '设置分类'); nav.setAttribute('aria-orientation', 'vertical');
    sidebar.append(make('p', 'st-toolbox-window-nav-label', '功能设置'), nav, make('p', 'st-toolbox-window-sidebar-note', '专注对话，工具随行。'));
    const main = make('main', 'st-toolbox-window-main');
    layout.append(sidebar, main);
    const footer = make('footer', 'st-toolbox-window-footer', '各项修改沿用酒馆的保存机制；需刷新的选项会单独提示。');
    dialog.append(header, layout, footer);
    doc.body.append(dialog);
    let activeId = '', returnFocus = null, disposed = false, backdropDown = false;
    const entries = new Map();
    const media = doc.defaultView?.matchMedia?.('(max-width: 640px)');
    const updateOrientation = () => nav.setAttribute('aria-orientation', media?.matches ? 'horizontal' : 'vertical');
    updateOrientation(); media?.addEventListener?.('change', updateOrientation);

    function render(entry) {
        if (entry.rendered) return;
        entry.rendered = true;
        const fail = error => {
            if (disposed) return;
            console.error(`[st-toolbox] 设置小节渲染失败：${entry.feature.id}`, error);
            entry.content.replaceChildren(make('p', 'st-toolbox-help', '本节设置加载失败，请查看控制台。其他设置仍可使用。'));
            const retry = make('button', 'menu_button', '重新加载本节'); retry.type = 'button';
            retry.addEventListener('click', () => { entry.rendered = false; entry.content.replaceChildren(); render(entry); });
            entry.content.append(retry);
        };
        try { Promise.resolve(entry.feature.render(entry.content)).catch(fail); } catch (error) { fail(error); }
    }
    function select(id, focus = false) {
        const next = entries.get(id);
        if (!next || disposed) return;
        activeId = id;
        for (const [key, entry] of entries) {
            const selected = key === id;
            entry.button.setAttribute('aria-selected', String(selected));
            entry.button.tabIndex = selected ? 0 : -1;
            entry.panel.hidden = !selected;
        }
        render(next);
        // Notify retained feature panels on every activation, not only their first render.
        next.panel.dispatchEvent(new CustomEvent('st-toolbox:settings-visible', { bubbles: true }));
        if (focus) { next.button.focus({ preventScroll: true }); next.button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
    }
    function update(nextFeatures) {
        // Stable feature IDs: preserve DOM, event handlers and local drafts across remounts.
        for (const feature of nextFeatures) {
            if (entries.has(feature.id)) { entries.get(feature.id).feature = feature; continue; }
            const meta = META[feature.id] || { label: feature.title, icon: 'fa-sliders', description: feature.title };
            const button = make('button', 'st-toolbox-window-tab');
            button.type = 'button'; button.id = `st-toolbox-tab-${feature.id}`;
            button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `st-toolbox-page-${feature.id}`);
            button.setAttribute('aria-selected', 'false'); button.tabIndex = -1;
            button.append(icon(meta.icon), make('span', '', meta.label));
            const panel = make('section', 'st-toolbox-window-page'); panel.id = `st-toolbox-page-${feature.id}`;
            panel.hidden = true; panel.tabIndex = 0; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
            const heading = make('div', 'st-toolbox-window-page-heading');
            heading.append(make('h3', '', meta.label), make('p', '', meta.description));
            const content = make('div', 'st-toolbox-window-feature');
            panel.append(heading, content); nav.append(button); main.append(panel);
            entries.set(feature.id, { feature, button, panel, content, rendered: false });
            button.addEventListener('click', () => select(feature.id));
        }
        if (!activeId) activeId = nextFeatures[0]?.id || '';
        if (dialog.open) select(activeId);
    }
    function open(opener) {
        if (disposed) return;
        if (!dialog.open) {
            returnFocus = opener || doc.activeElement;
            if (typeof dialog.showModal !== 'function') {
                console.warn('[st-toolbox] 当前浏览器不支持设置窗口，请升级浏览器。');
                return;
            }
            dialog.showModal();
        }
        select(activeId, true);
    }
    function restoreFocus() {
        // A queued close event from an earlier opening must not steal focus from a reopened dialog.
        if (!dialog.open && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }
    function close() {
        if (dialog.open) { dialog.close(); restoreFocus(); }
    }
    closeButton.addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', restoreFocus);
    // Only a pointer beginning AND ending on the backdrop closes the window.
    dialog.addEventListener('pointerdown', event => { backdropDown = event.target === dialog; });
    dialog.addEventListener('click', event => { if (event.target === dialog && backdropDown) close(); backdropDown = false; });
    nav.addEventListener('keydown', event => {
        const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
        if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); event.stopPropagation();
        const ids = [...entries.keys()]; let index = ids.indexOf(activeId);
        if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = ids.length - 1;
        else index = (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + ids.length) % ids.length;
        select(ids[index], true);
    });
    update(features);
    return { dialog, open, close, update, select, destroy() {
        close(); disposed = true; media?.removeEventListener?.('change', updateOrientation); dialog.remove(); entries.clear();
    } };
}

export function createSettingsLauncher(container, settingsWindow) {
    const doc = container.ownerDocument;
    const button = doc.createElement('button');
    button.id = 'st-toolbox-open-settings'; button.className = 'st-toolbox-settings-launcher'; button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'st-toolbox-settings-window');
    button.innerHTML = '<i class="fa-solid fa-sliders" aria-hidden="true"></i><span><strong>打开工具箱设置</strong><small>快捷回复 · 通知 · 截图 · 导出 · 优化</small></span><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>';
    button.addEventListener('click', () => settingsWindow.open(button));
    container.replaceChildren(button);
    return button;
}
