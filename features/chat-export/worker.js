// Run CPU-heavy parsing away from the chat UI. No chat data leaves this browser.
import { processChat } from './processor.js';
import { packageResult, createProgressReporter } from './output.js';

self.addEventListener('message', async ({ data }) => {
    try {
        const result = await processChat(data.messages, data.options, {
            onProgress: createProgressReporter(progress => self.postMessage({ type: 'progress', progress })),
        });
        self.postMessage({ type: 'result', result: packageResult(result, data.options) });
    } catch (error) {
        self.postMessage({ type: 'error', message: error?.message || String(error) });
    }
});

self.postMessage({ type: 'ready' });
