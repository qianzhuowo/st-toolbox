// Small conservative tokenizer for script tags in migration HTML, not a general HTML parser.
// Anchored token consumption prevents data-src / quoted attribute values from masquerading as src.
export function scriptAttributes(tag) {
    const opening = tag.match(/^<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i);
    if (!opening) throw Object.assign(new Error('无法安全识别 script 属性。'), { status: 409 });
    const text = opening[1], attributes = new Map();
    let offset = 0;
    while (offset < text.length) {
        if (!text.slice(offset).trim()) break;
        const token = text.slice(offset).match(/^\s+([^\s="'<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/);
        if (!token) throw Object.assign(new Error('无法安全识别 script 属性。'), { status: 409 });
        const name = token[1].toLowerCase();
        if (attributes.has(name)) throw Object.assign(new Error('重复 script 属性；拒绝猜测。'), { status: 409 });
        attributes.set(name, { value: token[2] ?? token[3] ?? token[4] ?? null, start: 7 + offset, end: 7 + offset + token[0].length });
        offset += token[0].length;
    }
    return attributes;
}
export function scriptAttribute(tag, name) { return scriptAttributes(tag).get(name)?.value; }
export function replaceScriptAttribute(tag, name, value) {
    const attribute = scriptAttributes(tag).get(name);
    if (!attribute) throw Object.assign(new Error('缺少可核对的 script 属性。'), { status: 409 });
    if (value !== null && /["'<>]/.test(value)) throw Object.assign(new Error('不安全的 script 属性。'), { status: 409 });
    return tag.slice(0, attribute.start) + (value === null ? '' : ` ${name}="${value}"`) + tag.slice(attribute.end);
}
