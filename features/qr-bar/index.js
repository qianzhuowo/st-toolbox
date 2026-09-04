const BUTTON_ID = 'st-toolbox-qr-toggle';
const QR_BAR_ID = 'qr--bar';
const HIDDEN_CLASS = 'st-toolbox-qr-collapsed';

function getQrBar() {
    return document.querySelector('#send_form > #qr--bar');
}

export function createQrBarFeature({ eventSource, eventTypes, settings, saveSettings }) {
    const featureSettings = settings.qrBar;
    let observedForm = null;
    let observer = null;
    let animationFrame = 0;
    let enabledControl = null;
    let collapsedControl = null;

    function updateSettingsControls() {
        if (enabledControl) {
            enabledControl.checked = featureSettings.enabled;
        }
        if (collapsedControl) {
            collapsedControl.checked = featureSettings.collapsed;
            collapsedControl.disabled = !featureSettings.enabled;
        }
    }

    function updateButton(button) {
        const expanded = !featureSettings.collapsed;
        button.classList.toggle('fa-chevron-up', !expanded);
        button.classList.toggle('fa-chevron-down', expanded);
        button.title = expanded ? '收起 QR 栏' : '展开 QR 栏';
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-expanded', String(expanded));
    }

    function applyState() {
        const qrBar = getQrBar();
        const button = document.getElementById(BUTTON_ID);
        const shouldCollapse = featureSettings.enabled && featureSettings.collapsed;

        qrBar?.classList.toggle(HIDDEN_CLASS, shouldCollapse);

        if (button) {
            updateButton(button);
        }

        updateSettingsControls();
    }

    function toggleQrBar() {
        if (!featureSettings.enabled) {
            return;
        }

        featureSettings.collapsed = !featureSettings.collapsed;
        applyState();
        saveSettings();
    }

    function createButton() {
        const button = document.createElement('div');
        button.id = BUTTON_ID;
        button.className = 'fa-solid interactable';
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        button.setAttribute('aria-controls', QR_BAR_ID);

        button.addEventListener('click', toggleQrBar);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleQrBar();
            }
        });

        updateButton(button);
        return button;
    }

    function ensureButton() {
        const anchor = document.getElementById('extensionsMenuButton');
        const qrBar = getQrBar();
        let button = document.getElementById(BUTTON_ID);

        if (!featureSettings.enabled || !qrBar) {
            button?.remove();
            if (!featureSettings.enabled) {
                qrBar?.classList.remove(HIDDEN_CLASS);
            }
            updateSettingsControls();
            return;
        }

        if (!button && anchor) {
            button = createButton();
            anchor.insertAdjacentElement('afterend', button);
        } else if (button && anchor && button.parentElement !== anchor.parentElement) {
            anchor.insertAdjacentElement('afterend', button);
        }

        applyState();
    }

    function scheduleSync() {
        if (animationFrame) {
            return;
        }

        animationFrame = requestAnimationFrame(() => {
            animationFrame = 0;
            observeSendForm();
            ensureButton();
        });
    }

    function observeSendForm() {
        const sendForm = document.getElementById('send_form');
        if (sendForm === observedForm) {
            return;
        }

        observer?.disconnect();
        observer = null;
        observedForm = sendForm;

        if (!sendForm) {
            return;
        }

        observer = new MutationObserver(() => scheduleSync());
        observer.observe(sendForm, { childList: true, subtree: true });
    }

    function init() {
        eventSource.on(eventTypes.APP_READY, scheduleSync);
        eventSource.on(eventTypes.CHAT_CHANGED, scheduleSync);
        eventSource.on(eventTypes.SETTINGS_LOADED, scheduleSync);
        scheduleSync();
    }

    function renderSettings(container) {
        const section = document.createElement('section');
        section.className = 'st-toolbox-section';
        section.innerHTML = `
            <h4>QR 栏收起/展开</h4>
            <label class="checkbox_label">
                <input id="st-toolbox-qr-enabled" type="checkbox">
                <span>启用 QR 栏切换按钮</span>
            </label>
            <label class="checkbox_label">
                <input id="st-toolbox-qr-collapsed-setting" type="checkbox">
                <span>收起 QR 栏</span>
            </label>
            <p class="st-toolbox-help">收起状态会保存到 SillyTavern 设置中，刷新或切换聊天后仍会恢复。</p>
        `;

        enabledControl = section.querySelector('#st-toolbox-qr-enabled');
        collapsedControl = section.querySelector('#st-toolbox-qr-collapsed-setting');

        enabledControl.addEventListener('change', () => {
            featureSettings.enabled = enabledControl.checked;
            ensureButton();
            saveSettings();
        });

        collapsedControl.addEventListener('change', () => {
            featureSettings.collapsed = collapsedControl.checked;
            applyState();
            saveSettings();
        });

        updateSettingsControls();
        container.appendChild(section);
    }

    return { init, renderSettings };
}
