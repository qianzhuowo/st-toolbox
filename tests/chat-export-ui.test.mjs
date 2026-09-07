import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTask } from 'node:timers/promises';

// Minimal UI doubles exercise the real feature's asynchronous lifecycle, not layout.
class Element {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.listeners = new Map();
        this.value = '';
        this.checked = false;
        this.textContent = '';
        this.dataset = {};
    }
    set innerHTML(html) {
        this.html = html;
        this.controls = [...html.matchAll(/data-ui="([^"]+)"/g)].map(match => {
            const node = new Element();
            node.dataset.ui = match[1];
            return node;
        });
    }
    get innerHTML() { return this.html; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; }
    querySelectorAll(selector) { return selector === '[data-ui]' ? this.controls : []; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, listener) {
        const listeners = this.listeners.get(name) || [];
        listeners.push(listener);
        this.listeners.set(name, listeners);
    }
    click() { for (const listener of this.listeners.get('click') || []) listener({ target: this }); }
    remove() {}
}

async function until(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await nextTask();
    }
    assert.fail('Expected asynchronous UI state was not reached');
}

async function fixture(t) {
    const originals = Object.fromEntries(['document', 'window', 'Worker', '__exportUiHost'].map(key => [key, globalThis[key]]));
    const menu = new Element();
    let popup;
    let generating = false;
    let worker;
    const handlers = new Map();
    const context = { chat: [{ mes: 'answer', name: 'char', extra: { reasoning: 'private' } }], chatId: 'test', characterId: 0, groupId: null, name1: 'User', name2: 'Char' };
    const settings = { chatExport: { enabled: true, role: 'all', format: 'txt', includeSystem: false, removeReasoning: false, tags: '' } };
    class Popup {
        constructor(root, _type, _value, options) {
            this.ui = Object.fromEntries(root.controls.map(node => [node.dataset.ui, node]));
            this.options = options;
            popup = this;
        }
        show() { return new Promise(resolve => { this.resolve = resolve; }); }
        close() { this.options.onClosing(); this.resolve(); }
    }
    globalThis.document = {
        getElementById(id) { return id === 'extensionsMenu' ? menu : null; },
        createElement(tag) { return new Element(tag); },
        createDocumentFragment() { return new Element(); },
        body: new Element('body'),
    };
    globalThis.window = { addEventListener() {} };
    globalThis.Worker = class {
        constructor() {
            worker = this;
            queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
        }
        postMessage() { this.started = true; }
        terminate() { this.terminated = true; }
    };
    globalThis.__exportUiHost = { getContext: () => context, Popup, POPUP_TYPE: { TEXT: 1 }, power_user: { reasoning: {} } };
    const url = new URL('../features/chat-export/index.js', import.meta.url);
    let source = await readFile(url, 'utf8');
    source = source
        .replace(/import \{ getContext \} from '[^']+';/, 'const { getContext } = globalThis.__exportUiHost;')
        .replace(/import \{ Popup, POPUP_TYPE \} from '[^']+';/, 'const { Popup, POPUP_TYPE } = globalThis.__exportUiHost;')
        .replace(/import \{ power_user \} from '[^']+';/, 'const { power_user } = globalThis.__exportUiHost;')
        .replace(/'\.\/([^']+)'/g, (_match, path) => `'${new URL(path, url).href}'`);
    source += `\n// fixture ${Math.random()}\n`;
    const { createChatExportFeature } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const eventNames = ['APP_READY', 'CHAT_CHANGED', 'GENERATION_STARTED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_FILE_EMBEDDED'];
    // Verify all test event names really exist in this SillyTavern version.
    const hostEvents = await readFile(new URL('../../../events.js', new URL('../', import.meta.url)), 'utf8');
    const eventTypes = Object.fromEntries(eventNames.map(name => {
        const match = new RegExp(`${name}: '([^']+)'`).exec(hostEvents);
        assert.ok(match, `Missing host event ${name}`);
        return [name, match[1]];
    }));
    const feature = createChatExportFeature({
        settings, saveSettings() {}, isGenerating: () => generating, eventTypes,
        eventSource: { on(event, listener) { handlers.set(event, listener); } },
    });
    feature.init();
    t.after(async () => {
        popup?.close();
        await nextTask();
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    });
    menu.children[0].children[0].click();
    await until(() => popup);
    return {
        get popup() { return popup; },
        get worker() { return worker; },
        context,
        setGenerating(value) { generating = value; },
        emit(name, ...args) { handlers.get(eventTypes[name])?.(...args); },
    };
}

test('floor input shows total and zero-based bounds, refreshing on message changes', async t => {
    const env = await fixture(t);
    assert.match(env.popup.ui.floorSummary.textContent, /当前共 1 楼，可填写编号：0–0/);
    env.context.chat.push({ mes: 'user', is_user: true }, { mes: 'system', is_system: true });
    env.emit('MESSAGE_SENT', 1);
    assert.match(env.popup.ui.floorSummary.textContent, /当前共 3 楼，可填写编号：0–2/);
    env.popup.ui.role.value = 'char';
    for (const listener of env.popup.ui.role.listeners.get('change')) listener();
    assert.match(env.popup.ui.floorSummary.textContent, /当前共 3 楼/);
    env.context.chat.pop();
    env.emit('MESSAGE_DELETED', 2);
    assert.match(env.popup.ui.floorSummary.textContent, /当前共 2 楼，可填写编号：0–1/);
    assert.equal(env.worker, undefined, 'Updating counts must not scan messages or start a worker');
});

test('floor summary handles a chat emptied while the dialog is open', async t => {
    const env = await fixture(t);
    env.context.chat.length = 0;
    env.emit('MESSAGE_DELETED', 0);
    assert.equal(env.popup.ui.floorSummary.textContent, '当前共 0 楼，暂无可导出的消息。');
});

test('reasoning edits and deletions abort an active export and reset detected candidates', async t => {
    for (const event of ['MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED']) {
        await t.test(event, async t => {
            const env = await fixture(t);
            env.popup.ui.export.click();
            await until(() => env.worker?.started);
            env.context.chat[0].extra.reasoning = '';
            env.emit(event, 0);
            await until(() => env.worker.terminated && !env.popup.ui.export.disabled);
            assert.match(env.popup.ui.status.textContent, /聊天内容已变化/);
            assert.match(env.popup.ui.candidates.textContent, /重新探测/);
        });
    }
});

test('chat switch aborts work and locks old floor controls until reopening', async t => {
    const env = await fixture(t);
    env.popup.ui.export.click();
    await until(() => env.worker?.started);
    env.context.chatId = 'other';
    env.emit('CHAT_CHANGED');
    await until(() => env.worker.terminated);
    assert.equal(env.popup.ui.export.disabled, true);
    assert.equal(env.popup.ui.fields.disabled, true);
    assert.match(env.popup.ui.status.textContent, /聊天已切换/);
});

test('closing dialog terminates pending worker; dry-run generation does not cancel', async t => {
    const env = await fixture(t);
    env.popup.ui.export.click();
    await until(() => env.worker?.started);
    env.emit('GENERATION_STARTED', 'normal', {}, true);
    assert.notEqual(env.worker.terminated, true);
    env.popup.close();
    await until(() => env.worker.terminated);
});

test('non-dry generation cancels an existing task', async t => {
    const env = await fixture(t);
    env.popup.ui.export.click();
    await until(() => env.worker?.started);
    env.emit('GENERATION_STARTED', 'normal', {}, false);
    await until(() => env.worker.terminated);
    assert.match(env.popup.ui.status.textContent, /任务已取消/);
});
