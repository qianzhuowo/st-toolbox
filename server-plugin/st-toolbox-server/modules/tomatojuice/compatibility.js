/** Response-time compatibility patches. Never writes a SillyTavern core file. */
export function patchDynamicStyles(source) {
    const anchor = 'const isHover = selector.includes(\':hover\'), isFocus = selector.includes(\':focus\');';
    if (!source.includes(anchor)) {
        console.warn('[tomatojuice] dynamic-styles compatibility anchor changed; returning native source');
        return source;
    }
    return source.replace(anchor, `// Pseudo-elements such as scrollbar thumbs cannot receive keyboard focus.\n                    if (selector.includes('::')) return;\n                    ${anchor}`)
        .replace("const focusSelector = rule.selectorText.replace(/:hover/g, ':focus-visible');", "const focusSelector = baseSelector.replaceAll(PLACEHOLDER, ':focus-visible');");
}
export function filterExtensionManifestPaths(source) {
    // Hidden backup folders are not extensions. No bogus manifests, no catch-and-hide fetch errors.
    return source.replaceAll('extensions.map(x => x.name)', "extensions.filter(x => !String(x.name).split('/').some(part => part.startsWith('.'))).map(x => x.name)");
}
