const MIME_TYPES = Object.freeze({
    txt: 'text/plain;charset=utf-8',
    md: 'text/markdown;charset=utf-8',
    jsonl: 'application/jsonl;charset=utf-8',
});

/** Build the Blob inside the worker, avoiding a second large text copy to the UI. */
export function packageResult(result, options) {
    if (options.action !== 'export') return result;
    const { parts, ...metadata } = result;
    return { ...metadata, blob: new Blob(parts, { type: MIME_TYPES[options.format] || MIME_TYPES.txt }) };
}

/** Avoid a progress message/DOM write at every lexer checkpoint. */
export function createProgressReporter(callback, now = () => performance.now()) {
    let lastTime = -Infinity;
    let lastProcessed = -1;
    let lastTotal = -1;
    return progress => {
        const { processed, total } = progress;
        if (processed === lastProcessed && total === lastTotal) return;
        const time = now();
        if (processed !== total && time - lastTime < 80) return;
        lastTime = time;
        lastProcessed = processed;
        lastTotal = total;
        callback?.(progress);
    };
}

export function buildFilename(chatName, role, format, date = new Date()) {
    const safeName = String(chatName || 'chat').slice(0, 80)
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
        .replace(/[.\s]+$/g, '') || 'chat';
    const safeRole = ['all', 'char', 'user'].includes(role) ? role : 'all';
    const extension = Object.hasOwn(MIME_TYPES, format) ? format : 'txt';
    const stamp = date.toISOString().replace(/[:.]/g, '-');
    return `chat-${safeName}-${safeRole}-${stamp}.${extension}`;
}
