// 截图打码：只修改 modern-screenshot 生成的克隆 DOM，绝不触碰页面上的真实消息。
export const REDACTION_MODES = Object.freeze(['mosaic', 'replace']);
export const MAX_REDACTION_RULES = 100;
export const MAX_REDACTION_TEXT = 200;
export const REDACTION_MARK_ATTRIBUTE = 'data-st-toolbox-redacted';

const SKIPPED_PARENTS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE']);

// 固定灰阶棋盘 + 错位叠加，模拟马赛克色块；不依赖原文字颜色（原文字会被设为透明）。
const MOSAIC_STYLE = [
    'color: transparent !important',
    '-webkit-text-fill-color: transparent !important',
    'text-shadow: none !important',
    'text-decoration: none !important',
    'background-color: #7d7d7d !important',
    'background-image: repeating-conic-gradient(rgba(255,255,255,0.18) 0 25%, rgba(0,0,0,0.18) 0 50%), repeating-conic-gradient(rgba(0,0,0,0.14) 0 25%, rgba(255,255,255,0.1) 0 50%) !important',
    'background-size: 0.5em 0.5em, 0.75em 0.75em !important',
    'background-position: 0 0, 0.2em 0.15em !important',
    'border-radius: 0.15em !important',
    '-webkit-box-decoration-break: clone',
    'box-decoration-break: clone',
].join('; ');

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeRedactionRule(rule) {
    const source = rule && typeof rule === 'object' ? rule : {};
    return {
        text: typeof source.text === 'string' ? source.text.slice(0, MAX_REDACTION_TEXT) : '',
        mode: REDACTION_MODES.includes(source.mode) ? source.mode : 'mosaic',
        replacement: typeof source.replacement === 'string' ? source.replacement.slice(0, MAX_REDACTION_TEXT) : '',
    };
}

export function normalizeRedactionSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        enabled: Boolean(source.enabled),
        ignoreCase: source.ignoreCase === undefined ? true : Boolean(source.ignoreCase),
        rules: Array.isArray(source.rules)
            ? source.rules.slice(0, MAX_REDACTION_RULES).map(normalizeRedactionRule)
            : [],
    };
}

// 与酒馆原生一致的名字宏，大小写不敏感：{{user}} / <USER> → 用户名；{{char}} / <BOT> / <CHAR> → 角色名。
const USER_MACRO = /\{\{user\}\}|<user>/gi;
const CHAR_MACRO = /\{\{char\}\}|<bot>|<char>/gi;

/**
 * 在截图时把规则文字里的宏展开为实际名字。群聊里 {{char}} 展开为每个成员各一条。
 * 宏对应的名字为空时丢弃该条，避免匹配到残缺文字。
 */
export function expandRedactionMacros(text, names = {}) {
    const hasUser = text.search(USER_MACRO) !== -1;
    const hasChar = text.search(CHAR_MACRO) !== -1;
    if (!hasUser && !hasChar) return [text];
    const user = String(names.user || '').trim();
    if (hasUser && !user) return [];
    const chars = hasChar ? (names.chars || []).map(name => String(name || '').trim()).filter(Boolean) : [''];
    return [...new Set(chars.map(char => text.replace(USER_MACRO, () => user).replace(CHAR_MACRO, () => char)))];
}

/** 编译为一次性匹配器；没有有效规则时返回 null。长文字优先，避免“张三丰”被“张三”截断。 */
export function compileRedaction(settings, names) {
    if (!settings?.enabled || !Array.isArray(settings.rules)) return null;
    const ignoreCase = Boolean(settings.ignoreCase);
    const keyOf = text => ignoreCase ? text.toLowerCase() : text;
    const byKey = new Map();
    for (const raw of settings.rules) {
        const rule = normalizeRedactionRule(raw);
        for (const expanded of expandRedactionMacros(rule.text.trim(), names)) {
            const text = expanded.trim();
            if (!text || byKey.has(keyOf(text))) continue;
            byKey.set(keyOf(text), Object.freeze({ text, mode: rule.mode, replacement: rule.replacement }));
        }
    }
    if (!byKey.size) return null;
    const texts = [...byKey.values()].map(rule => rule.text).sort((a, b) => b.length - a.length);
    const pattern = new RegExp(texts.map(escapeRegExp).join('|'), ignoreCase ? 'giu' : 'gu');
    return Object.freeze({ pattern, ruleFor: match => byKey.get(keyOf(match)) });
}

/** 把文本切分成普通片段与命中片段；无命中时返回 null。 */
export function splitRedactedText(text, compiled) {
    if (!compiled || !text) return null;
    const segments = [];
    let last = 0;
    compiled.pattern.lastIndex = 0;
    for (const match of text.matchAll(compiled.pattern)) {
        const rule = compiled.ruleFor(match[0]);
        if (!rule) continue;
        if (match.index > last) segments.push({ text: text.slice(last, match.index) });
        segments.push({ text: match[0], rule });
        last = match.index + match[0].length;
    }
    if (!segments.length) return null;
    if (last < text.length) segments.push({ text: text.slice(last) });
    return segments;
}

function createSegmentNode(document, segment) {
    if (!segment.rule) return document.createTextNode(segment.text);
    if (segment.rule.mode === 'replace') {
        // 替换为空字符串等于直接删除该文字。
        return document.createTextNode(segment.rule.replacement);
    }
    const span = document.createElement('span');
    span.setAttribute(REDACTION_MARK_ATTRIBUTE, '');
    span.setAttribute('style', MOSAIC_STYLE);
    span.textContent = segment.text;
    return span;
}

/** 就地处理克隆子树里的全部文本节点，返回命中次数。 */
export function applyRedaction(root, compiled) {
    if (!compiled || !root) return 0;
    const document = root.ownerDocument;
    const view = document?.defaultView;
    const showText = view?.NodeFilter?.SHOW_TEXT ?? 4;
    const walker = document.createTreeWalker(root, showText);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || SKIPPED_PARENTS.has(parent.tagName.toUpperCase()) || parent.hasAttribute(REDACTION_MARK_ATTRIBUTE)) continue;
        textNodes.push(node);
    }
    let hits = 0;
    for (const node of textNodes) {
        const segments = splitRedactedText(node.data, compiled);
        if (!segments) continue;
        const fragment = document.createDocumentFragment();
        for (const segment of segments) {
            if (segment.rule) hits += 1;
            fragment.appendChild(createSegmentNode(document, segment));
        }
        node.replaceWith(fragment);
    }
    return hits;
}
