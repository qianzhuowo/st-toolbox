// Use native options-content > a styling rather than boxed extension menu buttons.
export function createNativeMenuItem({ document, id, icon, label, onClick }) {
    const entry = document.createElement('a');
    entry.id = id;
    entry.className = 'interactable';
    entry.tabIndex = 0;
    entry.setAttribute('role', 'button');
    entry.setAttribute('aria-label', label);
    const glyph = document.createElement('i');
    glyph.className = `fa-lg fa-solid ${icon}`;
    glyph.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = label;
    entry.append(glyph, text);
    entry.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !event.isComposing && event.keyCode !== 229
            && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) entry.click();
    });
    entry.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const options = document.getElementById('options');
        const toggle = document.getElementById('options_button');
        // script.js owns the visibility state and Popper instance; do not hide via CSS.
        if (options?.getClientRects().length) toggle?.click();
        toggle?.focus({ preventScroll: true });
        onClick();
    });
    return entry;
}
