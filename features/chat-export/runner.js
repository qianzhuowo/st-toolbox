import { packageResult, createProgressReporter } from './output.js';

const abortError = () => new DOMException('操作已取消', 'AbortError');

/** A disposable worker per explicit task: no idle worker or resident chat cache. */
export async function runExportTask(messages, options, { signal, onProgress } = {}) {
    if (signal?.aborted) throw abortError();
    if (typeof Worker === 'function') {
        try {
            return await runWorker(messages, options, signal, onProgress);
        } catch (error) {
            if (!error.workerUnavailable) throw error;
            console.info('[st-toolbox] 导出 Worker 不可用，改用分批处理。');
        }
    }
    if (signal?.aborted) throw abortError();
    const { processChat } = await import('./processor.js');
    const result = await processChat(messages, options, { signal, onProgress: createProgressReporter(onProgress) });
    if (signal?.aborted) throw abortError();
    return packageResult(result, options);
}

function runWorker(messages, options, signal, onProgress) {
    return new Promise((resolve, reject) => {
        let worker;
        let startupTimer;
        let started = false;
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(startupTimer);
            signal?.removeEventListener('abort', abort);
            worker?.terminate();
            if (error) reject(error);
            else resolve(result);
        };
        const abort = () => finish(abortError());
        const fail = message => {
            const error = new Error(message);
            // Only infrastructure/startup failures fall back. Data errors are not retried.
            error.workerUnavailable = !started;
            finish(error);
        };
        try {
            worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) return abort();
            startupTimer = setTimeout(() => fail('导出 Worker 启动超时'), 10000);
            worker.onmessage = ({ data }) => {
                if (settled) return;
                if (data.type === 'ready' && !started) {
                    clearTimeout(startupTimer);
                    try {
                        worker.postMessage({ messages, options });
                        started = true;
                    } catch (error) {
                        fail(error.message);
                    }
                } else if (data.type === 'progress') {
                    onProgress?.(data.progress);
                } else if (data.type === 'result') {
                    finish(null, data.result);
                } else if (data.type === 'error') {
                    finish(new Error(data.message));
                }
            };
            worker.onerror = event => {
                event.preventDefault();
                fail(event.message || '导出 Worker 执行失败');
            };
            worker.onmessageerror = () => fail('无法读取导出 Worker 的结果');
        } catch (error) {
            fail(error.message);
        }
    });
}
