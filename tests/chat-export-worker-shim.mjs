// Adapt a real Node worker thread to the browser worker entry for integration tests.
import { parentPort, workerData } from 'node:worker_threads';

globalThis.self = {
    addEventListener(type, listener) {
        if (type === 'message') parentPort.on('message', data => listener({ data }));
    },
    postMessage(data) { parentPort.postMessage(data); },
};
await import(workerData.entry);
