export const SCREENSHOT_BUTTON_CLASS = 'st-toolbox-screenshot-button';
const selector = `.${SCREENSHOT_BUTTON_CLASS}`;

// Patch the live native template: cloned buttons work through delegation, not cloned listeners.
export function createMessageButtons({ document, isEnabled, getPlacement, onCapture, onRange }) {
    let installed = false;
    let press = null;
    let suppressedClick = null;

    function syncMessage(message) {
        const buttons = [...message.querySelectorAll(selector)];
        let button = buttons.shift();
        buttons.forEach(node => node.remove());
        if (!isEnabled()) { button?.remove(); return; }
        const container = message.querySelector('.mes_buttons');
        if (!container) return;
        const extra = container.querySelector(':scope > .extraMesButtons');
        const placement = getPlacement();
        if (!button) {
            button = document.createElement('div');
            button.className = `mes_button ${SCREENSHOT_BUTTON_CLASS} fa-solid fa-camera interactable`;
            button.title = '单击截图，长按选择相邻消息';
            button.setAttribute('role', 'button');
            button.setAttribute('aria-label', '截图');
            button.tabIndex = 0;
        }
        button.dataset.placement = placement;
        const host = placement === 'extra' && extra ? extra : container;
        if (button.parentElement !== host) host.insertBefore(button, host === container ? extra : null);
    }

    function target(event) {
        const button = event.target?.closest?.(selector);
        const message = button?.closest('#chat .mes');
        return isEnabled() && message ? { button, message } : null;
    }

    function cancelPress() {
        if (press) clearTimeout(press.timer);
        press = null;
    }

    function pointerDown(event) {
        const hit = target(event);
        if (!hit || event.button !== 0) return;
        cancelPress();
        suppressedClick = null;
        // Keep textarea focus/soft keyboard and chat scroll unchanged.
        event.preventDefault();
        hit.button.setPointerCapture?.(event.pointerId);
        const current = { ...hit, id: event.pointerId, x: event.clientX, y: event.clientY };
        press = current;
        current.timer = setTimeout(() => {
            if (press !== current) return;
            press = null;
            if (!isEnabled() || !current.message.isConnected) return;
            suppressedClick = current.button;
            onRange(current.button, current.message);
        }, 500);
    }

    function pointerMove(event) {
        if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
    }
    function pointerEnd(event) {
        if (press?.id === event.pointerId) cancelPress();
    }
    function activate(event) {
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        const hit = target(event);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown') {
            if (event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            cancelPress();
            suppressedClick = null;
        } else if (suppressedClick === hit.button) {
            suppressedClick = null;
            return;
        }
        onCapture(hit.message, hit.button);
    }

    const handlers = [
        ['pointerdown', pointerDown, false], ['pointermove', pointerMove, false],
        ['pointerup', pointerEnd, false], ['pointercancel', pointerEnd, false],
        ['lostpointercapture', pointerEnd, false], ['click', activate, false],
        // Own Enter before keyboard.js synthesizes a second click.
        ['keydown', activate, true],
    ];
    return {
        syncMessage,
        syncTemplate() { document.querySelectorAll('#message_template .mes').forEach(syncMessage); },
        install() {
            if (installed) return;
            installed = true;
            handlers.forEach(args => document.addEventListener(...args));
        },
        cancelPress,
        dispose() {
            cancelPress();
            suppressedClick = null;
            installed = false;
            handlers.forEach(args => document.removeEventListener(...args));
            document.querySelectorAll(`#message_template ${selector}, #chat ${selector}`).forEach(button => button.remove());
        },
    };
}
