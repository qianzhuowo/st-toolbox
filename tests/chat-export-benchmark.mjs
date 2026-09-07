// Optional local benchmark. No files or network requests are produced.
// node tests/chat-export-benchmark.mjs
import { performance } from 'node:perf_hooks';
import { processChat } from '../features/chat-export/processor.js';

const Mi = 1024 * 1024;
async function benchmark(label, mes, options) {
    let yields = 0;
    let lastResume = performance.now();
    let maxSynchronousMs = 0;
    const start = lastResume;
    const result = await processChat([{ name: 'Benchmark', mes, is_user: false }], options, {
        yieldControl: () => {
            maxSynchronousMs = Math.max(maxSynchronousMs, performance.now() - lastResume);
            yields++;
            return new Promise(resolve => setImmediate(() => { lastResume = performance.now(); resolve(); }));
        },
    });
    maxSynchronousMs = Math.max(maxSynchronousMs, performance.now() - lastResume);
    console.log(JSON.stringify({ label, sourceMiChars: +(mes.length / Mi).toFixed(2), elapsedMs: +(performance.now() - start).toFixed(2), maxSynchronousMs: +maxSynchronousMs.toFixed(2), yields, outputParts: result.parts.length, candidateCount: result.candidates.length }));
}

for (const size of [1, 8, 32]) await benchmark(`plain-detect-${size}Mi`, 'x'.repeat(size * Mi), { action: 'detect' });
const markup = '<visible data="a > b">hello<drop><drop>secret</drop></drop><中文/>world</visible>\n';
await benchmark('dense-markup-jsonl-8Mi', markup.repeat(Math.floor(8 * Mi / markup.length)), { action: 'export', format: 'jsonl', tags: ['drop'] });
await benchmark('plain-jsonl-8Mi', 'abc😀\n'.repeat(Math.floor(8 * Mi / 6)), { action: 'export', format: 'jsonl' });
const start = performance.now();
let progressUpdates = 0;
const result = await processChat([{ name: 'Benchmark', mes: markup.repeat(Math.floor(8 * Mi / markup.length)), is_user: false }], { action: 'export', format: 'jsonl', tags: ['drop'] }, {
    onProgress: () => { progressUpdates++; },
});
console.log(JSON.stringify({ label: 'default-scheduler-dense-jsonl-8Mi', elapsedMs: +(performance.now() - start).toFixed(2), progressUpdates, outputParts: result.parts.length }));
