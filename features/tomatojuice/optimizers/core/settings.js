export function optimizerRoot(ctx) {
    const settings = ctx?.extensionSettings;
    if (!settings) return null;
    const toolbox = settings['st-toolbox'] ||= {};
    const tomatojuice = toolbox.tomatojuice ||= {};
    if (!tomatojuice.optimizers) {
        tomatojuice.optimizers = {};
        for (const [key, value] of Object.entries(settings)) {
            if (/^st-(startup|chat-render|chat-saving|preset|regex|ui-animation|worldinfo|html-render)/.test(key) && value && typeof value === 'object') tomatojuice.optimizers[key] = JSON.parse(JSON.stringify(value));
        }
    }
    return tomatojuice.optimizers;
}
