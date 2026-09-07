import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFile, access } from 'node:fs/promises';
import { snapshotChat } from '../features/chat-export/snapshot.js';
import { runExportTask } from '../features/chat-export/runner.js';
import { packageResult, buildFilename, createProgressReporter } from '../features/chat-export/output.js';

const base = { action: 'export', role: 'all', floors: '', format: 'jsonl', tags: ['status'], removeReasoning: true };
const chat = [
    { name: '角色', mes: 'hello<status>secret</status>', is_user: false, extra: { reasoning: 'hidden', unknown: 'secret' }, swipes: ['old secret'], swipe_info: [{ extra: { reasoning: 'old' } }] },
    { name: '用户', mes: 'hi', is_user: true, send_date: 1234 },
    { name: 'system', mes: 'system secret', is_user: false, is_system: true },
];

test('snapshot retains original floors but does not access unselected text or copy hidden fields', async () => {
    const source = structuredClone(chat);
    Object.defineProperty(source[1], 'mes', { get() { throw new Error('Must not read unselected text'); } });
    const snapshot = await snapshotChat(source, { ...base, role: 'char' });
    assert.equal(snapshot.length, 3);
    assert.equal(snapshot[0].mes, chat[0].mes);
    assert.deepEqual(snapshot[0].extra, {});
    assert.equal(snapshot[0].swipes, undefined);
    assert.equal(snapshot[0].swipe_info, undefined);
    assert.equal(snapshot[1].mes, '');
    assert.equal(snapshot[2].mes, '');
    source[0].mes = 'edited';
    assert.equal(snapshot[0].mes, chat[0].mes);
});

test('snapshot range selection and reasoning preservation use minimal immutable fields', async () => {
    const snapshot = await snapshotChat(chat, { ...base, floors: '1', removeReasoning: false });
    assert.equal(snapshot[0].mes, '');
    assert.equal(snapshot[1].mes, 'hi');
    assert.equal(snapshot[1].send_date, 1234);
    const withReasoning = await snapshotChat(chat, { ...base, floors: '0', removeReasoning: false });
    assert.deepEqual(withReasoning[0].extra, { reasoning: 'hidden' });
    assert.notEqual(withReasoning[0].extra, chat[0].extra);
});

test('snapshot rejects invalid ranges, cancellation, oversized counts and stale chat', async () => {
    await assert.rejects(snapshotChat(chat, { ...base, floors: '3' }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(snapshotChat(chat, base, { signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(snapshotChat(chat, base, { isCurrent: () => false }), /聊天已变化/);
    await assert.rejects(snapshotChat(new Array(200001), base), /20 万楼/);
    let checks = 0;
    await assert.rejects(snapshotChat(Array(300).fill(chat[0]), base, { isCurrent: () => ++checks === 1 }), /聊天已变化/);
});

test('snapshot bounds metadata before sending it to the worker', async () => {
    await assert.rejects(snapshotChat([{ mes: 'ok', send_date: 'x'.repeat(257) }], base), /时间字段异常/);
    const safe = await snapshotChat([{ mes: 'ok', send_date: '2026-01-02T03:04:05Z' }], base);
    assert.equal(safe[0].send_date, '2026-01-02T03:04:05Z');
    await assert.rejects(snapshotChat([], { ...base, header: { user_name: 'x'.repeat(64 * 1024 * 1024 + 1) } }), /64M/);
});

test('progress reporting throttles duplicate/frequent values but always delivers completion', () => {
    let now = 0;
    const values = [];
    const report = createProgressReporter(value => values.push(value.processed), () => now);
    report({ processed: 0, total: 100 });
    for (let i = 1; i < 20; i++) report({ processed: i, total: 100 });
    now = 81;
    report({ processed: 20, total: 100 });
    report({ processed: 20, total: 100 });
    report({ processed: 100, total: 100 });
    assert.deepEqual(values, [0, 20, 100]);
});

test('output Blob packaging is lossless and filenames are safe', async () => {
    const result = packageResult({ parts: ['汉字😀', '\n'], count: 1 }, { action: 'export', format: 'txt' });
    assert.equal(await result.blob.text(), '汉字😀\n');
    assert.equal(result.parts, undefined);
    assert.equal(result.blob.type, 'text/plain;charset=utf-8');
    const detected = { candidates: [], parts: [] };
    assert.equal(packageResult(detected, { action: 'detect' }), detected);
    const filename = buildFilename('../CON:<evil>\r\n?', 'char', 'jsonl', new Date('2026-01-02T03:04:05Z'));
    assert.doesNotMatch(filename, /[<>:"/\\|?*\u0000-\u001f]/);
    assert.ok(filename.endsWith('.jsonl'));
    assert.ok(buildFilename('', 'invalid', '../exe').endsWith('.txt'));
});

// Tests below patch the Worker API, so run them serially within this file.
test('runner falls back when Worker is absent or blocked, with privacy preserved', async () => {
    for (const implementation of [undefined, class { constructor() { throw new Error('CSP blocked'); } }]) {
        const old = globalThis.Worker;
        globalThis.Worker = implementation;
        try {
            const snapshot = await snapshotChat(chat, base);
            const result = await runExportTask(snapshot, base);
            const text = await result.blob.text();
            const lines = text.trim().split('\n').map(JSON.parse);
            assert.equal(result.count, 2);
            assert.equal(lines.length, 3);
            assert.equal(lines[1].mes, 'hello');
            assert.equal(lines[2].extra.st_toolbox_original_floor, 1);
            assert.doesNotMatch(text, /secret|hidden|swipes|unknown/);
        } finally { globalThis.Worker = old; }
    }
});

class BrowserWorker {
    static terminated = 0;
    constructor(url) {
        this.worker = new NodeWorker(new URL('./chat-export-worker-shim.mjs', import.meta.url), { workerData: { entry: url.href } });
        this.worker.on('message', data => this.onmessage?.({ data }));
        this.worker.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
    }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { BrowserWorker.terminated++; void this.worker.terminate(); }
}

test('real worker handshake, progress, result Blob cloning and termination', async () => {
    const old = globalThis.Worker;
    globalThis.Worker = BrowserWorker;
    const before = BrowserWorker.terminated;
    try {
        const progress = [];
        const snapshot = await snapshotChat(chat, base);
        const result = await runExportTask(snapshot, base, { onProgress: value => progress.push(value) });
        assert.equal(result.count, 2);
        assert.ok(result.blob instanceof Blob);
        assert.equal(JSON.parse((await result.blob.text()).split('\n')[1]).mes, 'hello');
        assert.ok(progress.length >= 1);
        assert.equal(progress.at(-1).processed, chat.length);
        assert.equal(BrowserWorker.terminated, before + 1);
        const detected = await runExportTask(snapshot, { ...base, action: 'detect' });
        assert.deepEqual(detected.candidates, [{ name: 'status', count: 1 }]);
        assert.equal(detected.blob, undefined);
    } finally { globalThis.Worker = old; }
});

test('worker cancellation terminates the worker during processing', async () => {
    const old = globalThis.Worker;
    globalThis.Worker = BrowserWorker;
    const before = BrowserWorker.terminated;
    const controller = new AbortController();
    try {
        await assert.rejects(runExportTask([{ name: 'large', mes: 'x'.repeat(1024 * 1024) }], base, {
            signal: controller.signal,
            onProgress() { controller.abort(); },
        }), { name: 'AbortError' });
        assert.equal(BrowserWorker.terminated, before + 1);
    } finally { globalThis.Worker = old; }
});

test('worker startup cancellation is immediate and data errors are not retried', async () => {
    const old = globalThis.Worker;
    let terminated = false;
    globalThis.Worker = class { terminate() { terminated = true; } };
    const controller = new AbortController();
    try {
        const task = runExportTask(chat, base, { signal: controller.signal });
        controller.abort();
        await assert.rejects(task, { name: 'AbortError' });
        assert.equal(terminated, true);
        globalThis.Worker = BrowserWorker;
        const before = BrowserWorker.terminated;
        await assert.rejects(runExportTask(chat, { ...base, role: 'wrong' }), /Role/);
        assert.equal(BrowserWorker.terminated, before + 1);
    } finally { globalThis.Worker = old; }
});

test('new module relative imports resolve to real files, including host scripts', async () => {
    for (const path of ['../index.js', '../core/settings.js', ...['index', 'runner', 'snapshot', 'worker', 'output', 'processor'].map(name => `../features/chat-export/${name}.js`)]) {
        const url = new URL(path, import.meta.url);
        const source = await readFile(url, 'utf8');
        for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
            await access(new URL(match[1], url));
        }
    }
});

test('settings migration adds export defaults without overwriting existing features', async () => {
    const source = await readFile(new URL('../core/settings.js', import.meta.url), 'utf8');
    let saves = 0;
    const fixture = {
        'st-toolbox': { version: 2, qrBar: { enabled: false, collapsed: true }, ui: { sections: { screenshot: true } }, screenshot: { format: 'webp' } },
    };
    globalThis.__chatExportTestSettings = fixture;
    globalThis.__chatExportTestSave = () => saves++;
    try {
        const rewritten = source
            .replace(/import \{ saveSettingsDebounced \} from '[^']+';/, 'const saveSettingsDebounced = globalThis.__chatExportTestSave;')
            .replace(/import \{ extension_settings \} from '[^']+';/, 'const extension_settings = globalThis.__chatExportTestSettings;');
        const module = await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`);
        const settings = module.ensureSettings();
        assert.equal(settings.version, 3);
        assert.equal(settings.qrBar.enabled, false);
        assert.equal(settings.qrBar.collapsed, true);
        assert.equal(settings.screenshot.format, 'webp');
        assert.equal(settings.ui.sections.screenshot, true);
        assert.equal(settings.ui.sections['chat-export'], false);
        assert.deepEqual(settings.chatExport, { enabled: true, role: 'all', format: 'txt', includeSystem: false, removeReasoning: true, tags: '' });
        settings.chatExport.role = 'bad';
        settings.chatExport.tags = 'x'.repeat(40000);
        module.ensureSettings();
        assert.equal(settings.chatExport.role, 'all');
        assert.equal(settings.chatExport.tags.length, 32768);
        assert.ok(saves >= 1);
    } finally {
        delete globalThis.__chatExportTestSettings;
        delete globalThis.__chatExportTestSave;
    }
});
