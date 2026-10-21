const DB_NAME = 'st-toolbox';
const DB_VERSION = 1;
const AUDIO_STORE = 'notification-audio';
const CUSTOM_PREFIX = 'custom:';
const LEG_CHECK_INTERVAL = 500;
const FAILURE_IDLE_GRACE = 3000;
const SUCCESS_IDLE_GRACE = 3000;
const FAILURE_SETTLE_DELAY = 300;
const PLAY_COOLDOWN = 1200;
const MAX_CUSTOM_AUDIO_FILES = 30;

const BUILTIN_SOUNDS = {
    success: {
        value: 'builtin:success',
        label: '内置：回复完成',
        url: '/scripts/extensions/third-party/st-toolbox/features/notifications/audio/success.mp3',
    },
    error: {
        value: 'builtin:error',
        label: '内置：生成错误',
        url: '/scripts/extensions/third-party/st-toolbox/features/notifications/audio/error.mp3',
    },
};

const IGNORED_GENERATION_TYPES = new Set(['quiet', 'impersonate']);
const IGNORED_MESSAGE_TYPES = new Set(['first_message', 'command', 'extension']);
const ICON_BASE_PATH = '/scripts/extensions/third-party/st-toolbox/features/notifications/icons';
const BUILTIN_FLASH_ICONS = [`${ICON_BASE_PATH}/flash-1.ico`, `${ICON_BASE_PATH}/flash-2.ico`];
const FLASH_ICON_SIZE = 64;
const FLASH_ICON_MAX_BYTES = 96 * 1024;
const FLASH_ICON_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** 读取页面当前的 favicon <link>（没有则创建）。 */
function getFaviconLink(create = false) {
    let link = document.querySelector("link[rel='icon']") || document.querySelector("link[rel='shortcut icon']");
    if (!link && create) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    return link;
}

function setFavicon(href) {
    const link = getFaviconLink(true);
    if (!link) return;
    // 非 data URL 加上 cache buster，否则部分浏览器在同一地址往返时不会重绘标签页图标。
    link.href = href.startsWith('data:') ? href : `${href}${href.includes('?') ? '&' : '?'}v=${Date.now()}`;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取文件失败。'));
        reader.readAsDataURL(file);
    });
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('图片无法解码。'));
        image.src = src;
    });
}

/**
 * 把用户上传的图片归一化为 64×64 的 PNG data URL，保证体积小、可直接存进设置。
 * 浏览器无法解码（如某些 ICO）时，若原文件足够小则直接使用原始 data URL。
 */
async function normalizeFlashIcon(file) {
    const rawDataUrl = await readFileAsDataUrl(file);
    try {
        const image = await loadImageElement(rawDataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = FLASH_ICON_SIZE;
        canvas.height = FLASH_ICON_SIZE;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建 Canvas。');
        const width = image.naturalWidth || FLASH_ICON_SIZE;
        const height = image.naturalHeight || FLASH_ICON_SIZE;
        const ratio = Math.min(FLASH_ICON_SIZE / width, FLASH_ICON_SIZE / height);
        const drawWidth = Math.max(1, Math.round(width * ratio));
        const drawHeight = Math.max(1, Math.round(height * ratio));
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, (FLASH_ICON_SIZE - drawWidth) / 2, (FLASH_ICON_SIZE - drawHeight) / 2, drawWidth, drawHeight);
        const normalized = canvas.toDataURL('image/png');
        canvas.width = 1;
        canvas.height = 1;
        if (normalized.length <= FLASH_ICON_MAX_BYTES) return normalized;
    } catch (error) {
        console.debug('[st-toolbox] 图标无法用 Canvas 归一化，尝试直接使用原文件：', error);
    }
    if (rawDataUrl.startsWith('data:image/') && rawDataUrl.length <= FLASH_ICON_MAX_BYTES) return rawDataUrl;
    throw new Error('图标处理后仍超过 96 KB，请换一张更小的图片。');
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionToPromise(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
}

function createId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `audio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isUnfocused() {
    return document.hidden || !document.hasFocus();
}

function showToast(level, message) {
    const method = globalThis.toastr?.[level];
    if (typeof method === 'function') {
        method.call(globalThis.toastr, message, 'ST Toolbox');
    }
}

export function createNotificationsFeature({ eventSource, eventTypes, settings, saveSettings, isGenerating }) {
    const featureSettings = settings.notifications;
    const customAudios = { success: [], error: [] };
    let databasePromise = null;
    let database = null;
    let indexedDbAvailable = true;
    let currentPlayback = null;
    let playRequestId = 0;
    let lastAutomaticPlay = 0;
    let flashTimer = 0;
    let titleBeforeFlash = '';
    let lastFlashedTitle = '';
    let faviconBeforeFlash = '';
    let lastFlashedFavicon = '';
    let nextSessionId = 0;
    let nextLegId = 0;
    let currentSession = null;
    let currentLeg = null;
    let activeGroup = null;
    let settleTimer = 0;
    const messageLegs = new Map();
    let controls = null;

    function openDatabase() {
        if (databasePromise) {
            return databasePromise;
        }

        if (!globalThis.indexedDB) {
            return Promise.reject(new Error('当前浏览器不支持 IndexedDB'));
        }

        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            let settled = false;
            const rejectOnce = error => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };

            request.onupgradeneeded = event => {
                const openedDatabase = event.target.result;
                if (!openedDatabase.objectStoreNames.contains(AUDIO_STORE)) {
                    openedDatabase.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => {
                const openedDatabase = request.result;
                if (settled) {
                    openedDatabase.close();
                    return;
                }
                settled = true;
                database = openedDatabase;
                openedDatabase.onversionchange = () => {
                    openedDatabase.close();
                    if (database === openedDatabase) {
                        database = null;
                        databasePromise = null;
                    }
                };
                resolve(openedDatabase);
            };
            request.onerror = () => rejectOnce(request.error);
            request.onblocked = () => rejectOnce(new Error('IndexedDB 被其它页面阻塞'));
        });

        databasePromise.catch(() => {
            if (!database) {
                databasePromise = null;
            }
        });
        return databasePromise;
    }

    async function loadCustomAudios() {
        const openedDatabase = await openDatabase();
        const transaction = openedDatabase.transaction(AUDIO_STORE, 'readonly');
        const completed = transactionToPromise(transaction);
        const metadataRequest = new Promise((resolve, reject) => {
            const records = [];
            const request = transaction.objectStore(AUDIO_STORE).openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(records);
                    return;
                }
                const record = cursor.value;
                if (record?.id && (record.kind === 'success' || record.kind === 'error') && record.blob instanceof Blob) {
                    records.push({
                        id: record.id,
                        kind: record.kind,
                        name: record.name,
                        mime: record.mime,
                        size: record.size,
                        createdAt: record.createdAt,
                    });
                }
                cursor.continue();
            };
        });
        const [metadata] = await Promise.all([metadataRequest, completed]);
        customAudios.success = metadata.filter(record => record.kind === 'success');
        customAudios.error = metadata.filter(record => record.kind === 'error');
    }

    async function getStoredAudio(id) {
        const openedDatabase = await openDatabase();
        const transaction = openedDatabase.transaction(AUDIO_STORE, 'readonly');
        const completed = transactionToPromise(transaction);
        const [record] = await Promise.all([
            requestToPromise(transaction.objectStore(AUDIO_STORE).get(id)),
            completed,
        ]);
        return record;
    }

    async function addCustomAudio(kind, file) {
        const openedDatabase = await openDatabase();
        const record = {
            id: createId(),
            kind,
            name: file.name || '自定义音频',
            mime: file.type || 'application/octet-stream',
            size: file.size,
            createdAt: Date.now(),
            blob: file,
        };
        const transaction = openedDatabase.transaction(AUDIO_STORE, 'readwrite');
        const completed = transactionToPromise(transaction);
        const store = transaction.objectStore(AUDIO_STORE);
        let count;
        try {
            count = await requestToPromise(store.count());
        } catch (error) {
            await completed.catch(() => undefined);
            throw error;
        }
        if (count >= MAX_CUSTOM_AUDIO_FILES) {
            transaction.abort();
            await completed.catch(() => undefined);
            throw new Error(`自定义音频最多保存 ${MAX_CUSTOM_AUDIO_FILES} 个，请先删除旧音频`);
        }
        store.put(record);
        await completed;
        await loadCustomAudios();
        return record;
    }

    async function deleteCustomAudio(id) {
        const openedDatabase = await openDatabase();
        const transaction = openedDatabase.transaction(AUDIO_STORE, 'readwrite');
        const completed = transactionToPromise(transaction);
        transaction.objectStore(AUDIO_STORE).delete(id);
        await completed;
        await loadCustomAudios();
    }

    function getCustomAudio(kind, value) {
        if (!value.startsWith(CUSTOM_PREFIX)) {
            return null;
        }
        const id = value.slice(CUSTOM_PREFIX.length);
        return customAudios[kind].find(record => record.id === id) || null;
    }

    function stopCurrentAudio(invalidatePending = true) {
        if (invalidatePending) {
            playRequestId += 1;
        }
        if (!currentPlayback) {
            return;
        }

        const playback = currentPlayback;
        currentPlayback = null;
        playback.audio.pause();
        playback.audio.removeAttribute('src');
        if (playback.objectUrl) {
            URL.revokeObjectURL(playback.objectUrl);
        }
    }

    async function resolveAudioSource(kind) {
        const value = kind === 'success' ? featureSettings.successSound : featureSettings.errorSound;
        const builtin = BUILTIN_SOUNDS[kind];

        if (!value) {
            return null;
        }
        if (value === builtin.value) {
            return { url: builtin.url, objectUrl: '' };
        }

        const custom = getCustomAudio(kind, value);
        if (!custom) {
            return null;
        }

        const stored = await getStoredAudio(custom.id);
        if (!(stored?.blob instanceof Blob)) {
            return null;
        }
        const objectUrl = URL.createObjectURL(stored.blob);
        return { url: objectUrl, objectUrl };
    }

    async function playSound(kind, force = false) {
        if (!force) {
            if (!featureSettings.enabled || !featureSettings.soundEnabled) {
                return;
            }
            if (featureSettings.onlyWhenUnfocused && !isUnfocused()) {
                return;
            }
            if (Date.now() - lastAutomaticPlay < PLAY_COOLDOWN) {
                return;
            }
        }

        const requestId = ++playRequestId;
        let source;
        try {
            source = await resolveAudioSource(kind);
        } catch (error) {
            if (requestId === playRequestId) {
                console.warn('[st-toolbox] 读取自定义提示音失败：', error);
                if (force) {
                    showToast('error', '读取自定义提示音失败，请重新选择或上传音频。');
                }
            }
            return;
        }
        if (requestId !== playRequestId) {
            if (source?.objectUrl) {
                URL.revokeObjectURL(source.objectUrl);
            }
            return;
        }
        if (!source) {
            if (force) {
                showToast('warning', '尚未选择可用的提示音。');
            }
            return;
        }

        if (!force) {
            lastAutomaticPlay = Date.now();
        }

        stopCurrentAudio(false);
        const audio = new Audio(source.url);
        audio.volume = featureSettings.volume;
        audio.preload = 'auto';
        const playback = { audio, objectUrl: source.objectUrl };
        currentPlayback = playback;

        const release = () => {
            if (currentPlayback !== playback) {
                return;
            }
            currentPlayback = null;
            if (playback.objectUrl) {
                URL.revokeObjectURL(playback.objectUrl);
            }
        };
        audio.addEventListener('ended', release, { once: true });
        audio.addEventListener('error', release, { once: true });

        try {
            await audio.play();
        } catch (error) {
            release();
            console.warn('[st-toolbox] 浏览器阻止或无法播放提示音：', error);
        }
    }

    function getFlashIcons() {
        // 自定义图标：自定义 ↔ 原始 favicon 交替；内置：两张默认图标交替（与 vertin-tips 一致）。
        if (featureSettings.flashIcon) {
            return [featureSettings.flashIcon, faviconBeforeFlash || getFaviconLink()?.href || '/favicon.ico'];
        }
        return BUILTIN_FLASH_ICONS;
    }

    function restoreFavicon() {
        if (!faviconBeforeFlash) return;
        const link = getFaviconLink();
        // 只在 favicon 仍是我们设置的那个时才恢复，避免覆盖其它插件的修改。
        if (link && (!lastFlashedFavicon || link.href === lastFlashedFavicon)) {
            link.href = faviconBeforeFlash;
        }
        faviconBeforeFlash = '';
        lastFlashedFavicon = '';
    }

    function stopFlashing() {
        if (!flashTimer) {
            return;
        }
        clearInterval(flashTimer);
        flashTimer = 0;
        if (document.title === lastFlashedTitle) {
            document.title = titleBeforeFlash;
        }
        titleBeforeFlash = '';
        lastFlashedTitle = '';
        restoreFavicon();
    }

    function startFlashing(kind) {
        if (!featureSettings.enabled || !featureSettings.flashEnabled || !isUnfocused()) {
            return;
        }

        stopFlashing();
        titleBeforeFlash = document.title;
        const useIcon = featureSettings.flashIconEnabled;
        if (useIcon) {
            faviconBeforeFlash = getFaviconLink()?.href || '/favicon.ico';
        }
        const icons = useIcon ? getFlashIcons() : null;
        const alertTitle = kind === 'success' ? '【回复完成】' : '【生成失败】';
        let showAlert = true;
        const updateTitle = () => {
            if (document.title !== lastFlashedTitle) {
                // 酒馆会在生成状态或聊天切换时更新标题；吸收新标题作为恢复目标，
                // 不要因此停止共享的闪烁定时器（否则 favicon 也会停止闪烁）。
                titleBeforeFlash = document.title;
            }
            lastFlashedTitle = showAlert ? alertTitle : titleBeforeFlash;
            document.title = lastFlashedTitle;
            if (icons) {
                setFavicon(icons[showAlert ? 0 : 1]);
                lastFlashedFavicon = getFaviconLink()?.href || '';
            }
            showAlert = !showAlert;
        };

        updateTitle();
        flashTimer = setInterval(updateTitle, 800);
    }

    function getContext() {
        try {
            return globalThis.SillyTavern?.getContext?.() || null;
        } catch {
            return null;
        }
    }

    function getChatId(context = getContext()) {
        return String(context?.chatId ?? 'unknown');
    }

    function safeIsGenerating() {
        try {
            return typeof isGenerating === 'function' && Boolean(isGenerating());
        } catch {
            return false;
        }
    }

    function clearSettleTimer() {
        if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = 0;
        }
    }

    function clearLegMonitor(leg) {
        if (leg?.monitorTimer) {
            clearTimeout(leg.monitorTimer);
            leg.monitorTimer = 0;
        }
    }

    function getMessageKey(chatId, messageId) {
        return `${chatId}:${String(messageId)}`;
    }

    function removeLegMessageKeys(leg) {
        for (const [key, value] of messageLegs.entries()) {
            if (value === leg) {
                messageLegs.delete(key);
            }
        }
    }

    function createSession(isGroup = false) {
        return {
            id: ++nextSessionId,
            isGroup,
            cancelled: false,
            notified: false,
            legs: [],
        };
    }

    function createLeg(session, type, memberToken = 0) {
        const context = getContext();
        const leg = {
            id: ++nextLegId,
            session,
            type: String(type || 'normal'),
            memberToken,
            chatId: getChatId(context),
            chatLength: Array.isArray(context?.chat) ? context.chat.length : 0,
            startedAt: Date.now(),
            active: true,
            status: 'pending',
            messageObserved: false,
            messageObservedAt: 0,
            messageId: null,
            streamFailed: false,
            idleSince: 0,
            settleIdleSince: 0,
            monitorTimer: 0,
        };
        session.legs.push(leg);
        return leg;
    }

    function finalizeSession(session, outcome) {
        if (!session || session.cancelled || session.notified || !outcome) {
            return;
        }

        clearSettleTimer();
        session.notified = true;
        for (const leg of session.legs) {
            clearLegMonitor(leg);
            removeLegMessageKeys(leg);
        }

        if (!featureSettings.enabled) {
            return;
        }
        if (featureSettings.soundEnabled) {
            void playSound(outcome);
        }
        if (featureSettings.flashEnabled) {
            startFlashing(outcome);
        }
    }

    function settleLegWhenIdle(session, leg, delay = 0) {
        clearSettleTimer();
        settleTimer = setTimeout(() => {
            settleTimer = 0;
            if (session !== currentSession || leg !== currentLeg || session.cancelled || session.notified) {
                return;
            }
            if (safeIsGenerating()) {
                leg.settleIdleSince = 0;
                settleLegWhenIdle(session, leg, 200);
                return;
            }
            if (leg.status === 'success') {
                leg.settleIdleSince ||= Date.now();
                const remaining = SUCCESS_IDLE_GRACE - (Date.now() - leg.settleIdleSince);
                if (remaining > 0) {
                    settleLegWhenIdle(session, leg, Math.min(200, remaining));
                    return;
                }
            }
            const outcome = leg.status === 'success' ? 'success' : leg.status === 'error' ? 'error' : '';
            finalizeSession(session, outcome);
        }, delay);
    }

    function markLegResult(leg, status, settle = true) {
        if (!leg || leg.status === 'cancelled' || leg.status === 'superseded') {
            return;
        }

        clearLegMonitor(leg);
        leg.active = false;
        leg.status = status;

        if (settle && !leg.session.isGroup) {
            settleLegWhenIdle(leg.session, leg, status === 'error' ? FAILURE_SETTLE_DELAY : 0);
        }
    }

    function supersedeLeg(leg) {
        if (!leg) {
            return;
        }
        clearLegMonitor(leg);
        removeLegMessageKeys(leg);
        leg.active = false;
        leg.status = 'superseded';
    }

    function monitorLeg(leg) {
        clearLegMonitor(leg);
        leg.monitorTimer = setTimeout(() => {
            leg.monitorTimer = 0;
            if (leg !== currentLeg || !leg.active || leg.session.cancelled || leg.session.notified) {
                return;
            }

            if (leg.messageObserved) {
                leg.idleSince = 0;
                return;
            }

            const now = Date.now();
            if (safeIsGenerating()) {
                leg.idleSince = 0;
                monitorLeg(leg);
                return;
            }

            leg.idleSince ||= now;
            if (now - leg.idleSince >= FAILURE_IDLE_GRACE) {
                markLegResult(leg, 'error');
                return;
            }
            monitorLeg(leg);
        }, LEG_CHECK_INTERVAL);
    }

    function cancelSession(session) {
        if (!session || session.notified) {
            return;
        }
        session.cancelled = true;
        clearSettleTimer();
        for (const leg of session.legs) {
            clearLegMonitor(leg);
            removeLegMessageKeys(leg);
            if (leg.status === 'pending') {
                leg.status = 'cancelled';
            }
            leg.active = false;
        }
    }

    function onGenerationAfterCommands(type, _params, dryRun) {
        if (dryRun || IGNORED_GENERATION_TYPES.has(String(type || ''))) {
            return;
        }

        clearSettleTimer();
        let session;
        let memberToken = 0;

        if (activeGroup) {
            session = activeGroup.session || (activeGroup.session = createSession(true));
            memberToken = activeGroup.memberToken;
            if (currentLeg?.session === session) {
                if (currentLeg.memberToken === memberToken) {
                    supersedeLeg(currentLeg);
                } else if (currentLeg.active) {
                    markLegResult(currentLeg, currentLeg.messageObserved && !currentLeg.streamFailed ? 'success' : 'error', false);
                }
            }
        } else {
            session = currentSession && !currentSession.cancelled && !currentSession.notified
                ? currentSession
                : createSession(false);
            if (currentLeg?.session === session) {
                supersedeLeg(currentLeg);
            }
        }

        currentSession = session;
        currentLeg = createLeg(session, type, memberToken);
        monitorLeg(currentLeg);
    }

    function messageFinishedAt(message) {
        const timestamp = new Date(message?.gen_finished || 0).getTime();
        return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function isUsableCharacterMessage(message) {
        if (!message || message.is_user || message.is_system) {
            return false;
        }
        const text = String(message.mes || '').trim();
        const hasVisibleAttachment = Boolean(message.extra?.image || message.extra?.media);
        const hasReasoning = Boolean(message.extra?.reasoning);
        return Boolean((text && text !== '...') || hasVisibleAttachment || hasReasoning);
    }

    function isCompatibleMessageType(legType, messageType, streamingProcessor) {
        const expected = String(legType || 'normal');
        const actual = String(messageType || expected);
        if (expected === 'continue') {
            return ['continue', 'append', 'appendFinal'].includes(actual);
        }
        if (expected === 'regenerate' && actual === 'normal') {
            return !streamingProcessor;
        }
        return expected === actual;
    }

    function isExpectedMessageId(leg, messageId) {
        const id = Number(messageId);
        if (!Number.isInteger(id) || id < 0) {
            return false;
        }
        const reusesLastMessage = ['regenerate', 'swipe', 'continue'].includes(leg.type);
        const minimumId = reusesLastMessage ? Math.max(0, leg.chatLength - 1) : leg.chatLength;
        return id >= minimumId;
    }

    function onMessageReceived(messageId, messageType) {
        const leg = currentLeg;
        if (!leg?.active || leg.session.cancelled || leg.session.notified) {
            return;
        }
        const context = getContext();
        if (IGNORED_MESSAGE_TYPES.has(String(messageType || ''))
            || !isCompatibleMessageType(leg.type, messageType, context?.streamingProcessor)
            || !isExpectedMessageId(leg, messageId)) {
            return;
        }

        if (leg.chatId !== getChatId(context)) {
            return;
        }
        const message = context?.chat?.[Number(messageId)];
        if (!isUsableCharacterMessage(message)) {
            return;
        }

        const finishedAt = messageFinishedAt(message);
        if (finishedAt && finishedAt < leg.startedAt) {
            return;
        }

        leg.messageObserved = true;
        leg.messageObservedAt = Date.now();
        leg.messageId = Number(messageId);
        leg.streamFailed = Boolean(context?.streamingProcessor?.isStopped);
        messageLegs.set(getMessageKey(leg.chatId, messageId), leg);
        monitorLeg(leg);
    }

    function onCharacterMessageRendered(messageId, messageType) {
        if (IGNORED_MESSAGE_TYPES.has(String(messageType || ''))) {
            return;
        }

        const context = getContext();
        const key = getMessageKey(getChatId(context), messageId);
        const leg = messageLegs.get(key);
        if (leg) {
            messageLegs.delete(key);
        }
        if (!leg || leg.session.cancelled || leg.session.notified) {
            return;
        }

        markLegResult(leg, leg.streamFailed ? 'error' : 'success');
    }

    function onGenerationStopped() {
        cancelSession(currentSession);
    }

    function onGroupStarted() {
        cancelSession(currentSession);
        activeGroup = { session: null, memberToken: 0 };
        currentSession = null;
        currentLeg = null;
    }

    function onGroupMemberDrafted() {
        if (activeGroup) {
            activeGroup.memberToken += 1;
        }
    }

    function onGroupFinished() {
        const group = activeGroup;
        activeGroup = null;
        if (!group?.session || group.session.cancelled || group.session.notified) {
            return;
        }

        const session = group.session;
        for (const leg of session.legs) {
            if (leg.active || leg.status === 'pending') {
                markLegResult(leg, leg.messageObserved && !leg.streamFailed ? 'success' : 'error', false);
            }
        }

        const completedLegs = session.legs.filter(leg => leg.status !== 'superseded' && leg.status !== 'cancelled');
        const outcome = completedLegs.some(leg => leg.status === 'error')
            ? 'error'
            : completedLegs.some(leg => leg.status === 'success') ? 'success' : '';
        currentSession = session;
        currentLeg = completedLegs.at(-1) || null;
        finalizeSession(session, outcome);
    }

    function resetGenerationTracking() {
        cancelSession(currentSession);
        activeGroup = null;
        currentSession = null;
        currentLeg = null;
        messageLegs.clear();
        stopFlashing();
    }

    function prioritizeLifecycleListeners() {
        eventSource.makeFirst(eventTypes.GROUP_WRAPPER_STARTED, onGroupStarted);
        eventSource.makeFirst(eventTypes.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
        eventSource.makeFirst(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.makeLast(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
        eventSource.makeLast(eventTypes.GROUP_WRAPPER_FINISHED, onGroupFinished);
        eventSource.makeFirst(eventTypes.GENERATION_STOPPED, onGenerationStopped);
    }

    function populateSelect(kind) {
        const select = kind === 'success' ? controls?.successSelect : controls?.errorSelect;
        if (!select) {
            return;
        }

        const selectedValue = kind === 'success' ? featureSettings.successSound : featureSettings.errorSound;
        select.replaceChildren();
        select.add(new Option('无', ''));
        select.add(new Option(BUILTIN_SOUNDS[kind].label, BUILTIN_SOUNDS[kind].value));

        for (const record of customAudios[kind]) {
            select.add(new Option(`[自定义] ${record.name}`, `${CUSTOM_PREFIX}${record.id}`));
        }

        const hasSelectedValue = Array.from(select.options).some(option => option.value === selectedValue);
        if (!hasSelectedValue && selectedValue) {
            select.add(new Option(`[本浏览器不可用] ${selectedValue}`, selectedValue));
        }
        select.value = selectedValue;
    }

    function updateDeleteButtons() {
        if (!controls) {
            return;
        }
        controls.deleteSuccess.hidden = !getCustomAudio('success', featureSettings.successSound);
        controls.deleteError.hidden = !getCustomAudio('error', featureSettings.errorSound);
    }

    function updateControls() {
        if (!controls) {
            return;
        }

        controls.enabled.checked = featureSettings.enabled;
        controls.soundEnabled.checked = featureSettings.soundEnabled;
        controls.flashEnabled.checked = featureSettings.flashEnabled;
        controls.flashIconEnabled.checked = featureSettings.flashIconEnabled;
        controls.onlyWhenUnfocused.checked = featureSettings.onlyWhenUnfocused;
        controls.volume.value = String(Math.round(featureSettings.volume * 100));
        controls.volumeValue.textContent = controls.volume.value;

        const soundControlsEnabled = featureSettings.enabled && featureSettings.soundEnabled;
        const customAudioLimitReached = customAudios.success.length + customAudios.error.length >= MAX_CUSTOM_AUDIO_FILES;
        controls.soundEnabled.disabled = !featureSettings.enabled;
        controls.flashEnabled.disabled = !featureSettings.enabled;
        const flashIconControlsEnabled = featureSettings.enabled && featureSettings.flashEnabled;
        controls.flashIconEnabled.disabled = !flashIconControlsEnabled;
        controls.uploadFlashIcon.disabled = !flashIconControlsEnabled || !featureSettings.flashIconEnabled;
        controls.resetFlashIcon.disabled = !flashIconControlsEnabled || !featureSettings.flashIconEnabled;
        updateFlashIconPreview();
        controls.onlyWhenUnfocused.disabled = !featureSettings.enabled;
        controls.successSelect.disabled = !soundControlsEnabled;
        controls.errorSelect.disabled = !soundControlsEnabled;
        controls.testSuccess.disabled = !soundControlsEnabled;
        controls.testError.disabled = !soundControlsEnabled;
        controls.uploadSuccess.disabled = !soundControlsEnabled || !indexedDbAvailable || customAudioLimitReached;
        controls.uploadError.disabled = !soundControlsEnabled || !indexedDbAvailable || customAudioLimitReached;
        controls.volume.disabled = !soundControlsEnabled;
        controls.deleteSuccess.disabled = !soundControlsEnabled;
        controls.deleteError.disabled = !soundControlsEnabled;
        updateDeleteButtons();
    }

    function validateAudioFile(file) {
        if (!file) {
            return '未选择文件。';
        }
        const supportedExtension = /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name || '');
        if (!file.type?.startsWith('audio/') && !supportedExtension) {
            return '请选择常见音频文件（mp3、wav、ogg、m4a、aac 或 flac）。';
        }
        if (file.size > 15 * 1024 * 1024) {
            return '音频文件不能超过 15 MB。';
        }
        return '';
    }

    async function handleUpload(kind, file) {
        const validationError = validateAudioFile(file);
        if (validationError) {
            showToast('error', validationError);
            return;
        }

        try {
            const record = await addCustomAudio(kind, file);
            const value = `${CUSTOM_PREFIX}${record.id}`;
            if (kind === 'success') {
                featureSettings.successSound = value;
            } else {
                featureSettings.errorSound = value;
            }
            saveSettings();
            populateSelect(kind);
            updateDeleteButtons();
            showToast('success', '音频已保存并选中。');
        } catch (error) {
            console.error('[st-toolbox] 保存自定义音频失败：', error);
            showToast('error', error?.message || '保存自定义音频失败。');
        }
    }

    async function handleDelete(kind) {
        const value = kind === 'success' ? featureSettings.successSound : featureSettings.errorSound;
        const record = getCustomAudio(kind, value);
        if (!record) {
            return;
        }
        if (!confirm(`确定删除“${record.name}”吗？`)) {
            return;
        }

        try {
            await deleteCustomAudio(record.id);
            if (kind === 'success') {
                featureSettings.successSound = '';
            } else {
                featureSettings.errorSound = '';
            }
            saveSettings();
            populateSelect(kind);
            updateDeleteButtons();
            showToast('success', '自定义音频已删除。');
        } catch (error) {
            console.error('[st-toolbox] 删除自定义音频失败：', error);
            showToast('error', '删除自定义音频失败。');
        }
    }

    function updateFlashIconPreview() {
        if (!controls) return;
        const custom = featureSettings.flashIcon;
        const original = faviconBeforeFlash || getFaviconLink()?.href || '/favicon.ico';
        controls.flashIconA.src = custom || BUILTIN_FLASH_ICONS[0];
        controls.flashIconB.src = custom ? original : BUILTIN_FLASH_ICONS[1];
        controls.flashIconName.textContent = custom ? '自定义图标 ↔ 原 favicon' : '默认图标';
        controls.resetFlashIcon.hidden = !custom;
    }

    function validateIconFile(file) {
        if (!file) return '未选择文件。';
        const supportedExtension = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(file.name || '');
        if (!file.type?.startsWith('image/') && !supportedExtension) {
            return '请选择图片文件（png、jpg、gif、webp、svg 或 ico）。';
        }
        if (file.size > FLASH_ICON_MAX_UPLOAD_BYTES) {
            return '图标文件不能超过 2 MB。';
        }
        return '';
    }

    async function handleFlashIconUpload(file) {
        const validationError = validateIconFile(file);
        if (validationError) {
            showToast('error', validationError);
            return;
        }
        try {
            featureSettings.flashIcon = await normalizeFlashIcon(file);
            saveSettings();
            stopFlashing();
            updateControls();
            showToast('success', '闪烁图标已更新。');
        } catch (error) {
            console.error('[st-toolbox] 保存闪烁图标失败：', error);
            showToast('error', error?.message || '保存闪烁图标失败。');
        }
    }

    function bindSettingsEvents(section) {
        controls.enabled.addEventListener('change', () => {
            featureSettings.enabled = controls.enabled.checked;
            if (!featureSettings.enabled) {
                stopCurrentAudio();
                stopFlashing();
            }
            updateControls();
            saveSettings();
        });
        controls.soundEnabled.addEventListener('change', () => {
            featureSettings.soundEnabled = controls.soundEnabled.checked;
            if (!featureSettings.soundEnabled) {
                stopCurrentAudio();
            }
            updateControls();
            saveSettings();
        });
        controls.flashEnabled.addEventListener('change', () => {
            featureSettings.flashEnabled = controls.flashEnabled.checked;
            if (!featureSettings.flashEnabled) {
                stopFlashing();
            }
            updateControls();
            saveSettings();
        });
        controls.flashIconEnabled.addEventListener('change', () => {
            featureSettings.flashIconEnabled = controls.flashIconEnabled.checked;
            stopFlashing();
            updateControls();
            saveSettings();
        });
        controls.uploadFlashIcon.addEventListener('click', () => {
            controls.flashIconFile.value = '';
            controls.flashIconFile.click();
        });
        controls.flashIconFile.addEventListener('change', () => void handleFlashIconUpload(controls.flashIconFile.files?.[0]));
        controls.resetFlashIcon.addEventListener('click', () => {
            featureSettings.flashIcon = '';
            saveSettings();
            stopFlashing();
            updateControls();
            showToast('success', '已恢复默认闪烁图标。');
        });
        controls.onlyWhenUnfocused.addEventListener('change', () => {
            featureSettings.onlyWhenUnfocused = controls.onlyWhenUnfocused.checked;
            saveSettings();
        });
        controls.successSelect.addEventListener('change', () => {
            featureSettings.successSound = controls.successSelect.value;
            updateDeleteButtons();
            saveSettings();
        });
        controls.errorSelect.addEventListener('change', () => {
            featureSettings.errorSound = controls.errorSelect.value;
            updateDeleteButtons();
            saveSettings();
        });
        controls.volume.addEventListener('input', () => {
            featureSettings.volume = Number(controls.volume.value) / 100;
            controls.volumeValue.textContent = controls.volume.value;
            if (currentPlayback) {
                currentPlayback.audio.volume = featureSettings.volume;
            }
            saveSettings();
        });
        controls.testSuccess.addEventListener('click', () => void playSound('success', true));
        controls.testError.addEventListener('click', () => void playSound('error', true));
        controls.uploadSuccess.addEventListener('click', () => {
            controls.successFile.value = '';
            controls.successFile.click();
        });
        controls.uploadError.addEventListener('click', () => {
            controls.errorFile.value = '';
            controls.errorFile.click();
        });
        controls.successFile.addEventListener('change', () => void handleUpload('success', controls.successFile.files?.[0]));
        controls.errorFile.addEventListener('change', () => void handleUpload('error', controls.errorFile.files?.[0]));
        controls.deleteSuccess.addEventListener('click', () => void handleDelete('success'));
        controls.deleteError.addEventListener('click', () => void handleDelete('error'));

        if (!indexedDbAvailable) {
            const warning = document.createElement('p');
            warning.className = 'st-toolbox-help st-toolbox-warning';
            warning.textContent = '当前浏览器无法使用 IndexedDB，因此自定义音频上传已禁用。';
            section.appendChild(warning);
        }
    }

    function init() {
        prioritizeLifecycleListeners();
        eventSource.on(eventTypes.APP_READY, prioritizeLifecycleListeners);
        eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
        eventSource.on(eventTypes.CHAT_CHANGED, resetGenerationTracking);

        window.addEventListener('focus', stopFlashing);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                stopFlashing();
            }
        });
        window.addEventListener('pagehide', () => {
            stopFlashing();
            stopCurrentAudio();
            database?.close();
            database = null;
            databasePromise = null;
        });

        void loadCustomAudios()
            .then(() => {
                populateSelect('success');
                populateSelect('error');
                updateControls();
            })
            .catch(error => {
                indexedDbAvailable = false;
                console.warn('[st-toolbox] IndexedDB 不可用，将只提供内置提示音：', error);
                updateControls();
            });
    }

    function renderSettings(container) {
        const section = document.createElement('section');
        section.className = 'st-toolbox-section st-toolbox-notifications';
        section.innerHTML = `
            <div class="st-toolbox-notification-switches">
                <label class="checkbox_label">
                    <input id="st-toolbox-notifications-enabled" type="checkbox">
                    <span>启用提示通知</span>
                </label>
                <label class="checkbox_label">
                    <input id="st-toolbox-sound-enabled" type="checkbox">
                    <span>播放提示音</span>
                </label>
                <label class="checkbox_label">
                    <input id="st-toolbox-flash-enabled" type="checkbox">
                    <span>标签页闪烁</span>
                </label>
                <label class="checkbox_label">
                    <input id="st-toolbox-flash-icon-enabled" type="checkbox">
                    <span>闪烁时切换标签页图标</span>
                </label>
                <label class="checkbox_label">
                    <input id="st-toolbox-background-only" type="checkbox">
                    <span>仅失焦/后台时播放声音</span>
                </label>
            </div>
            <p class="st-toolbox-help">回复完成后播放成功音，失败或迟迟无有效回复时播放错误音；手动停止不报错，群聊每轮只提醒一次。酒馆自带 Message Sound 同时开启时，声音会叠加。</p>
            <label>闪烁图标</label>
            <div class="st-toolbox-row st-toolbox-flash-icon-row">
                <span class="st-toolbox-flash-icon-preview" title="闪烁时交替显示的两张图标">
                    <img id="st-toolbox-flash-icon-a" alt="闪烁图标 1">
                    <img id="st-toolbox-flash-icon-b" alt="闪烁图标 2">
                </span>
                <span id="st-toolbox-flash-icon-name" class="st-toolbox-flash-icon-name"></span>
                <button id="st-toolbox-upload-flash-icon" class="menu_button st-toolbox-icon-button" type="button" title="上传自定义图标"><i class="fa-solid fa-upload"></i></button>
                <button id="st-toolbox-reset-flash-icon" class="menu_button st-toolbox-icon-button" type="button" title="恢复默认图标" hidden><i class="fa-solid fa-rotate-left"></i></button>
                <input id="st-toolbox-flash-icon-file" type="file" accept="image/*,.ico" hidden>
            </div>
            <p class="st-toolbox-help">默认交替显示两张图标；自定义图标与原标签页图标交替。支持常见图片格式，保存为 64×64 PNG（最多 96 KB）。</p>
            <label for="st-toolbox-success-sound">成功提示音</label>
            <div class="st-toolbox-row">
                <select id="st-toolbox-success-sound" class="text_pole"></select>
                <button id="st-toolbox-test-success" class="menu_button st-toolbox-icon-button" type="button" title="试听成功音"><i class="fa-solid fa-play"></i></button>
                <button id="st-toolbox-upload-success" class="menu_button st-toolbox-icon-button" type="button" title="上传成功音"><i class="fa-solid fa-upload"></i></button>
                <button id="st-toolbox-delete-success" class="menu_button st-toolbox-icon-button" type="button" title="删除所选自定义成功音" hidden><i class="fa-solid fa-trash"></i></button>
                <input id="st-toolbox-success-file" type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" hidden>
            </div>
            <label for="st-toolbox-error-sound">错误提示音</label>
            <div class="st-toolbox-row">
                <select id="st-toolbox-error-sound" class="text_pole"></select>
                <button id="st-toolbox-test-error" class="menu_button st-toolbox-icon-button" type="button" title="试听错误音"><i class="fa-solid fa-play"></i></button>
                <button id="st-toolbox-upload-error" class="menu_button st-toolbox-icon-button" type="button" title="上传错误音"><i class="fa-solid fa-upload"></i></button>
                <button id="st-toolbox-delete-error" class="menu_button st-toolbox-icon-button" type="button" title="删除所选自定义错误音" hidden><i class="fa-solid fa-trash"></i></button>
                <input id="st-toolbox-error-file" type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" hidden>
            </div>
            <label class="st-toolbox-volume" for="st-toolbox-volume">
                <span>音量：<output id="st-toolbox-volume-value">50</output>%</span>
                <input id="st-toolbox-volume" type="range" min="0" max="100" step="1">
            </label>
            <p class="st-toolbox-help">音频仅存于当前浏览器，不上传服务器；清除浏览器数据会丢失。每个最多 15 MB，共 30 个。</p>
        `;

        const find = selector => section.querySelector(selector);
        controls = {
            enabled: find('#st-toolbox-notifications-enabled'),
            soundEnabled: find('#st-toolbox-sound-enabled'),
            flashEnabled: find('#st-toolbox-flash-enabled'),
            flashIconEnabled: find('#st-toolbox-flash-icon-enabled'),
            flashIconA: find('#st-toolbox-flash-icon-a'),
            flashIconB: find('#st-toolbox-flash-icon-b'),
            flashIconName: find('#st-toolbox-flash-icon-name'),
            uploadFlashIcon: find('#st-toolbox-upload-flash-icon'),
            resetFlashIcon: find('#st-toolbox-reset-flash-icon'),
            flashIconFile: find('#st-toolbox-flash-icon-file'),
            onlyWhenUnfocused: find('#st-toolbox-background-only'),
            successSelect: find('#st-toolbox-success-sound'),
            errorSelect: find('#st-toolbox-error-sound'),
            testSuccess: find('#st-toolbox-test-success'),
            testError: find('#st-toolbox-test-error'),
            uploadSuccess: find('#st-toolbox-upload-success'),
            uploadError: find('#st-toolbox-upload-error'),
            deleteSuccess: find('#st-toolbox-delete-success'),
            deleteError: find('#st-toolbox-delete-error'),
            successFile: find('#st-toolbox-success-file'),
            errorFile: find('#st-toolbox-error-file'),
            volume: find('#st-toolbox-volume'),
            volumeValue: find('#st-toolbox-volume-value'),
        };

        populateSelect('success');
        populateSelect('error');
        bindSettingsEvents(section);
        updateControls();
        container.appendChild(section);
    }

    function syncSettings() {
        if (!featureSettings.enabled || !featureSettings.soundEnabled) {
            stopCurrentAudio();
        } else if (currentPlayback) {
            currentPlayback.audio.volume = featureSettings.volume;
        }
        if (!featureSettings.enabled || !featureSettings.flashEnabled) {
            stopFlashing();
        }
        populateSelect('success');
        populateSelect('error');
        updateControls();
    }

    return { init, renderSettings, syncSettings };
}
