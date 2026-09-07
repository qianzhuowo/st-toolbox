import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFloorRanges, parseTagNames, processChat } from '../features/chat-export/processor.js';

const fast = { yieldControl: async () => {} };
const message = (mes, fields = {}) => ({ name: 'Character', mes, is_user: false, is_system: false, send_date: '2026-01-01', ...fields });
const text = result => result.parts.join('');
const lines = result => text(result).trimEnd().split('\n').map(line => JSON.parse(line));
const json = async (messages, options = {}, runtime = fast) => processChat(messages, { format: 'jsonl', ...options }, runtime);
const body = async (mes, options = {}) => lines(await json([message(mes)], options))[1].mes;
function freeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

// Floor and tag input parsers.
test('floor ranges merge overlaps and adjacency without expansion', () => {
    assert.deepEqual(parseFloorRanges('8-10， 2, 4-6 3 5-7', 20), [[2, 10]]);
    assert.deepEqual(parseFloorRanges('0 3-4 9', 9), [[0, 0], [3, 4], [9, 9]]);
    assert.deepEqual(parseFloorRanges('0-9007199254740991', Number.MAX_SAFE_INTEGER), [[0, Number.MAX_SAFE_INTEGER]]);
    assert.deepEqual(parseFloorRanges('', 3), [[0, 3]]);
    assert.deepEqual(parseFloorRanges(' * ', 3), [[0, 3]]);
    assert.deepEqual(parseFloorRanges(undefined, -1), []);
});

test('floor parser rejects malformed, reversed, unsafe and out-of-bounds ranges', () => {
    for (const input of ['-1', '2-1', '5', '0-5', '1.5', '1e2', '1-', '1--2', '0 - 2', '*,1', '1,,2', ',1', '1,', '9007199254740992', '０']) {
        assert.throws(() => parseFloorRanges(input, 4), undefined, input);
    }
    assert.throws(() => parseFloorRanges('0', -1));
    assert.throws(() => parseFloorRanges('', -2));
    assert.throws(() => parseFloorRanges('', 1.5));
    assert.throws(() => parseFloorRanges(1, 2));
    assert.throws(() => parseFloorRanges('0 '.repeat(4097), 0), /4096/);
    assert.throws(() => parseFloorRanges(' '.repeat(65537), 0), /65536/);
});

test('tag parser normalizes, deduplicates and accepts Unicode and qualified names', () => {
    assert.deepEqual(parseTagNames('Think，<THINK> </thinking> 分析 工具:结果 foo-bar foo_bar foo.bar ÉTÉ'), ['think', 'thinking', '分析', '工具:结果', 'foo-bar', 'foo_bar', 'foo.bar', 'été']);
    assert.deepEqual(parseTagNames(''), []);
    assert.deepEqual(parseTagNames(undefined), []);
    assert.deepEqual(parseTagNames('<𐐀tag>'), ['𐐨tag']);
    assert.equal(parseTagNames('a'.repeat(128))[0].length, 128);
});

test('tag parser rejects attributes, regex syntax and excessive input', () => {
    for (const input of ['<tag foo="x">', '<tag/>', '< tag>', '<tag >', '<tag', '</tag extra>', '(think|analysis)', 'a*', 'a+b', '[tag]', 'tag?', '/tag/', '123', '<a></a>', 'a'.repeat(129)]) {
        assert.throws(() => parseTagNames(input), undefined, input);
    }
    assert.throws(() => parseTagNames(Array.from({ length: 129 }, (_, i) => `tag${i}`).join(',')), /128/);
    assert.throws(() => parseTagNames(' '.repeat(65537)), /65536/);
    assert.throws(() => parseTagNames(['think']));
});

// Role/floor filtering and minimal serialization.
test('all/char/user role filters respect system exclusion and original floors', async () => {
    const messages = [message('system', { is_system: true }), message('hello', { is_user: true }), message('reply'), message('user-system', { is_user: true, is_system: true }), message('last')];
    assert.deepEqual(lines(await json(messages)).slice(1).map(row => row.extra.st_toolbox_original_floor), [1, 2, 4]);
    assert.equal((await json(messages, { includeSystem: true })).count, 5);
    assert.deepEqual(lines(await json(messages, { role: 'char', includeSystem: true })).slice(1).map(row => row.extra.st_toolbox_original_floor), [2, 4]);
    assert.deepEqual(lines(await json(messages, { role: 'user', includeSystem: true })).slice(1).map(row => row.extra.st_toolbox_original_floor), [1]);
    assert.deepEqual(lines(await json(messages, { floors: '1-2，4', role: 'char' })).slice(1).map(row => row.extra.st_toolbox_original_floor), [2, 4]);
});

test('processing is deeply immutable and exports only current body and whitelisted metadata', async () => {
    const input = freeze([message('CURRENT <hide>remove</hide>', {
        name: 'A', is_user: true, send_date: 123,
        swipes: ['SECRET_SWIPE'], swipe_info: [{ mes: 'SECRET_SWIPE_INFO' }],
        arbitrary: 'SECRET_ARBITRARY',
        extra: { reasoning: 'VISIBLE_REASONING', secret: 'SECRET_EXTRA', apiKey: 'SECRET_KEY' },
    })]);
    const options = freeze({ format: 'jsonl', tags: ['hide'], header: { user_name: 'U', character_name: 'C', chat_metadata: { private: 'SECRET_HEADER' } } });
    const before = JSON.stringify(input);
    const result = await processChat(input, options, fast);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(lines(result), [
        { user_name: 'U', character_name: 'C', chat_metadata: {} },
        { name: 'A', is_user: true, is_system: false, send_date: 123, mes: 'CURRENT ', extra: { reasoning: 'VISIBLE_REASONING', st_toolbox_original_floor: 0 } },
    ]);
    assert.doesNotMatch(text(result), /SECRET/);
    for (const format of ['txt', 'md']) {
        const plain = await processChat(input, { ...options, format }, fast);
        assert.doesNotMatch(text(plain), /SECRET/);
        assert.equal(JSON.stringify(input), before);
    }
});

test('unrelated fields are not even read, and nonprimitive metadata is never serialized', async () => {
    const item = message('body', { name: { secret: 'NAME_SECRET' }, send_date: { secret: 'DATE_SECRET' }, extra: { reasoning: { secret: 'REASONING_SECRET' } } });
    for (const key of ['swipes', 'chat_metadata', 'arbitrary']) Object.defineProperty(item, key, { get() { throw new Error(`Read forbidden field: ${key}`); } });
    const row = lines(await json([item], { header: { user_name: { secret: 'HEADER_SECRET' }, character_name: 'C' } }))[1];
    assert.equal(row.name, '');
    assert.equal(row.send_date, '');
    assert.deepEqual(row.extra, { st_toolbox_original_floor: 0 });
});

test('empty, missing and cleaned-empty bodies retain messages and floors', async () => {
    const messages = [message(''), message('<drop>everything</drop>'), message(undefined), message(' ', { extra: { reasoning: '' } })];
    const result = await json(messages, { tags: ['drop'] });
    assert.equal(result.count, 4);
    const rows = lines(result).slice(1);
    assert.deepEqual(rows.map(row => row.mes), ['', '', '', ' ']);
    assert.deepEqual(rows.map(row => row.extra.st_toolbox_original_floor), [0, 1, 2, 3]);
    assert.equal(rows[3].extra.reasoning, '');
});

test('zero-result exports are empty text/markdown but retain a JSONL header', async () => {
    assert.deepEqual((await processChat([], {}, fast)).parts, []);
    assert.equal((await processChat([], { format: 'md' }, fast)).count, 0);
    assert.deepEqual(lines(await json([], { header: { user_name: 'U', character_name: 'C' } })), [{ user_name: 'U', character_name: 'C', chat_metadata: {} }]);
    const result = await json([message('x')], { role: 'user' });
    assert.equal(result.count, 0);
    assert.equal(lines(result).length, 1);
    assert.deepEqual((await processChat([], { action: 'detect', format: 'jsonl' }, fast)).parts, []);
});

test('TXT and Markdown show original floor, speaker, current body and optional reasoning', async () => {
    const messages = [message('skip'), message('visible', { name: 'Speaker', extra: { reasoning: 'because' } })];
    assert.equal(text(await processChat(messages, { floors: '1' }, fast)), '#1 Speaker\n\nvisible\n\nReasoning:\nbecause\n\n');
    assert.equal(text(await processChat(messages, { floors: '1', format: 'md' }, fast)), '## #1 Speaker\n\nvisible\n\n**Reasoning**\n\nbecause\n\n');
    assert.doesNotMatch(text(await processChat(messages, { floors: '1', removeReasoning: true }, fast)), /because|Reasoning/);
});

// Deterministic scanner edge cases.
test('same and different nested tags are removed with case-insensitive matching', async () => {
    assert.equal(await body('A<X>1<x>2</X>3</x>B', { tags: ['x'] }), 'AB');
    assert.equal(await body('A<outer>1<inner>2</inner>3</outer>B', { tags: ['outer'] }), 'AB');
    assert.equal(await body('A<outer>1<inner>2</inner>3</outer>B', { tags: ['inner'] }), 'A<outer>13</outer>B');
    assert.equal(await body('<x>a</x><x>b</x>tail', { tags: ['x'] }), 'tail');
});

test('quoted attributes containing >, multiline attributes and Unicode names work', async () => {
    assert.equal(await body('A<分析 data=\'a > b\'\n other="</分析><fake>">secret\nline</分析>B', { tags: ['分析'] }), 'AB');
    assert.equal(await body('A<工具:结果 a="x > y">secret</工具:结果>B', { tags: ['工具:结果'] }), 'AB');
    assert.equal(await body('A<𐐀tag>secret</𐐨tag>B', { tags: ['𐐨tag'] }), 'AB');
});

test('self-closing tags remove only themselves and count as occurrences', async () => {
    assert.equal(await body('A<drop/>B<drop data="x>y" />C', { tags: ['drop'] }), 'ABC');
    const result = await processChat([message('<x/><x a="b" /><x>one<x/>two</x>')], { action: 'detect' }, fast);
    assert.deepEqual(result.candidates, [{ name: 'x', count: 4 }]);
});

test('unclosed selected openings strip to the end and report each unmatched opening', async () => {
    const result = await json([message('A<drop>secret<drop>more')], { tags: ['drop'] });
    assert.equal(lines(result)[1].mes, 'A');
    assert.equal(result.unclosedCount, 2);
    assert.equal((await json([message('<keep>x')], { tags: ['drop'] })).unclosedCount, 0);
    assert.equal(await body('A</drop>B<keep>unfinished', { tags: ['drop'] }), 'A</drop>B<keep>unfinished');
});

test('crossed tags conservatively treat an intervening selected opening as unclosed', async () => {
    const result = await json([message('A<outer>B<drop>secret</outer>after</drop>tail')], { tags: ['drop'] });
    assert.equal(lines(result)[1].mes, 'A<outer>B');
    assert.equal(result.unclosedCount, 1);
});

test('unselected malformed markup is byte-for-byte unchanged', async () => {
    for (const input of ['A<x>unfinished', 'A<bad a="unterminated > B', 'A<bad!>B', 'A</bad attr> B', 'A<bad<other/>B', '<x '.repeat(100)]) {
        assert.equal(await body(input, { tags: ['drop'] }), input);
    }
});

test('escaped entities and HTML comments remain literal and do not create candidates', async () => {
    const input = '&lt;drop&gt;literal&lt;/drop&gt;<!-- <drop>comment</drop><fake/> -->visible';
    assert.equal(await body(input, { tags: ['drop'] }), input);
    assert.deepEqual((await processChat([message(input)], { action: 'detect' }, fast)).candidates, []);
    const incompleteComment = 'start<!-- <drop>unfinished';
    assert.equal(await body(incompleteComment, { tags: ['drop'] }), incompleteComment);
});

test('candidate scan includes nested paired occurrences in bodies and extra.reasoning, not alternate swipes', async () => {
    const result = await processChat([message('<A><b/><a>nested</A></a><unclosed>', {
        extra: { reasoning: '<A>reason</a><r/>' }, swipes: ['<secret>hidden</secret>'],
    })], { action: 'detect', tags: ['a'] }, fast);
    assert.deepEqual(result.parts, []);
    assert.equal(result.count, 1);
    assert.deepEqual(result.candidates, [{ name: 'a', count: 3 }, { name: 'b', count: 1 }, { name: 'r', count: 1 }]);
});

test('candidate detection respects floor and role selections', async () => {
    const result = await processChat([message('<system/>', { is_system: true }), message('<user/>', { is_user: true }), message('<character/>'), message('<outside/>')], { action: 'detect', role: 'char', floors: '0-2', includeSystem: true }, fast);
    assert.deepEqual(result.candidates, [{ name: 'character', count: 1 }]);
    assert.equal(result.count, 1);
});

test('candidate names are capped at 200, with a truncation flag and accurate retained counts', async () => {
    const input = Array.from({ length: 250 }, (_, i) => `<tag${i}/>`).join('') + '<tag0/>';
    const result = await processChat([message(input)], { action: 'detect' }, fast);
    assert.equal(result.candidates.length, 200);
    assert.equal(result.candidatesTruncated, true);
    assert.deepEqual(result.candidates[0], { name: 'tag0', count: 2 });
    assert.equal((await processChat([message('<x/>')], { action: 'detect' }, fast)).candidatesTruncated, false);
});

// Reasoning wrappers and preservation.
test('reasoning is preserved by default and stripped from body plus extra when requested', async () => {
    const input = '<think>a</think><THINKING>b</thinking><reasoning>c</reasoning><analysis>d</analysis><custom>e</custom>answer';
    const messages = [message(input, { extra: { reasoning: 'PRIVATE EXTRA' } })];
    const kept = lines(await json(messages))[1];
    assert.equal(kept.mes, input);
    assert.equal(kept.extra.reasoning, 'PRIVATE EXTRA');
    const removed = lines(await json(messages, { removeReasoning: true, reasoningTags: ['CUSTOM'] }))[1];
    assert.equal(removed.mes, 'answer');
    assert.deepEqual(removed.extra, { st_toolbox_original_floor: 0 });
});

test('reasoning removal hides its wrapper and descendants from candidate detection', async () => {
    const result = await processChat([message('<think><hidden/>secret</think><visible/>', { extra: { reasoning: '<extra/>' } })], { action: 'detect', removeReasoning: true }, fast);
    assert.deepEqual(result.candidates, [{ name: 'visible', count: 1 }]);
    const unclosed = await json([message('A<analysis>secret')], { removeReasoning: true });
    assert.equal(lines(unclosed)[1].mes, 'A');
    assert.equal(unclosed.unclosedCount, 1);
});

test('selected custom tags also clean retained extra.reasoning without dropping empty reasoning', async () => {
    const result = await json([message('body', { extra: { reasoning: '<private>reason</private>' } })], { tags: ['private'] });
    assert.equal(lines(result)[1].extra.reasoning, '');
});

// Bounded scheduling, memory and cancellation.
test('progress is monotonic, bounded and finishes at total even when floors are filtered', async () => {
    const updates = [];
    const result = await processChat(Array.from({ length: 600 }, () => message('<x/>')), { action: 'detect', floors: '0-10' }, { ...fast, onProgress: update => updates.push(update) });
    assert.equal(result.count, 11);
    assert.deepEqual(updates[0], { processed: 0, total: 600 });
    assert.deepEqual(updates.at(-1), { processed: 600, total: 600 });
    assert.ok(updates.length >= 4);
    for (let i = 0; i < updates.length; i++) {
        assert.equal(updates[i].total, 600);
        assert.ok(updates[i].processed >= (updates[i - 1]?.processed ?? 0));
        assert.ok(updates[i].processed <= 600);
    }
});

test('pre-aborted processing throws AbortError without doing work', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(processChat([message('body')], {}, { signal: controller.signal }), { name: 'AbortError' });
});

test('one huge message yields and supports cancellation before the message finishes', async () => {
    const controller = new AbortController();
    let yields = 0;
    const progress = [];
    await assert.rejects(processChat([message('x'.repeat(8 * 1024 * 1024))], { action: 'detect' }, {
        signal: controller.signal,
        onProgress: update => progress.push(update),
        yieldControl: async () => { if (++yields === 3) controller.abort(); },
    }), { name: 'AbortError' });
    assert.equal(yields, 3);
    assert.ok(progress.every(update => update.processed === 0));
});

test('default yielding allows timer cancellation during a single huge message', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);
    try {
        await assert.rejects(processChat([message('x'.repeat(4 * 1024 * 1024))], { action: 'detect' }, { signal: controller.signal }), { name: 'AbortError' });
    } finally { clearTimeout(timer); }
});

test('default scheduler completes large work and concurrent calls without keeping channels alive', async () => {
    const results = await Promise.all([
        processChat([message('x'.repeat(512 * 1024))], { action: 'detect' }),
        processChat([message('<x/>'.repeat(2000))], { action: 'detect' }),
    ]);
    assert.equal(results[0].count, 1);
    assert.deepEqual(results[1].candidates, [{ name: 'x', count: 2000 }]);
});

test('huge quoted attributes, comments and tag names each yield before finishing', async () => {
    for (const input of ['<x attr="' + '>'.repeat(1024 * 1024) + '">secret</x>', '<!--' + '<fake/>'.repeat(150000) + '-->', '<' + 'a'.repeat(1024 * 1024) + '>']) {
        const controller = new AbortController();
        let yields = 0;
        await assert.rejects(processChat([message(input)], { action: 'detect' }, {
            signal: controller.signal,
            yieldControl: async () => { yields++; controller.abort(); },
        }), { name: 'AbortError' });
        assert.equal(yields, 1);
    }
});

test('token and character budgets carry across short messages', async () => {
    let current = 0;
    let firstYieldFloor = null;
    await processChat(Array.from({ length: 20 }, () => message('x'.repeat(4096))), { action: 'detect' }, {
        onProgress: ({ processed }) => { current = processed; },
        yieldControl: async () => { firstYieldFloor ??= current; },
    });
    assert.ok(firstYieldFloor <= 8, `First character checkpoint at floor ${firstYieldFloor}`);
    firstYieldFloor = null;
    await processChat(Array.from({ length: 20 }, () => message('<x/>'.repeat(64))), { action: 'detect' }, {
        onProgress: ({ processed }) => { current = processed; },
        yieldControl: async () => { firstYieldFloor ??= current; },
    });
    assert.ok(firstYieldFloor <= 4, `First token checkpoint at floor ${firstYieldFloor}`);
});

test('large single-message JSONL is chunked, cancellable while writing and lossless for escapes and surrogates', async () => {
    const input = 'x'.repeat(32767) + '😀' + '\n\t"\\\u0000\ud800𐐀'.repeat(150000);
    let yields = 0;
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    const result = await json([message(input)], {}, { yieldControl: () => new Promise(resolve => setImmediate(() => { yields++; resolve(); })) });
    clearTimeout(timer);
    assert.equal(lines(result)[1].mes, input);
    assert.ok(result.parts.length > 20);
    assert.ok(result.parts.every(part => part.length <= 32768));
    assert.ok(yields > 30);
    assert.equal(timerRan, true);
});

test('TXT/Markdown Blob parts preserve Unicode surrogate pairs at chunk boundaries', async () => {
    for (const format of ['txt', 'md']) {
        for (let offset = 0; offset < 20; offset++) {
            const input = 'x'.repeat(32740 + offset) + '😀𐐀'.repeat(10000);
            const result = await processChat([message(input)], { format }, fast);
            const combined = text(result);
            assert.equal(await new Blob(result.parts).text(), combined, `${format}, offset ${offset}`);
            assert.ok(combined.includes(input));
            assert.ok(result.parts.every(part => part.length <= 32768));
        }
    }
});

test('cancellation is checked while serializing a huge JSONL header', async () => {
    const controller = new AbortController();
    let yields = 0;
    await assert.rejects(json([], { header: { user_name: 'x'.repeat(1024 * 1024), character_name: 'C' } }, {
        signal: controller.signal,
        yieldControl: async () => { yields++; controller.abort(); },
    }), { name: 'AbortError' });
    assert.equal(yields, 1);
});

test('bounded stack and source limits give actionable errors', async () => {
    await assert.rejects(processChat([message('<x>'.repeat(4097))], { action: 'detect' }, fast), /nesting exceeds 4096/);
    await assert.rejects(processChat([message('x'.repeat(64 * 1024 * 1024 + 1))], {}, fast), /64 Mi-character.*Split/);
    await assert.rejects(processChat(new Array(1000001), {}, fast), /one million/);
});

test('invalid option arrays and unsupported actions/formats/roles fail clearly', async () => {
    for (const options of [{ action: 'delete' }, { role: 'system' }, { format: 'html' }, { tags: ['<x>'] }, { tags: 'x' }, { reasoningTags: ['x.*'] }, { tags: Array(129).fill('x') }]) {
        await assert.rejects(processChat([message('x')], options, fast));
    }
    await assert.rejects(processChat(null));
    await assert.rejects(processChat([null]));
    await assert.rejects(processChat([[]]));
    await assert.rejects(processChat([], {}, { yieldControl: true }), /yieldControl/);
});
