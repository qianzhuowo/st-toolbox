// Pure chat export processing. No DOM, network, chat mutation, or arbitrary metadata.
// Limits are in UTF-16 code units. Candidate counts include pairs and self-closing tags.
const CHUNK_SIZE = 32 * 1024;
const MAX_SOURCE = 64 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024 * 1024;
const MAX_DEPTH = 4096;
const MAX_CANDIDATES = 200;
const MAX_NAMES = 128;
const MAX_NAME_LENGTH = 128;
const NAME_START = /^[\p{L}_:]$/u;
const NAME_CHAR = /^[\p{L}\p{M}\p{N}_.:\-]$/u;
const NAME = /^[\p{L}_:][\p{L}\p{M}\p{N}_.:\-]*$/u;
const REASONING_NAMES = ['think', 'thinking', 'reasoning', 'analysis'];

/** Parse inclusive, zero-based floors without expanding ranges. maxFloor may be -1 for an empty chat. */
export function parseFloorRanges(input, maxFloor) {
    if (!Number.isSafeInteger(maxFloor) || maxFloor < -1) throw new Error('Maximum floor must be an integer of at least -1.');
    if (input == null) input = '';
    if (typeof input !== 'string' || input.length > 65536) throw new Error('Floor selection must be text of at most 65536 characters.');
    const text = input.trim();
    if (!text || text === '*') return maxFloor < 0 ? [] : [[0, maxFloor]];
    // Empty comma fields are almost always a typo, unlike repeated whitespace.
    if (/^[,，]|[,，]$|[,，]\s*[,，]/u.test(text)) throw new Error('Invalid floor selection: empty comma-separated range.');
    const entries = text.split(/[,，\s]+/u);
    if (entries.length > 4096) throw new Error('Too many floor ranges; use at most 4096 ranges.');
    const ranges = entries.map(entry => {
        const match = /^(\d+)(?:-(\d+))?$/.exec(entry);
        if (!match) throw new Error(`Invalid floor range: ${entry.slice(0, 80)}. Use nonnegative integers or a-b.`);
        const start = Number(match[1]);
        const end = match[2] === undefined ? start : Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end > maxFloor) {
            throw new Error(`Floor range ${entry.slice(0, 80)} is reversed or outside 0-${maxFloor}.`);
        }
        return [start, end];
    });
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && range[0] - previous[1] <= 1) previous[1] = Math.max(previous[1], range[1]);
        else merged.push(range);
    }
    return merged;
}

/** Accept bare names or simple <name>/</name> forms, never attributes or regexes. */
export function parseTagNames(input) {
    if (input == null) input = '';
    if (typeof input !== 'string' || input.length > 65536) throw new Error('Tag selection must be text of at most 65536 characters.');
    if (!input.trim()) return [];
    const result = [];
    const seen = new Set();
    for (const token of input.trim().split(/[,，\s]+/u)) {
        if (!token) continue;
        const name = (token.startsWith('<') ? /^<\/?([^<>]+)>$/u.exec(token)?.[1] : token)?.toLowerCase();
        if (!name || name.length > MAX_NAME_LENGTH || !NAME.test(name)) {
            throw new Error(`Invalid tag name: ${token.slice(0, 80)}. Use names or simple <tag> / </tag>, without attributes or regex syntax.`);
        }
        if (!seen.has(name)) {
            if (seen.size === MAX_NAMES) throw new Error('Select at most 128 unique tag names.');
            seen.add(name);
            result.push(name);
        }
    }
    return result;
}

function optionNames(value, label) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_NAMES) throw new Error(`${label} must be an array of at most 128 tag names.`);
    return value.map(name => {
        if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH || !NAME.test(name)) throw new Error(`Invalid ${label}; pass validated bare tag names.`);
        const normalized = name.toLowerCase();
        if (normalized.length > MAX_NAME_LENGTH) throw new Error(`Invalid ${label}; tag names must be at most 128 characters.`);
        return normalized;
    });
}

function aborted(signal) {
    if (signal?.aborted) {
        const error = new Error('Chat export cancelled.');
        error.name = 'AbortError';
        throw error;
    }
}

// Each write is bounded; even JSON escaping or a long literal never creates one huge string.
class Chunks {
    constructor() {
        this.parts = [];
        this.tail = '';
        this.size = 0;
        this.work = 0;
    }
    *append(text, start = 0, end = text.length) {
        const length = end - start;
        if (this.size + length > MAX_OUTPUT) throw new Error('Export exceeds the 256 Mi-character output limit. Export fewer floors.');
        this.size += length;
        while (start < end) {
            const count = Math.min(CHUNK_SIZE - this.tail.length, end - start);
            this.tail += text.slice(start, start + count);
            start += count;
            this.work += count;
            if (this.tail.length === CHUNK_SIZE) {
                // Blob encodes each part separately: never split a UTF-16 surrogate
                // pair at a part boundary, including for plain TXT/Markdown output.
                const last = this.tail.charCodeAt(this.tail.length - 1);
                if (last >= 0xD800 && last <= 0xDBFF) {
                    this.parts.push(this.tail.slice(0, -1));
                    this.tail = this.tail.slice(-1);
                } else {
                    this.parts.push(this.tail);
                    this.tail = '';
                }
            }
            if (this.work >= CHUNK_SIZE) {
                this.work = 0;
                yield null;
            }
        }
    }
    finish() {
        if (this.tail) this.parts.push(this.tail);
        this.tail = '';
        return this.parts;
    }
}

/** A linear lexer. null is a scheduling checkpoint, not a token. */
function* tokens(text, work) {
    let i = 0;
    while (i < text.length) {
        if (++work.characters >= CHUNK_SIZE) { work.characters = 0; yield null; }
        if (text[i] !== '<') { i++; continue; }
        const start = i++;
        if (text.startsWith('!--', i)) {
            i += 3;
            while (i < text.length && !text.startsWith('-->', i)) {
                i++;
                if (++work.characters >= CHUNK_SIZE) { work.characters = 0; yield null; }
            }
            i = Math.min(text.length, i + 3);
            continue;
        }
        let closing = false;
        if (text[i] === '/') { closing = true; i++; }
        const first = String.fromCodePoint(text.codePointAt(i) ?? 0);
        if (!NAME_START.test(first)) continue;
        const nameStart = i;
        i += first.length;
        while (i < text.length) {
            const char = String.fromCodePoint(text.codePointAt(i));
            if (!NAME_CHAR.test(char)) break;
            i += char.length;
            if (++work.characters >= CHUNK_SIZE) { work.characters = 0; yield null; }
        }
        const nameEnd = i;
        let valid = nameEnd - nameStart <= MAX_NAME_LENGTH;
        if (i < text.length && !/[\s/>]/u.test(text[i])) valid = false;
        let quote = '';
        let lastNonspace = '';
        let hasClosingAttributes = false;
        let ended = false;
        while (i < text.length) {
            if (++work.characters >= CHUNK_SIZE) { work.characters = 0; yield null; }
            const char = text[i];
            if (quote) {
                if (char === quote) quote = '';
            } else if (char === '<') {
                // Retry this '<' as a new token, retaining malformed literal text.
                break;
            } else if (char === '>') {
                i++;
                ended = true;
                break;
            } else if (char === '"' || char === "'") {
                quote = char;
            }
            if (!/\s/u.test(char)) {
                lastNonspace = char;
                hasClosingAttributes = true;
            }
            i++;
        }
        if (!ended || !valid || (closing && hasClosingAttributes)) continue;
        const name = text.slice(nameStart, nameEnd).toLowerCase();
        if (name.length > MAX_NAME_LENGTH) continue;
        yield { start, end: i, name, closing, selfClosing: !closing && lastNonspace === '/' };
        if (++work.tokens >= 256) { work.tokens = 0; yield null; }
    }
}

function candidate(state, name) {
    if (state.candidates.has(name)) state.candidates.set(name, state.candidates.get(name) + 1);
    else if (state.candidates.size < MAX_CANDIDATES) state.candidates.set(name, 1);
    else state.candidatesTruncated = true;
}

/** Strip selected intervals while counting visible matched pairs; stack memory is bounded. */
function* scan(text, removals, reasoningRemovals, state, keepOutput) {
    const output = keepOutput ? new Chunks() : null;
    const stack = [];
    const latest = new Map();
    let hidden = 0;
    let hiddenReasoning = 0;
    let hiddenToEnd = false;
    let reasoningToEnd = false;
    let copyFrom = 0;
    for (const token of tokens(text, state.work)) {
        if (token === null) { yield null; continue; }
        const { name, start, end, closing, selfClosing } = token;
        if (!closing) {
            const reasoning = reasoningRemovals.has(name);
            const selected = reasoning || removals.has(name);
            const visibleCandidate = !reasoning && !hiddenReasoning && !reasoningToEnd;
            if (selfClosing) {
                if (visibleCandidate) candidate(state, name);
                if (selected && !hidden && !hiddenToEnd) {
                    if (output) yield* output.append(text, copyFrom, start);
                    copyFrom = end;
                }
                continue;
            }
            if (stack.length >= MAX_DEPTH) throw new Error('Tag nesting exceeds 4096 open tags. Reduce the selected floors or simplify malformed markup.');
            if (selected) {
                if (!hidden && !hiddenToEnd && output) yield* output.append(text, copyFrom, start);
                hidden++;
            }
            if (reasoning) hiddenReasoning++;
            stack.push({ name, selected, reasoning, visibleCandidate, previous: latest.get(name) });
            latest.set(name, stack.length - 1);
        } else {
            const match = latest.get(name);
            if (match === undefined) continue;
            const frame = stack[match];
            // Crossed markup is handled deterministically: intervening openings become
            // unmatched. A selected unmatched opening conservatively hides the rest.
            while (stack.length > match) {
                const popped = stack.pop();
                if (popped.previous === undefined) latest.delete(popped.name);
                else latest.set(popped.name, popped.previous);
                if (popped.selected) {
                    hidden--;
                    if (popped !== frame) { state.unclosedCount++; hiddenToEnd = true; }
                }
                if (popped.reasoning) {
                    hiddenReasoning--;
                    if (popped !== frame) reasoningToEnd = true;
                }
            }
            if (frame.visibleCandidate) candidate(state, name);
            if (frame.selected && !hidden && !hiddenToEnd) copyFrom = end;
        }
    }
    for (const frame of stack) if (frame.selected) state.unclosedCount++;
    if (output && !hidden && !hiddenToEnd) yield* output.append(text, copyFrom);
    return output ? output.finish() : [];
}

function* appendParts(output, parts) {
    let budget = 0;
    for (const part of parts) {
        yield* output.append(part);
        if (++budget >= 256) { budget = 0; yield null; }
    }
}

function* jsonString(output, parts) {
    yield* output.append('"');
    for (const part of parts) {
        for (let start = 0; start < part.length; start += CHUNK_SIZE) {
            const escaped = JSON.stringify(part.slice(start, start + CHUNK_SIZE));
            yield* output.append(escaped, 1, escaped.length - 1);
            yield null;
        }
    }
    yield* output.append('"');
}

const string = value => typeof value === 'string' ? value : '';

function* jsonHeader(output, header) {
    yield* output.append('{"user_name":');
    yield* jsonString(output, [string(header.user_name)]);
    yield* output.append(',"character_name":');
    yield* jsonString(output, [string(header.character_name)]);
    yield* output.append(',"chat_metadata":{}}\n');
}

function* serialize(output, message, floor, body, reasoning, options) {
    const name = string(message.name);
    if (options.format === 'jsonl') {
        yield* output.append('{"name":');
        yield* jsonString(output, [name]);
        yield* output.append(`,"is_user":${Boolean(message.is_user)},"is_system":${Boolean(message.is_system)},"send_date":`);
        if (typeof message.send_date === 'number' && Number.isFinite(message.send_date)) yield* output.append(JSON.stringify(message.send_date));
        else yield* jsonString(output, [string(message.send_date)]);
        yield* output.append(',"mes":');
        yield* jsonString(output, body);
        yield* output.append(',"extra":{');
        if (reasoning !== null) {
            yield* output.append('"reasoning":');
            yield* jsonString(output, reasoning);
            yield* output.append(',');
        }
        yield* output.append(`"st_toolbox_original_floor":${floor}}}\n`);
        return;
    }
    const speaker = name || (message.is_system ? 'System' : message.is_user ? options.header.user_name || 'User' : options.header.character_name || 'Character');
    yield* output.append(`${options.format === 'md' ? '## ' : ''}#${floor} `);
    yield* output.append(string(speaker));
    yield* output.append('\n\n');
    yield* appendParts(output, body);
    if (reasoning !== null) {
        yield* output.append(options.format === 'md' ? '\n\n**Reasoning**\n\n' : '\n\nReasoning:\n');
        yield* appendParts(output, reasoning);
    }
    yield* output.append('\n\n');
}

// Prefer task yielding without the browser's nested setTimeout minimum delay.
// A channel belongs to one operation and is closed even on cancellation/errors.
function defaultScheduler() {
    let channel;
    let resume;
    return {
        yieldControl: () => {
            if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield();
            if (typeof globalThis.MessageChannel !== 'function') return new Promise(resolve => setTimeout(resolve, 0));
            if (!channel) {
                channel = new globalThis.MessageChannel();
                channel.port1.onmessage = () => {
                    const done = resume;
                    resume = undefined;
                    done();
                };
            }
            return new Promise(resolve => { resume = resolve; channel.port2.postMessage(0); });
        },
        close: () => { channel?.port1.close(); channel?.port2.close(); },
    };
}

/**
 * Process current message bodies only. Original zero-based floors are retained.
 * Progress total is messages.length (filtered floors still advance processed).
 * Cancellation throws AbortError. yieldControl is called at bounded scanner/writer
 * checkpoints, including inside a single message; the default yields to the event loop.
 */
export async function processChat(messages, options = {}, runtime = {}) {
    if (runtime.yieldControl != null) {
        if (typeof runtime.yieldControl !== 'function') throw new Error('yieldControl must be a function.');
        return execute(messages, options, runtime);
    }
    const scheduler = defaultScheduler();
    try {
        return await execute(messages, options, { ...runtime, yieldControl: scheduler.yieldControl });
    } finally {
        scheduler.close();
    }
}

async function execute(messages, options, runtime) {
    if (!Array.isArray(messages)) throw new Error('Chat messages must be an array.');
    if (messages.length > 1000000) throw new Error('Chat exceeds one million messages. Export a smaller chat.');
    const action = options.action ?? 'export';
    const role = options.role ?? 'all';
    const format = options.format ?? 'txt';
    if (!['detect', 'export'].includes(action)) throw new Error('Action must be detect or export.');
    if (!['all', 'char', 'user'].includes(role)) throw new Error('Role must be all, char, or user.');
    if (!['txt', 'md', 'jsonl'].includes(format)) throw new Error('Format must be txt, md, or jsonl.');
    const ranges = parseFloorRanges(options.floors, messages.length - 1);
    const removals = new Set(optionNames(options.tags, 'tags'));
    if (action === 'detect') removals.clear();
    const customReasoning = optionNames(options.reasoningTags, 'reasoningTags');
    const reasoningRemovals = new Set(options.removeReasoning ? [...REASONING_NAMES, ...customReasoning] : []);
    const header = { user_name: string(options.header?.user_name), character_name: string(options.header?.character_name) };
    const signal = runtime.signal;
    const yieldControl = runtime.yieldControl;
    let processed = 0;
    const total = messages.length;
    const report = () => runtime.onProgress?.({ processed, total });
    const checkpoint = async () => {
        aborted(signal);
        report();
        await yieldControl();
        aborted(signal);
    };
    const run = async generator => {
        let next = generator.next();
        while (!next.done) {
            await checkpoint();
            next = generator.next();
        }
        aborted(signal);
        return next.value;
    };
    aborted(signal);
    report();
    let sourceSize = header.user_name.length + header.character_name.length;
    for (let floor = 0; floor < messages.length; floor++) {
        const message = messages[floor];
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(`Invalid message at floor ${floor}.`);
        sourceSize += string(message.mes).length + string(message.extra?.reasoning).length + string(message.name).length + string(message.send_date).length;
        if (sourceSize > MAX_SOURCE) throw new Error('Chat source exceeds the 64 Mi-character (about 128 MiB UTF-16) limit. Split the chat or export a smaller snapshot.');
        if ((floor + 1) % 256 === 0) await checkpoint();
    }
    if (sourceSize > MAX_SOURCE) throw new Error('Chat source exceeds the 64 Mi-character limit. Shorten the export header.');
    const output = new Chunks();
    const state = { candidates: new Map(), candidatesTruncated: false, unclosedCount: 0, work: { characters: 0, tokens: 0 } };
    if (action === 'export' && format === 'jsonl') await run(jsonHeader(output, header));
    let count = 0;
    let rangeIndex = 0;
    for (let floor = 0; floor < total; floor++) {
        const message = messages[floor];
        while (rangeIndex < ranges.length && ranges[rangeIndex][1] < floor) rangeIndex++;
        const inRange = rangeIndex < ranges.length && ranges[rangeIndex][0] <= floor;
        const isSystem = Boolean(message.is_system);
        const isUser = Boolean(message.is_user);
        const inRole = role === 'all' ? (!isSystem || Boolean(options.includeSystem)) : !isSystem && (role === 'user' ? isUser : !isUser);
        if (inRange && inRole) {
            const body = await run(scan(string(message.mes), removals, reasoningRemovals, state, action === 'export'));
            let reasoning = null;
            if (!options.removeReasoning && typeof message.extra?.reasoning === 'string') {
                reasoning = await run(scan(message.extra.reasoning, removals, reasoningRemovals, state, action === 'export'));
            }
            if (action === 'export') await run(serialize(output, message, floor, body, reasoning, { format, header }));
            count++;
        }
        processed = floor + 1;
        if (processed % 256 === 0) await checkpoint();
    }
    aborted(signal);
    report();
    return {
        parts: output.finish(),
        count,
        candidates: [...state.candidates].map(([name, occurrences]) => ({ name, count: occurrences })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        candidatesTruncated: state.candidatesTruncated,
        unclosedCount: state.unclosedCount,
    };
}
