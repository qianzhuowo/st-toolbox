import { scriptAttribute as attr, replaceScriptAttribute } from './html-script.js';
// Conservative offline HTML migration. Never infer a missing core module source.
const PREFIX = '/api/plugins/cocktail-plus/';
const MODULES = new Set(['/script.js', '/scripts/i18n.js', '/scripts/dynamic-styles.js', '/scripts/system-messages.js', '/scripts/extensions.js', '/scripts/welcome-screen.js']);
const error = () => Object.assign(new Error('旧入口结构无法安全识别；未修改 HTML。请对照备份手动恢复原生 script.js / i18n.js，或使用原插件工具。'), { status: 409 });
export function inspectLegacyHtml(html) {
    return { detected: html.includes(PREFIX) || /<!--\s*cocktail-plus early bridge/i.test(html), moduleDependency: html.includes(PREFIX + 'module'), recoveryRequired: html.includes(PREFIX + 'module') };
}
export function cleanLegacyHtml(html) {
    let out = html;
    const start = '<!-- cocktail-plus early bridge start -->', end = '<!-- cocktail-plus early bridge end -->';
    const starts = out.split(start).length - 1, ends = out.split(end).length - 1;
    if (starts !== ends || starts > 1 || starts && out.indexOf(start) > out.indexOf(end)) throw error();
    if (starts) {
        const a = out.indexOf(start), b = out.indexOf(end) + end.length;
        const block = out.slice(a + start.length, b - end.length);
        // Only recognized script tags are allowed inside a removable marker block.
        const remainder = block.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, tag => {
            const src = attr(tag, 'src'), id = attr(tag, 'id');
            if (src === PREFIX + 'early/bridge.js' && !tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</')).trim()) return '';
            if (id === 'cocktail-plus-module-import-map' && attr(tag, 'type') === 'importmap') {
                let map;
                try { map = JSON.parse(tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</'))); } catch { throw error(); }
                if (!map || Object.keys(map).some(k => k !== 'imports') || !map.imports) throw error();
                for (const [source, target] of Object.entries(map.imports)) {
                    if (!MODULES.has(source) || target !== PREFIX + 'module?path=' + encodeURIComponent(source)) throw error();
                }
                return '';
            }
            throw error();
        });
        if (remainder.trim()) throw error();
        out = out.slice(0, a) + out.slice(b);
    }
    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, tag => {
        const src = attr(tag, 'src');
        if (src === PREFIX + 'early/bridge.js' && !tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</')).trim()) return '';
        if (!src?.startsWith(PREFIX + 'module?')) return tag;
        const original = attr(tag, 'data-cp-module-proxy-original');
        const canonical = original?.startsWith('/') ? original : '/' + original;
        if (!MODULES.has(canonical) || src !== PREFIX + 'module?path=' + encodeURIComponent(canonical)) throw error();
        return replaceScriptAttribute(replaceScriptAttribute(tag, 'src', original), 'data-cp-module-proxy-original', null);
    });
    if (inspectLegacyHtml(out).detected) throw error();
    return out;
}
