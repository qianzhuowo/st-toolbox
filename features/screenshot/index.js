const SCRIPT_ID = 'st-toolbox-modern-screenshot';
const LIBRARY_URL = '/scripts/extensions/third-party/st-toolbox/features/screenshot/vendor/modern-screenshot.umd.js';
const MESSAGE_BUTTON_CLASS = 'st-toolbox-screenshot-button';
const RANGE_MENU_CLASS = 'st-toolbox-screenshot-range-menu';
const MULTI_CONTAINER_ID = 'st-toolbox-screenshot-wand-container';
const MULTI_START_ID = 'st-toolbox-screenshot-multi-start';
const MULTI_CAPTURE_ID = 'st-toolbox-screenshot-multi-capture';
const MULTI_CANCEL_ID = 'st-toolbox-screenshot-multi-cancel';
const SELECTED_CLASS = 'st-toolbox-screenshot-selected';
const SELECTING_CLASS = 'st-toolbox-screenshot-selecting';
const LONG_PRESS_DURATION = 500;
const MAX_CANVAS_DIMENSION = 16000;
const MAX_CANVAS_AREA = 16_000_000;
const MAX_BACKGROUND_AREA = 8_000_000;
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const LIBRARY_TIMEOUT = 10000;
const LAZY_MEDIA_TIMEOUT = 8000;
const RESOURCE_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
const FONT_CACHE_LIMIT = 64;
const DOWNSCALE_THRESHOLD = 0.8;
const pendingDownloadUrls = new Set();

// 跨次截图缓存：图片/背景 data URL（LRU，按字节数限制）、字体 @font-face cssText、背景底图。
const resourceCache = new Map();
let resourceCacheBytes = 0;
const fontCssTextCache = new Map();
let backgroundCache = null;
let webpEncodeSupport = null;

function cacheGet(key) {
    const entry = resourceCache.get(key);
    if (!entry) return null;
    resourceCache.delete(key);
    resourceCache.set(key, entry);
    return entry.value;
}

function cacheSet(key, value) {
    if (typeof value !== 'string') return;
    const size = value.length;
    if (size > RESOURCE_CACHE_LIMIT_BYTES / 4) return;
    const existing = resourceCache.get(key);
    if (existing) {
        resourceCacheBytes -= existing.size;
        resourceCache.delete(key);
    }
    resourceCache.set(key, { value, size });
    resourceCacheBytes += size;
    while (resourceCacheBytes > RESOURCE_CACHE_LIMIT_BYTES && resourceCache.size) {
        const [oldestKey, oldest] = resourceCache.entries().next().value;
        resourceCache.delete(oldestKey);
        resourceCacheBytes -= oldest.size;
    }
}

function rememberFontCss(map) {
    for (const [key, value] of map) {
        if (fontCssTextCache.has(key)) fontCssTextCache.delete(key);
        fontCssTextCache.set(key, value);
    }
    while (fontCssTextCache.size > FONT_CACHE_LIMIT) {
        fontCssTextCache.delete(fontCssTextCache.keys().next().value);
    }
}

function resourceKey(src) {
    const value = String(src || '');
    if (value.startsWith('data:')) {
        return `data:${value.length}:${value.slice(0, 96)}:${value.slice(-96)}`;
    }
    try {
        return new URL(value, location.href).href;
    } catch {
        return value;
    }
}

function canEncodeWebp() {
    if (webpEncodeSupport === null) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            webpEncodeSupport = canvas.toDataURL('image/webp').startsWith('data:image/webp');
        } catch {
            webpEncodeSupport = false;
        }
    }
    return webpEncodeSupport;
}

/**
 * 把图片缩小到截图实际需要的像素尺寸（显示尺寸 × 截图倍率）。
 * 原图往往远大于显示尺寸（如 1024×1536 的插图只显示 400px 宽），缩小后 SVG 体积和栅格化开销都大幅下降。
 * 返回 data URL；不需要/不能缩小时返回 null。
 */
async function downscaleImageBlob(blob, need, lossless) {
    if (!blob || !need || !blob.type.startsWith('image/')) return null;
    if (['image/gif', 'image/svg+xml', 'image/apng'].includes(blob.type)) return null;
    if (typeof createImageBitmap !== 'function') return null;
    let bitmap = null;
    try {
        bitmap = await createImageBitmap(blob);
        const ratio = Math.max(need.width / bitmap.width, need.height / bitmap.height);
        if (!Number.isFinite(ratio) || ratio >= DOWNSCALE_THRESHOLD) return null;
        const width = Math.max(1, Math.ceil(bitmap.width * ratio));
        const height = Math.max(1, Math.ceil(bitmap.height * ratio));
        const canvas = createCanvas(width, height);
        try {
            const context = canvas.getContext('2d');
            if (!context) return null;
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(bitmap, 0, 0, width, height);
            let type = 'image/png';
            let quality;
            if (!lossless) {
                if (canEncodeWebp()) {
                    type = 'image/webp';
                    quality = 0.92;
                } else if (blob.type === 'image/jpeg') {
                    type = 'image/jpeg';
                    quality = 0.92;
                }
            }
            return canvas.toDataURL(type, quality);
        } finally {
            releaseCanvas(canvas);
        }
    } catch (error) {
        console.debug('[st-toolbox] 图片缩放失败，使用原图：', error);
        return null;
    } finally {
        bitmap?.close?.();
    }
}

/** 统计待截图元素内每张图片在最终画布上需要的像素尺寸。 */
function collectImageBudget(elements, scale) {
    const budget = new Map();
    for (const element of elements) {
        for (const image of element.querySelectorAll('img')) {
            const src = image.currentSrc || image.src;
            if (!src) continue;
            const rect = image.getBoundingClientRect();
            if (!(rect.width > 0) || !(rect.height > 0)) continue;
            const key = resourceKey(src);
            const need = {
                width: Math.ceil(rect.width * scale),
                height: Math.ceil(rect.height * scale),
            };
            const existing = budget.get(key);
            if (existing) {
                existing.width = Math.max(existing.width, need.width);
                existing.height = Math.max(existing.height, need.height);
            } else {
                budget.set(key, need);
            }
        }
    }
    return budget;
}

function budgetCacheKey(key, need, lossless) {
    return need ? `${key}@${need.width}x${need.height}${lossless ? ':L' : ''}` : key;
}

/**
 * 克隆阶段处理 data: URL 图片（例如 LittleWhiteBox 生成的 base64 PNG）：
 * 库对 data: 图片不走 fetchFn，这里在克隆节点上直接替换为缩小后的版本。
 */
async function shrinkClonedDataImage(cloned, task) {
    if (!(cloned instanceof HTMLImageElement)) return;
    const src = cloned.getAttribute('src') || '';
    if (!src.startsWith('data:image/')) return;
    const key = resourceKey(src);
    const need = task.imageBudget?.get(key);
    if (!need) return;
    const cacheKey = budgetCacheKey(key, need, task.lossless);
    let result = cacheGet(cacheKey);
    if (!result) {
        try {
            const blob = await (await fetch(src)).blob();
            result = await downscaleImageBlob(blob, need, task.lossless);
        } catch (error) {
            console.debug('[st-toolbox] data 图片缩放失败：', error);
        }
        if (!result) return;
        cacheSet(cacheKey, result);
    }
    cloned.src = result;
    cloned.srcset = '';
}

/**
 * 截图前强制加载目标元素内的懒加载图片（loading="lazy"），并等待它们完成，
 * 这样后续测量的尺寸才是包含图片的真实高度（否则底部会被裁掉），也避免库内部等待 load 直到超时。
 * 返回一个恢复函数和仍未加载的图片数。
 */
async function preloadLazyMedia(elements, assertActive, timeout = LAZY_MEDIA_TIMEOUT) {
    const images = elements.flatMap(element => Array.from(element.querySelectorAll('img')));
    const restore = [];
    const pending = [];
    for (const image of images) {
        if (image.loading === 'lazy') {
            image.loading = 'eager';
            restore.push(image);
        }
        if (image.complete || !(image.currentSrc || image.getAttribute('src'))) continue;
        pending.push(new Promise(resolve => {
            const done = () => {
                image.removeEventListener('load', done);
                image.removeEventListener('error', done);
                resolve();
            };
            image.addEventListener('load', done);
            image.addEventListener('error', done);
        }));
    }
    const restoreLoading = () => {
        for (const image of restore) image.loading = 'lazy';
    };
    if (pending.length) {
        const started = performance.now();
        let finished = false;
        const loaded = Promise.allSettled(pending).then(() => { finished = true; });
        while (!finished && performance.now() - started < timeout) {
            assertActive?.();
            await Promise.race([loaded, new Promise(resolve => setTimeout(resolve, 100))]);
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const unloaded = images.filter(image => !image.complete || (image.naturalWidth === 0 && (image.currentSrc || image.getAttribute('src')))).length;
    const placeholders = elements.reduce((sum, element) => sum + element.querySelectorAll(
        '[data-xb-draw-chat-image="1"]:not([data-loaded="1"]), .xb-nd-img.busy',
    ).length, 0);
    return { restoreLoading, unloaded: unloaded + placeholders };
}

function showToast(level, message) {
    const method = globalThis.toastr?.[level];
    if (typeof method === 'function') {
        method.call(globalThis.toastr, message, 'ST Toolbox');
    }
}

function waitForScript(script) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            script.removeEventListener('load', onLoad);
            script.removeEventListener('error', onError);
            callback(value);
        };
        const onLoad = () => finish(resolve);
        const onError = () => finish(reject, new Error(`截图依赖加载失败：${script.src}`));
        const timeout = setTimeout(() => finish(reject, new Error('截图依赖加载超时。')), 15000);
        script.addEventListener('load', onLoad);
        script.addEventListener('error', onError);
    });
}

function isValidLibrary(library) {
    return Boolean(library
        && typeof library.domToCanvas === 'function'
        && typeof library.createContext === 'function'
        && typeof library.destroyContext === 'function');
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('读取图片数据失败。'));
        reader.readAsDataURL(blob);
    });
}

function createResourceFetcher(task) {
    const { failures, assertActive } = task;
    return async rawUrl => {
        const raw = String(rawUrl);
        if (raw.startsWith('data:')) return raw;
        const key = resourceKey(raw);
        const need = task.imageBudget?.get(key);
        const cacheKey = budgetCacheKey(key, need, task.lossless);
        const cached = cacheGet(cacheKey);
        if (cached) return cached;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('截图资源加载超时'), 15000);
        const activeCheck = setInterval(() => {
            try {
                assertActive?.();
            } catch {
                controller.abort('截图任务已取消');
            }
        }, 250);
        try {
            const response = await fetch(raw, { credentials: 'same-origin', signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            let result = need ? await downscaleImageBlob(blob, need, task.lossless) : null;
            if (!result) result = await blobToDataUrl(blob);
            cacheSet(cacheKey, result);
            return result;
        } catch (error) {
            try {
                failures.add(new URL(raw, location.href).origin);
            } catch {
                failures.add('未知来源');
            }
            console.debug('[st-toolbox] 截图资源未能嵌入：', error);
            return TRANSPARENT_PIXEL;
        } finally {
            clearTimeout(timeout);
            clearInterval(activeCheck);
        }
    };
}

function parseCssColor(color) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return [0, 0, 0, 255];
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = 'rgba(0, 0, 0, 0)';
    try {
        context.fillStyle = color || 'rgba(0, 0, 0, 0)';
    } catch {
        context.fillStyle = 'rgba(0, 0, 0, 0)';
    }
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
}

function compositeColor(foreground, background) {
    const alpha = foreground[3] / 255;
    return [
        Math.round(foreground[0] * alpha + background[0] * (1 - alpha)),
        Math.round(foreground[1] * alpha + background[1] * (1 - alpha)),
        Math.round(foreground[2] * alpha + background[2] * (1 - alpha)),
        255,
    ];
}

function colorToCss(color) {
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function getOpaqueThemeColor() {
    const bodyColor = getComputedStyle(document.body).backgroundColor;
    return colorToCss(compositeColor(parseCssColor(bodyColor), [0, 0, 0, 255]));
}

function fillCanvas(canvas, color) {
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('无法创建 Canvas 2D 上下文。');
    }
    context.save();
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
}

function createCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 1;
    canvas.height = 1;
}

function getActiveBackgroundElement() {
    const selectors = [
        '#bg_animation_container > div[id^="bg"]',
        '#background > div[id^="bg"]',
        '#bg_custom',
        '#bg1',
        '#bg_animation_container',
        '#background',
    ];
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
            continue;
        }
        const style = getComputedStyle(element);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.backgroundImage !== 'none') {
            return element;
        }
    }
    return null;
}

function canvasHasVisiblePixels(canvas) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return false;
    }
    try {
        const points = [
            [0.5, 0.5], [0.1, 0.1], [0.9, 0.1],
            [0.1, 0.9], [0.9, 0.9],
        ];
        return points.some(([x, y]) => {
            const pixel = context.getImageData(
                Math.min(canvas.width - 1, Math.max(0, Math.floor(canvas.width * x))),
                Math.min(canvas.height - 1, Math.max(0, Math.floor(canvas.height * y))),
                1,
                1,
            ).data;
            return pixel[3] > 0;
        });
    } catch {
        return true;
    }
}

function extractFirstBackgroundUrl(backgroundImage) {
    const match = /url\((['"]?)(.*?)\1\)/i.exec(backgroundImage || '');
    return match?.[2] || '';
}

function loadImage(url, assertActive) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        let settled = false;
        const cleanup = () => {
            clearTimeout(timeout);
            clearInterval(activeCheck);
            image.onload = null;
            image.onerror = null;
        };
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
        };
        const fail = error => {
            finish(reject, error);
            image.src = '';
        };
        const timeout = setTimeout(() => fail(new Error(`背景图片加载超时：${url}`)), 15000);
        const activeCheck = setInterval(() => {
            try {
                assertActive?.();
            } catch (error) {
                fail(error);
            }
        }, 250);
        image.crossOrigin = 'anonymous';
        image.onload = () => finish(resolve, image);
        image.onerror = () => fail(new Error(`背景图片加载失败：${url}`));
        image.src = url;
    });
}

function parsePositionToken(token, availableSpace) {
    const normalized = String(token || '50%').toLowerCase();
    if (normalized === 'left' || normalized === 'top') return 0;
    if (normalized === 'right' || normalized === 'bottom') return availableSpace;
    if (normalized === 'center') return availableSpace / 2;
    if (normalized.endsWith('%')) return availableSpace * (Number.parseFloat(normalized) / 100);
    if (normalized.endsWith('px')) return Number.parseFloat(normalized);
    return availableSpace / 2;
}

function calculateBackgroundPlacement(image, style, width, height) {
    const size = String(style.backgroundSize || 'cover').split(',')[0].trim();
    let drawWidth = image.naturalWidth;
    let drawHeight = image.naturalHeight;
    if (size === 'cover' || size === 'contain') {
        const ratio = size === 'cover'
            ? Math.max(width / drawWidth, height / drawHeight)
            : Math.min(width / drawWidth, height / drawHeight);
        drawWidth *= ratio;
        drawHeight *= ratio;
    } else if (size === '100% 100%') {
        drawWidth = width;
        drawHeight = height;
    } else {
        const tokens = size.split(/\s+/);
        if (tokens[0]?.endsWith('%')) drawWidth = width * Number.parseFloat(tokens[0]) / 100;
        if (tokens[1]?.endsWith('%')) drawHeight = height * Number.parseFloat(tokens[1]) / 100;
    }

    const position = String(style.backgroundPosition || '50% 50%').split(',')[0].trim().split(/\s+/);
    const x = parsePositionToken(position[0], width - drawWidth);
    const y = parsePositionToken(position[1] || '50%', height - drawHeight);
    return { x, y, width: drawWidth, height: drawHeight };
}

async function drawBackgroundImageFallback(canvas, element, scale, assertActive) {
    const style = getComputedStyle(element);
    const url = extractFirstBackgroundUrl(style.backgroundImage);
    if (!url) {
        return false;
    }
    const absoluteUrl = new URL(url, location.href).href;
    const image = await loadImage(absoluteUrl, assertActive);
    const context = canvas.getContext('2d');
    const cssWidth = canvas.width / scale;
    const cssHeight = canvas.height / scale;
    const placement = calculateBackgroundPlacement(image, style, cssWidth, cssHeight);
    context.save();
    context.globalAlpha = normalizedOpacity(style.opacity);
    if (style.filter && style.filter !== 'none') {
        context.filter = style.filter.replace(/blur\(([\d.]+)px\)/gi, (_match, value) => `blur(${Number(value) * scale}px)`);
    }
    context.drawImage(
        image,
        placement.x * scale,
        placement.y * scale,
        placement.width * scale,
        placement.height * scale,
    );
    context.restore();
    return true;
}

function normalizedOpacity(value) {
    const opacity = Number.parseFloat(value);
    return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
}

function applyPseudoBackdrop(canvas, element, pseudo, rect, scale) {
    if (!(element instanceof Element)) return;
    const style = getComputedStyle(element, pseudo);
    if (!style || style.display === 'none' || style.visibility === 'hidden') return;
    const context = canvas.getContext('2d');
    const filter = style.backdropFilter || style.webkitBackdropFilter || '';
    const blur = /blur\(([\d.]+)px\)/i.exec(filter);
    if (blur && Number(blur[1]) > 0) {
        const blurPixels = Number(blur[1]) * scale;
        const padding = Math.ceil(blurPixels * 2);
        const left = Math.max(0, Math.floor(rect.left * scale) - padding);
        const top = Math.max(0, Math.floor(rect.top * scale) - padding);
        const right = Math.min(canvas.width, Math.ceil((rect.left + rect.width) * scale) + padding);
        const bottom = Math.min(canvas.height, Math.ceil((rect.top + rect.height) * scale) + padding);
        const width = Math.max(1, right - left);
        const height = Math.max(1, bottom - top);
        const blurred = createCanvas(width, height);
        try {
            const blurredContext = blurred.getContext('2d');
            if (!blurredContext) throw new Error('无法创建背景模糊 Canvas。');
            blurredContext.filter = `blur(${blurPixels}px)`;
            blurredContext.drawImage(canvas, left, top, width, height, 0, 0, width, height);
            context.save();
            context.globalAlpha = normalizedOpacity(style.opacity);
            context.beginPath();
            context.rect(rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
            context.clip();
            context.drawImage(blurred, left, top);
            context.restore();
        } finally {
            releaseCanvas(blurred);
        }
    }

    if (style.backgroundColor && parseCssColor(style.backgroundColor)[3] > 0) {
        context.save();
        context.globalAlpha = normalizedOpacity(style.opacity);
        context.fillStyle = style.backgroundColor;
        context.fillRect(rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
        context.restore();
    }
}

async function renderViewportBackground(library, scale, task) {
    task.assertActive();
    const geometry = task.geometry;
    const viewport = createCanvas(geometry.viewportWidth * scale, geometry.viewportHeight * scale);
    fillCanvas(viewport, getOpaqueThemeColor());
    let completed = false;
    try {
    const background = getActiveBackgroundElement();
    if (background) {
        const backgroundStyle = getComputedStyle(background);
        const cacheKey = JSON.stringify({
            id: background.id,
            image: backgroundStyle.backgroundImage,
            size: backgroundStyle.backgroundSize,
            position: backgroundStyle.backgroundPosition,
            opacity: backgroundStyle.opacity,
            filter: backgroundStyle.filter,
            color: getOpaqueThemeColor(),
            width: geometry.viewportWidth,
            height: geometry.viewportHeight,
            scale,
        });
        let rendered = false;
        // 跨次截图复用背景底图（以压缩位图形式缓存，内存开销小），避免每次重新栅格化整屏背景。
        if (backgroundCache?.key === cacheKey && backgroundCache.blob) {
            try {
                const bitmap = await createImageBitmap(backgroundCache.blob);
                try {
                    task.assertActive();
                    viewport.getContext('2d').drawImage(bitmap, 0, 0, viewport.width, viewport.height);
                    rendered = true;
                } finally {
                    bitmap.close?.();
                }
            } catch (error) {
                task.assertActive();
                backgroundCache = null;
                console.debug('[st-toolbox] 背景缓存读取失败，将重新渲染：', error);
            }
        }
        if (!rendered) {
            const backgroundUrl = extractFirstBackgroundUrl(backgroundStyle.backgroundImage);
            if (backgroundUrl && task.imageBudget) {
                task.imageBudget.set(resourceKey(backgroundUrl), {
                    width: Math.ceil(geometry.viewportWidth * scale),
                    height: Math.ceil(geometry.viewportHeight * scale),
                });
            }
            try {
                const backgroundCanvas = await library.domToCanvas(background, {
                    scale,
                    timeout: LIBRARY_TIMEOUT,
                    style: {
                        position: 'relative',
                        inset: 'auto',
                        left: '0',
                        top: '0',
                        width: `${geometry.viewportWidth}px`,
                        height: `${geometry.viewportHeight}px`,
                        margin: '0',
                        zIndex: '0',
                        transform: 'none',
                    },
                    fetchFn: task.fetchFn,
                });
                try {
                    task.assertActive();
                    if (canvasHasVisiblePixels(backgroundCanvas)) {
                        viewport.getContext('2d').drawImage(backgroundCanvas, 0, 0, viewport.width, viewport.height);
                        rendered = true;
                    }
                } finally {
                    releaseCanvas(backgroundCanvas);
                }
            } catch (error) {
                task.assertActive();
                console.warn('[st-toolbox] DOM 背景渲染失败，将使用图片降级方案：', error);
            }
            if (!rendered) {
                try {
                    rendered = await drawBackgroundImageFallback(viewport, background, scale, task.assertActive);
                } catch (error) {
                    task.assertActive();
                    console.warn('[st-toolbox] 背景图片降级绘制失败，将保留不透明主题底色：', error);
                }
            }
            if (rendered) {
                try {
                    const blob = await canvasToBlob(viewport, canEncodeWebp() ? 'image/webp' : 'image/jpeg', 0.92);
                    backgroundCache = { key: cacheKey, blob };
                } catch (error) {
                    console.debug('[st-toolbox] 背景缓存写入失败：', error);
                }
            }
        }
    }

    task.assertActive();
    const sheld = document.getElementById('sheld');
    if (sheld && geometry.sheldRect) {
        applyPseudoBackdrop(viewport, sheld, '::before', geometry.sheldRect, scale);
    }
    const chat = document.getElementById('chat');
    if (chat && geometry.chatRect) {
        applyPseudoBackdrop(viewport, chat, null, geometry.chatRect, scale);
    }
    completed = true;
    return viewport;
    } finally {
        if (!completed) releaseCanvas(viewport);
    }
}

function snapshotRect(element) {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
    };
}

function calculateSafeScale(elements, requestedScale, gap) {
    const rects = elements.map(element => snapshotRect(element));
    const width = Math.max(...rects.map(rect => rect.width), 1);
    const height = Math.max(rects.reduce((sum, rect) => sum + rect.height, 0) + gap * (elements.length - 1), 1);
    const dimensionScale = Math.min(MAX_CANVAS_DIMENSION / width, MAX_CANVAS_DIMENSION / height);
    const areaScale = Math.sqrt(MAX_CANVAS_AREA / (width * height));
    const scale = Math.min(requestedScale, dimensionScale, areaScale);
    if (!Number.isFinite(scale) || scale < 0.25) {
        throw new Error('所选消息过长，已超过浏览器 Canvas 安全尺寸。请减少消息数量。');
    }
    return { rects, width, height, scale };
}

function snapshotCaptureGeometry(elements, requestedScale, gap) {
    return {
        sizing: calculateSafeScale(elements, requestedScale, gap),
        gap,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        chatRect: snapshotRect(document.getElementById('chat')),
        sheldRect: snapshotRect(document.getElementById('sheld')),
    };
}

function addSvgCaptureStyles(svg) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
        .mes_buttons, .mes_edit_buttons, .swipe_left, .swipe_right,
        .${MESSAGE_BUTTON_CLASS}, .${RANGE_MENU_CLASS} { display: none !important; }
        .${SELECTED_CLASS} { outline: none !important; box-shadow: none !important; }
        q::before, q::after { content: none !important; }
        pre { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
    `;
    let defs = svg.querySelector('defs');
    if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svg.prepend(defs);
    }
    defs.appendChild(style);
}

async function createMessageContext(library, element, scale, task) {
    task.assertActive();
    const context = await library.createContext(element, {
        scale,
        timeout: LIBRARY_TIMEOUT,
        autoDestruct: false,
        style: { margin: '0' },
        fetchFn: task.fetchFn,
        onCloneEachNode: cloned => shrinkClonedDataImage(cloned, task),
        onCreateForeignObjectSvg: addSvgCaptureStyles,
    });
    try {
        task.assertActive();
        // 复用之前截图已经内联好的 @font-face（字体文件往往几 MB，重复下载转 base64 是主要耗时之一）。
        for (const [key, value] of fontCssTextCache) context.fontCssTexts.set(key, value);
        return context;
    } catch (error) {
        library.destroyContext(context);
        throw error;
    }
}

function destroyMessageContext(library, context) {
    if (!context) return;
    try {
        if (context.fontCssTexts?.size) rememberFontCss(context.fontCssTexts);
    } finally {
        library.destroyContext(context);
    }
}

async function renderMessage(library, context, element, rect, task) {
    task.assertActive();
    context.node = element;
    context.width = rect.width;
    context.height = rect.height;
    const canvas = await library.domToCanvas(context);
    try {
        task.assertActive();
        return canvas;
    } catch (error) {
        releaseCanvas(canvas);
        throw error;
    }
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('浏览器未能导出截图。')), type, quality);
    });
}

function buildFilename(count, extension) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `SillyTavern_${count > 1 ? 'Multi_' : ''}${stamp}.${extension}`;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    pendingDownloadUrls.add(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    // 注意：不要把 link 挂到 document.body 上再 click()。
    // 已挂载元素上的合成 click 会冒泡到 document，触发 SillyTavern 及主题/扩展
    // （如 Moonlit Echoes 的 active-message / show-details、酒馆的 extraMesButtons 收起等）
    // 的全局 click 处理器，导致消息布局变化、聊天区“刷新上移”。
    // 与 html2canvas-pro 一致：在游离节点上触发 click，浏览器仍会执行下载，但事件不会冒泡到页面。
    link.addEventListener('click', event => event.stopPropagation());
    link.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        pendingDownloadUrls.delete(url);
    }, 30000);
}

/**
 * 滚动位置守护。
 * 截图过程中（包括完成后的短暂稳定期），如果 #chat 或页面发生了非用户主动触发的滚动偏移
 * （例如主题/扩展的全局处理器改变了消息布局、焦点变化引起的重排等），立即把滚动位置拉回。
 * 若用户在截图期间主动滚动（滚轮/触摸/键盘/拖动滚动条），则采纳新位置，不与用户对抗。
 */
function createScrollGuard() {
    const chat = document.getElementById('chat');
    const pageScroller = document.scrollingElement || document.documentElement;
    const targets = [chat, pageScroller].filter(element => element instanceof Element);
    const USER_INPUT_WINDOW = 800;
    const BOTTOM_THRESHOLD = 2;
    const snapshots = new Map();
    let lastUserInput = Number.NEGATIVE_INFINITY;
    let restoring = false;
    let released = false;

    const snap = element => ({
        top: element.scrollTop,
        left: element.scrollLeft,
        clientHeight: element.clientHeight,
        bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
        atBottom: element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_THRESHOLD,
    });
    const adopt = () => {
        for (const element of targets) snapshots.set(element, snap(element));
    };
    const restore = () => {
        if (released || restoring) return;
        restoring = true;
        try {
            for (const [element, saved] of snapshots) {
                const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
                let target;
                if (saved.atBottom) {
                    target = maxTop;
                } else if (Math.abs(element.clientHeight - saved.clientHeight) > 1) {
                    // 可视高度变了（例如输入框/键盘引起），与 ST 自身的补偿逻辑一致：保持距底部的距离。
                    target = element.scrollHeight - element.clientHeight - saved.bottomDistance;
                } else {
                    target = saved.top;
                }
                target = Math.min(Math.max(0, target), maxTop);
                if (Math.abs(element.scrollTop - target) > 1) element.scrollTop = target;
                if (Math.abs(element.scrollLeft - saved.left) > 1) element.scrollLeft = saved.left;
            }
        } finally {
            restoring = false;
        }
    };
    const markUserInput = () => {
        lastUserInput = performance.now();
    };
    const onScroll = () => {
        if (released || restoring) return;
        if (performance.now() - lastUserInput < USER_INPUT_WINDOW) {
            adopt();
            return;
        }
        restore();
    };

    const userEvents = ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown'];
    adopt();
    for (const name of userEvents) window.addEventListener(name, markUserInput, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });

    const detach = () => {
        if (released) return;
        released = true;
        for (const name of userEvents) window.removeEventListener(name, markUserInput, { capture: true });
        window.removeEventListener('scroll', onScroll, { capture: true });
        snapshots.clear();
    };

    return {
        restore,
        /** 完成后在短时间内多次校正，覆盖下载、toast、过渡动画等异步布局变化，然后解除监听。 */
        async settleAndRelease() {
            const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
            const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
            try {
                restore();
                await frame();
                restore();
                await frame();
                restore();
                for (const step of [60, 150, 300, 500]) {
                    await wait(step);
                    restore();
                }
            } finally {
                detach();
            }
        },
        release: detach,
    };
}

export function createScreenshotFeature({ eventSource, eventTypes, settings, saveSettings }) {
    const featureSettings = settings.screenshot;
    let libraryPromise = null;
    let observer = null;
    let observedChat = null;
    let refreshFrame = 0;
    let rangeMenu = null;
    let selecting = false;
    let busy = false;
    let taskGeneration = 0;
    let chatEpoch = 0;
    let settlementGeneration = 0;
    let chatSettling = false;
    let chatReadyPromise = Promise.resolve();
    let activeTask = null;
    let controls = null;

    const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

    function waitForChatMedia(chat, timeout = 1100) {
        if (!chat) return Promise.resolve();
        const pending = Array.from(chat.querySelectorAll('img, video, audio')).filter(media => {
            if (media instanceof HTMLImageElement) return !media.complete;
            if (media instanceof HTMLMediaElement) return media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
            return false;
        });
        if (!pending.length) return Promise.resolve();
        const loaded = Promise.allSettled(pending.map(media => new Promise(resolve => {
            const events = media instanceof HTMLImageElement ? ['load', 'error'] : ['loadeddata', 'error'];
            const done = () => {
                for (const eventName of events) media.removeEventListener(eventName, done);
                resolve();
            };
            for (const eventName of events) media.addEventListener(eventName, done, { once: true });
        })));
        return Promise.race([loaded, delay(timeout)]);
    }

    function waitForChatQuiet(chat, quietTime = 180, timeout = 1200) {
        if (!chat) return Promise.resolve();
        return new Promise(resolve => {
            const startedAt = performance.now();
            let lastMutationAt = startedAt;
            const quietObserver = new MutationObserver(() => {
                lastMutationAt = performance.now();
            });
            quietObserver.observe(chat, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'class', 'style'],
            });
            const check = () => {
                const now = performance.now();
                if (now - lastMutationAt >= quietTime || now - startedAt >= timeout) {
                    quietObserver.disconnect();
                    resolve();
                    return;
                }
                setTimeout(check, 50);
            };
            setTimeout(check, 50);
        });
    }

    async function settleChat(generation, chat) {
        await nextFrame();
        await nextFrame();
        await delay(250);
        await waitForChatQuiet(chat);
        const fontsReady = document.fonts?.ready || Promise.resolve();
        await Promise.race([
            Promise.allSettled([fontsReady, waitForChatMedia(chat)]),
            delay(1200),
        ]);
        await waitForChatQuiet(chat, 100, 350);
        await Promise.race([waitForChatMedia(chat, 300), delay(350)]);
        await nextFrame();
        await nextFrame();
        if (generation !== settlementGeneration || chat !== document.getElementById('chat')) return;
        chatSettling = false;
        refreshUi();
    }

    function beginChatSettlement() {
        const chat = document.getElementById('chat');
        const generation = ++settlementGeneration;
        chatSettling = true;
        observer?.disconnect();
        chatReadyPromise = settleChat(generation, chat).finally(() => {
            if (generation === settlementGeneration && chatSettling) {
                chatSettling = false;
                refreshUi();
            }
        });
    }

    async function waitForCurrentChatReady() {
        await nextFrame();
        await nextFrame();
        while (true) {
            const current = chatReadyPromise;
            await current;
            if (current === chatReadyPromise && !chatSettling) return;
        }
    }

    function ensureLibrary() {
        if (libraryPromise) return libraryPromise;

        const existing = document.getElementById(SCRIPT_ID);
        if (isValidLibrary(existing?.__stToolboxLibrary)) {
            libraryPromise = Promise.resolve(existing.__stToolboxLibrary);
            return libraryPromise;
        }
        existing?.remove();

        const hadPreviousGlobal = Object.prototype.hasOwnProperty.call(globalThis, 'modernScreenshot');
        const previousGlobal = globalThis.modernScreenshot;
        const restorePreviousGlobal = loadedValue => {
            if (globalThis.modernScreenshot !== loadedValue) return;
            if (hadPreviousGlobal) {
                globalThis.modernScreenshot = previousGlobal;
            } else {
                delete globalThis.modernScreenshot;
            }
        };
        const script = document.createElement('script');
        script.id = SCRIPT_ID;
        script.src = LIBRARY_URL;
        script.async = true;
        script.dataset.state = 'loading';
        script.addEventListener('load', () => {
            const loadedValue = globalThis.modernScreenshot;
            setTimeout(() => restorePreviousGlobal(loadedValue), 0);
        }, { once: true });

        libraryPromise = waitForScript(script)
            .then(() => {
                const ownLibrary = globalThis.modernScreenshot;
                if (!isValidLibrary(ownLibrary)) {
                    throw new Error('st-toolbox 自带 modern-screenshot API 不完整。');
                }
                Object.defineProperty(script, '__stToolboxLibrary', { value: ownLibrary });
                script.dataset.state = 'loaded';
                restorePreviousGlobal(ownLibrary);
                return ownLibrary;
            })
            .catch(error => {
                script.dataset.state = 'error';
                script.remove();
                libraryPromise = null;
                throw error;
            });
        document.head.appendChild(script);
        return libraryPromise;
    }

    function closeRangeMenu() {
        rangeMenu?.remove();
        rangeMenu = null;
    }

    function collectAdjacent(message, before, after) {
        const result = [message];
        let current = message;
        for (let count = 0; count < before;) {
            current = current.previousElementSibling;
            if (!current) break;
            if (current.matches('.mes')) {
                result.unshift(current);
                count += 1;
            }
        }
        current = message;
        for (let count = 0; count < after;) {
            current = current.nextElementSibling;
            if (!current) break;
            if (current.matches('.mes')) {
                result.push(current);
                count += 1;
            }
        }
        return result;
    }

    async function buildScreenshot(elements, task) {
        const library = await ensureLibrary();
        task.assertActive();
        const captureSettings = task.settings;
        const { sizing, gap, viewportWidth, viewportHeight, chatRect: frozenChatRect } = task.geometry;
        if (sizing.scale < captureSettings.scale) {
            showToast('warning', `截图过长，倍率已自动降至 ${sizing.scale.toFixed(2)}。`);
        }

        const finalCanvas = createCanvas(sizing.width * sizing.scale, sizing.height * sizing.scale);
        const allocatedCanvases = new Set([finalCanvas]);
        let messageContext = null;
        try {
        const finalContext = finalCanvas.getContext('2d');
        const opaqueColor = getOpaqueThemeColor();

        if (captureSettings.backgroundMode !== 'transparent') {
            fillCanvas(finalCanvas, opaqueColor);
            if (captureSettings.backgroundMode === 'current') {
                try {
                    const backgroundScale = Math.min(
                        sizing.scale,
                        2,
                        Math.sqrt(MAX_BACKGROUND_AREA / Math.max(1, viewportWidth * viewportHeight)),
                    );
                    const viewportBackground = await renderViewportBackground(library, backgroundScale, task);
                    allocatedCanvases.add(viewportBackground);
                    const firstRect = sizing.rects[0];
                    const chatRect = frozenChatRect || firstRect;
                    const unitHeightCss = Math.max(1, Math.min(viewportHeight - Math.max(0, chatRect.top), chatRect.height || viewportHeight));
                    const unitScale = Math.min(
                        sizing.scale,
                        Math.sqrt(MAX_BACKGROUND_AREA / Math.max(1, sizing.width * unitHeightCss)),
                    );
                    const unit = createCanvas(sizing.width * unitScale, unitHeightCss * unitScale);
                    allocatedCanvases.add(unit);
                    fillCanvas(unit, opaqueColor);
                    const unitContext = unit.getContext('2d');
                    const sourceX = Math.max(0, firstRect.left) * backgroundScale;
                    const sourceY = Math.max(0, chatRect.top) * backgroundScale;
                    const sourceWidth = Math.min(viewportBackground.width - sourceX, sizing.width * backgroundScale);
                    const sourceHeight = Math.min(viewportBackground.height - sourceY, unitHeightCss * backgroundScale);
                    if (sourceWidth > 0 && sourceHeight > 0) {
                        unitContext.drawImage(
                            viewportBackground,
                            sourceX,
                            sourceY,
                            sourceWidth,
                            sourceHeight,
                            0,
                            0,
                            unit.width,
                            unit.height,
                        );
                    } else {
                        fillCanvas(unit, opaqueColor);
                    }
                    const unitHeight = unitHeightCss * sizing.scale;
                    for (let y = 0; y < finalCanvas.height; y += unitHeight) {
                        finalContext.drawImage(unit, 0, y, finalCanvas.width, unitHeight);
                    }
                    releaseCanvas(viewportBackground);
                    releaseCanvas(unit);
                    allocatedCanvases.delete(viewportBackground);
                    allocatedCanvases.delete(unit);
                } catch (error) {
                    task.assertActive();
                    console.warn('[st-toolbox] 当前背景合成失败，使用主题纯色降级：', error);
                    fillCanvas(finalCanvas, opaqueColor);
                }
            } else {
                fillCanvas(finalCanvas, opaqueColor);
            }
        }

        let currentY = 0;
        messageContext = await createMessageContext(library, elements[0], sizing.scale, task);
        for (const [index, element] of elements.entries()) {
            const rect = sizing.rects[index];
            const sectionCanvas = await renderMessage(library, messageContext, element, rect, task);
            allocatedCanvases.add(sectionCanvas);
            try {
                const offsetX = (finalCanvas.width - sectionCanvas.width) / 2;
                finalContext.drawImage(sectionCanvas, offsetX, currentY);
                currentY += rect.height * sizing.scale + gap * sizing.scale;
            } finally {
                releaseCanvas(sectionCanvas);
                allocatedCanvases.delete(sectionCanvas);
            }
        }

        let exportCanvas = finalCanvas;
        if (captureSettings.format === 'jpeg' && captureSettings.backgroundMode === 'transparent') {
            exportCanvas = createCanvas(finalCanvas.width, finalCanvas.height);
            allocatedCanvases.add(exportCanvas);
            fillCanvas(exportCanvas, opaqueColor);
            exportCanvas.getContext('2d').drawImage(finalCanvas, 0, 0);
        }
        const mimeType = `image/${captureSettings.format}`;
        const blob = await canvasToBlob(exportCanvas, mimeType, captureSettings.quality);
        task.assertActive();
        return { blob, extension: captureSettings.format === 'jpeg' ? 'jpg' : captureSettings.format };
        } finally {
            try {
                destroyMessageContext(library, messageContext);
            } finally {
                for (const canvas of allocatedCanvases) releaseCanvas(canvas);
            }
        }
    }

    async function capture(elements, trigger) {
        if (busy) {
            showToast('warning', '已有截图任务正在执行。');
            return;
        }
        const requestedElements = elements.filter(element => element instanceof HTMLElement && element.matches('.mes'));
        if (!requestedElements.length) {
            showToast('warning', '没有可截图的消息。');
            return;
        }

        busy = true;
        closeRangeMenu();
        // 在任何 DOM/样式改动之前先记录滚动位置，全程守护直到截图结束并稳定。
        const scrollGuard = createScrollGuard();
        // 消息按钮本身就是图标（FA 类在 .mes_button 上）；多选入口按钮则内嵌 <i>。
        const triggerIcon = trigger?.querySelector('i') || trigger;
        const iconWasSpinning = triggerIcon?.classList.contains('fa-spin') || false;
        const previousAriaBusy = trigger?.getAttribute('aria-busy');
        if (trigger) {
            trigger.setAttribute('aria-busy', 'true');
            triggerIcon?.classList.add('fa-spin');
            trigger.classList.add('st-toolbox-screenshot-loading');
        }

        let task = null;
        try {
            await waitForCurrentChatReady();
            const chat = document.getElementById('chat');
            const validElements = requestedElements.filter(element => element.isConnected && chat?.contains(element));
            if (validElements.length !== requestedElements.length) {
                showToast('warning', '聊天已切换，原消息不再可用，请在当前聊天重新选择。');
                return;
            }

            const captureSettings = Object.freeze({
                scale: featureSettings.scale,
                format: featureSettings.format,
                quality: featureSettings.quality,
                backgroundMode: featureSettings.backgroundMode,
            });
            const gap = validElements.length > 1 ? 5 : 0;
            const taskId = ++taskGeneration;
            task = {
                id: taskId,
                chatEpoch,
                chat,
                elements: validElements,
                settings: captureSettings,
                geometry: null,
                imageBudget: new Map(),
                lossless: captureSettings.format === 'png',
                failures: new Set(),
            };
            task.assertActive = () => {
                const sourceInvalid = task.elements.some(element => !element.isConnected || !task.chat.contains(element));
                if (task.id !== taskGeneration
                    || task.chatEpoch !== chatEpoch
                    || task.chat !== document.getElementById('chat')
                    || sourceInvalid
                    || !featureSettings.enabled) {
                    throw new Error('截图任务已取消。');
                }
            };
            task.fetchFn = createResourceFetcher(task);
            activeTask = task;

            // 先把懒加载图片加载完，再测量尺寸，否则图片所占高度不会被计入、底部会被裁掉。
            const { restoreLoading, unloaded } = await preloadLazyMedia(validElements, task.assertActive);
            task.restoreLoading = restoreLoading;
            task.assertActive();
            if (unloaded > 0) {
                showToast('warning', `有 ${unloaded} 张图片尚未加载/生成，截图中将显示为当前占位状态。`);
            }
            task.geometry = snapshotCaptureGeometry(validElements, captureSettings.scale, gap);
            task.imageBudget = collectImageBudget(validElements, task.geometry.sizing.scale);

            const { blob, extension } = await buildScreenshot(validElements, task);
            task.assertActive();
            downloadBlob(blob, buildFilename(validElements.length, extension));
            showToast('success', '截图已生成。');
            if (task.failures.size) {
                showToast('warning', `截图已完成，但有 ${task.failures.size} 个外部来源的图片未能嵌入。`);
            }
        } catch (error) {
            const cancelled = error?.message === '截图任务已取消。';
            if (!cancelled && featureSettings.enabled) {
                console.error('[st-toolbox] 截图失败：', error);
                showToast('error', `截图失败：${error?.message || '未知错误'}`);
            }
        } finally {
            if (activeTask === task) activeTask = null;
            try {
                task?.restoreLoading?.();
            } catch { /* ignore */ }
            if (trigger) {
                if (!iconWasSpinning) triggerIcon?.classList.remove('fa-spin');
                if (previousAriaBusy === null) trigger.removeAttribute('aria-busy');
                else trigger.setAttribute('aria-busy', previousAriaBusy);
                trigger.classList.remove('st-toolbox-screenshot-loading');
            }
            busy = false;
            // 完成后继续守护一小段时间（覆盖下载、toast、主题过渡动画等），然后自动解除。
            void scrollGuard.settleAndRelease();
        }
    }

    function showRangeMenu(button, message) {
        closeRangeMenu();
        const menu = document.createElement('div');
        menu.className = RANGE_MENU_CLASS;
        const max = featureSettings.neighborCount;
        for (let count = 1; count <= max; count++) {
            const options = [
                [`当前及前 ${count} 条`, count, 0],
                [`当前及后 ${count} 条`, 0, count],
            ];
            if (count === max) options.push([`前后各 ${count} 条`, count, count]);
            for (const [label, before, after] of options) {
                const item = document.createElement('button');
                item.type = 'button';
                item.textContent = label;
                item.addEventListener('click', event => {
                    event.stopPropagation();
                    void capture(collectAdjacent(message, before, after), button);
                });
                menu.appendChild(item);
            }
        }
        document.body.appendChild(menu);
        const rect = button.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(5, Math.min(window.innerWidth - menuRect.width - 5, rect.right + 5))}px`;
        menu.style.top = `${Math.max(5, Math.min(window.innerHeight - menuRect.height - 5, rect.top - menuRect.height / 2))}px`;
        rangeMenu = menu;
    }

    function getButtonPlacement() {
        return featureSettings.buttonPlacement === 'extra' ? 'extra' : 'inline';
    }

    function addMessageButton(message) {
        const placement = getButtonPlacement();
        const existing = message.querySelector(`.${MESSAGE_BUTTON_CLASS}`);
        if (existing) {
            if (existing.dataset.placement === placement) return;
            existing.remove();
        }
        const container = message.querySelector('.mes_block .mes_buttons');
        if (!container) return;

        // 沿用 ST 原生消息按钮的写法（index.html #message_template）：FontAwesome 类直接放在 .mes_button 上，
        // 这样尺寸/透明度/hover/主题样式与内置按钮完全一致；键盘可访问性（tabindex、Enter 触发）由 ST 的
        // keyboard.js 对 `.mes_buttons .mes_button` 自动处理，无需手动设置。
        const button = document.createElement('div');
        button.className = `${MESSAGE_BUTTON_CLASS} mes_button fa-solid fa-camera`;
        button.title = '单击截图，长按选择相邻消息';
        button.setAttribute('role', 'button');
        button.setAttribute('aria-label', '截图');
        button.dataset.placement = placement;
        let pressTimer = 0;
        let longPressed = false;

        const startPress = event => {
            if (event.type === 'pointerdown' && event.button !== 0) return;
            // 阻止 pointerdown 的默认行为：不让截图按钮抢走焦点（例如从 #send_textarea 移走），
            // 避免焦点变化引起输入框/软键盘/布局变化进而导致聊天区滚动。click 事件不受影响。
            event.preventDefault();
            longPressed = false;
            const startX = event.clientX;
            const startY = event.clientY;
            button.setPointerCapture?.(event.pointerId);
            pressTimer = setTimeout(() => {
                longPressed = true;
                showRangeMenu(button, message);
            }, LONG_PRESS_DURATION);
            const cancelOnMove = moveEvent => {
                if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 10) {
                    cancelPress();
                    button.removeEventListener('pointermove', cancelOnMove);
                }
            };
            button.addEventListener('pointermove', cancelOnMove);
            button.addEventListener('pointerup', () => button.removeEventListener('pointermove', cancelOnMove), { once: true });
            button.addEventListener('pointercancel', () => button.removeEventListener('pointermove', cancelOnMove), { once: true });
        };
        const cancelPress = () => {
            clearTimeout(pressTimer);
            pressTimer = 0;
        };

        button.addEventListener('pointerdown', startPress);
        button.addEventListener('pointerup', cancelPress);
        button.addEventListener('pointercancel', cancelPress);
        button.addEventListener('pointerleave', cancelPress);
        button.addEventListener('click', event => {
            event.stopPropagation();
            if (longPressed) {
                event.preventDefault();
                longPressed = false;
                return;
            }
            void capture([message], button);
        });
        button.addEventListener('keydown', event => {
            // Enter 由 ST keyboard.js 统一转为 click，这里只补上空格键。
            if (event.key === ' ') {
                event.preventDefault();
                void capture([message], button);
            }
        });

        const extraButtons = container.querySelector(':scope > .extraMesButtons');
        if (placement === 'extra' && extraButtons) {
            // 放进“…”展开菜单，与翻译/生图等扩展按钮同组，不占用常驻按钮栏宽度。
            extraButtons.appendChild(button);
        } else {
            container.insertBefore(button, extraButtons || null);
        }
    }

    function getMultiSelectHost(create = false) {
        let container = document.getElementById(MULTI_CONTAINER_ID);
        if (!container && create) {
            const menu = document.getElementById('extensionsMenu');
            if (!menu) return null;
            container = document.createElement('div');
            container.id = MULTI_CONTAINER_ID;
            container.className = 'extension_container';
            menu.appendChild(container);
        }
        return container;
    }

    function exitSelectionMode() {
        selecting = false;
        document.body.classList.remove(SELECTING_CLASS);
        document.querySelectorAll(`.${SELECTED_CLASS}`).forEach(element => element.classList.remove(SELECTED_CLASS));
        document.getElementById(MULTI_CAPTURE_ID)?.remove();
        document.getElementById(MULTI_CANCEL_ID)?.remove();
        document.getElementById(MULTI_START_ID)?.classList.remove('displayNone');
    }

    function enterSelectionMode() {
        if (selecting) return;
        selecting = true;
        document.body.classList.add(SELECTING_CLASS);
        const host = getMultiSelectHost();
        const start = document.getElementById(MULTI_START_ID);
        if (!host || !start) return;
        start.classList.add('displayNone');

        const captureButton = document.createElement('div');
        captureButton.id = MULTI_CAPTURE_ID;
        captureButton.className = 'menu_button';
        captureButton.innerHTML = '<i class="fa-solid fa-camera"></i><span class="menu_button_text"> 生成多选截图</span>';
        captureButton.addEventListener('click', async () => {
            const selected = Array.from(document.querySelectorAll(`#chat .mes.${SELECTED_CLASS}`));
            if (!selected.length) {
                showToast('warning', '请至少选择一条消息。');
                return;
            }
            await capture(selected, captureButton);
            exitSelectionMode();
        });

        const cancelButton = document.createElement('div');
        cancelButton.id = MULTI_CANCEL_ID;
        cancelButton.className = 'menu_button';
        cancelButton.innerHTML = '<i class="fa-solid fa-xmark"></i><span class="menu_button_text"> 取消多选截图</span>';
        cancelButton.addEventListener('click', exitSelectionMode);
        host.append(captureButton, cancelButton);
    }

    function ensureMultiSelectButton() {
        const existing = document.getElementById(MULTI_START_ID);
        if (!featureSettings.enabled || !featureSettings.showMultiSelectButton) {
            existing?.remove();
            if (selecting) exitSelectionMode();
            const container = getMultiSelectHost();
            if (container && !container.children.length) container.remove();
            return;
        }
        if (existing) return;
        const host = getMultiSelectHost(true);
        if (!host) return;
        const button = document.createElement('div');
        button.id = MULTI_START_ID;
        button.className = 'menu_button';
        button.innerHTML = '<i class="fa-solid fa-images"></i><span class="menu_button_text"> 多选截图</span>';
        button.addEventListener('click', enterSelectionMode);
        host.appendChild(button);
    }

    function connectObserver() {
        if (observer && observedChat && !chatSettling) {
            observer.observe(observedChat, { childList: true, subtree: true });
        }
    }

    function refreshUi() {
        observeChat();
        ensureMultiSelectButton();
        if (chatSettling) return;
        observer?.disconnect();
        try {
            if (!featureSettings.enabled || !featureSettings.showMessageButtons) {
                document.querySelectorAll(`.${MESSAGE_BUTTON_CLASS}`).forEach(button => button.remove());
            } else {
                document.querySelectorAll('#chat .mes').forEach(addMessageButton);
            }
        } finally {
            connectObserver();
        }
    }

    function scheduleRefresh() {
        if (refreshFrame) return;
        refreshFrame = requestAnimationFrame(() => {
            refreshFrame = 0;
            refreshUi();
        });
    }

    function handleChatMutations(mutations) {
        if (activeTask && activeTask.elements.some(source => !source.isConnected || !activeTask.chat.contains(source))) {
            invalidateTask();
        }

        const addedMessages = [];
        let removedMessage = false;
        for (const mutation of mutations) {
            for (const node of mutation.removedNodes) {
                if (node instanceof Element && (node.matches('.mes') || node.querySelector?.('.mes'))) {
                    removedMessage = true;
                }
            }
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches('.mes')) addedMessages.push(node);
                node.querySelectorAll?.('.mes').forEach(message => addedMessages.push(message));
            }
        }

        if (removedMessage || addedMessages.length > 1) {
            beginChatSettlement();
            return;
        }
        if (chatSettling || !featureSettings.enabled || !featureSettings.showMessageButtons) return;

        observer?.disconnect();
        try {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element) || node.classList.contains(MESSAGE_BUTTON_CLASS)) continue;
                    if (node.matches('.mes')) addMessageButton(node);
                    node.querySelectorAll?.('.mes').forEach(addMessageButton);
                    const message = node.closest?.('.mes');
                    if (message && node.matches?.('.mes_buttons, .mes_block')) addMessageButton(message);
                }
            }
        } finally {
            connectObserver();
        }
    }

    function observeChat() {
        const chat = document.getElementById('chat');
        if (chat !== observedChat) {
            observer?.disconnect();
            observedChat = chat;
            observer = chat ? new MutationObserver(handleChatMutations) : null;
            chat?.addEventListener('click', event => {
                if (!selecting) return;
                const message = event.target.closest('.mes');
                if (!message) return;
                event.preventDefault();
                event.stopPropagation();
                message.classList.toggle(SELECTED_CLASS);
            }, true);
        }
        connectObserver();
    }

    function updateSettingsControls() {
        if (!controls) return;
        controls.enabled.checked = featureSettings.enabled;
        controls.messageButtons.checked = featureSettings.showMessageButtons;
        controls.buttonPlacement.value = getButtonPlacement();
        controls.multiSelect.checked = featureSettings.showMultiSelectButton;
        controls.scale.value = String(featureSettings.scale);
        controls.scaleValue.textContent = String(featureSettings.scale);
        controls.format.value = featureSettings.format;
        controls.quality.value = String(Math.round(featureSettings.quality * 100));
        controls.qualityValue.textContent = controls.quality.value;
        controls.background.value = featureSettings.backgroundMode;
        controls.neighborCount.value = String(featureSettings.neighborCount);

        const enabled = featureSettings.enabled;
        controls.messageButtons.disabled = !enabled;
        controls.buttonPlacement.disabled = !enabled || !featureSettings.showMessageButtons;
        controls.multiSelect.disabled = !enabled;
        controls.scale.disabled = !enabled;
        controls.format.disabled = !enabled;
        controls.quality.disabled = !enabled || featureSettings.format === 'png';
        controls.background.disabled = !enabled;
        controls.neighborCount.disabled = !enabled || !featureSettings.showMessageButtons;
    }

    function bindSettings() {
        controls.enabled.addEventListener('change', () => {
            featureSettings.enabled = controls.enabled.checked;
            if (!featureSettings.enabled) {
                invalidateTask();
                closeRangeMenu();
                exitSelectionMode();
            }
            saveSettings();
            updateSettingsControls();
            scheduleRefresh();
        });
        controls.messageButtons.addEventListener('change', () => {
            featureSettings.showMessageButtons = controls.messageButtons.checked;
            saveSettings();
            updateSettingsControls();
            scheduleRefresh();
        });
        controls.buttonPlacement.addEventListener('change', () => {
            featureSettings.buttonPlacement = controls.buttonPlacement.value === 'extra' ? 'extra' : 'inline';
            saveSettings();
            scheduleRefresh();
        });
        controls.multiSelect.addEventListener('change', () => {
            featureSettings.showMultiSelectButton = controls.multiSelect.checked;
            saveSettings();
            updateSettingsControls();
            scheduleRefresh();
        });
        controls.scale.addEventListener('input', () => {
            featureSettings.scale = Number(controls.scale.value);
            controls.scaleValue.textContent = controls.scale.value;
            saveSettings();
        });
        controls.format.addEventListener('change', () => {
            featureSettings.format = controls.format.value;
            saveSettings();
            updateSettingsControls();
        });
        controls.quality.addEventListener('input', () => {
            featureSettings.quality = Number(controls.quality.value) / 100;
            controls.qualityValue.textContent = controls.quality.value;
            saveSettings();
        });
        controls.background.addEventListener('change', () => {
            featureSettings.backgroundMode = controls.background.value;
            saveSettings();
        });
        controls.neighborCount.addEventListener('change', () => {
            featureSettings.neighborCount = Number(controls.neighborCount.value);
            saveSettings();
        });
    }

    function invalidateTask() {
        taskGeneration += 1;
    }

    function onChatChanged() {
        chatEpoch += 1;
        invalidateTask();
        closeRangeMenu();
        exitSelectionMode();
        beginChatSettlement();
    }

    function onCharacterMessageRendered() {
        scheduleRefresh();
    }

    function init() {
        eventSource.on(eventTypes.APP_READY, beginChatSettlement);
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
        eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
        // 用户消息、swipe、编辑、“加载更多”等都会重建/新增 .mes，一并触发按钮补挂（scheduleRefresh 按帧合并，开销徽小）。
        for (const name of ['USER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MORE_MESSAGES_LOADED']) {
            if (eventTypes[name]) eventSource.on(eventTypes[name], scheduleRefresh);
        }
        eventSource.on(eventTypes.SETTINGS_LOADED, scheduleRefresh);
        document.addEventListener('click', event => {
            if (rangeMenu && !rangeMenu.contains(event.target)) closeRangeMenu();
        });
        window.addEventListener('resize', closeRangeMenu);
        window.addEventListener('pagehide', () => {
            for (const url of pendingDownloadUrls) URL.revokeObjectURL(url);
            pendingDownloadUrls.clear();
        });
        if (featureSettings.enabled) {
            void ensureLibrary().catch(error => console.warn('[st-toolbox] 截图库预加载失败，将在使用时重试：', error));
        }
        beginChatSettlement();
    }

    function renderSettings(container) {
        const section = document.createElement('section');
        section.className = 'st-toolbox-section st-toolbox-screenshot-settings';
        section.innerHTML = `
            <label class="checkbox_label"><input id="st-toolbox-screenshot-enabled" type="checkbox"><span>启用截图功能</span></label>
            <label class="checkbox_label"><input id="st-toolbox-screenshot-message-buttons" type="checkbox"><span>在每条消息上显示截图按钮</span></label>
            <label class="st-toolbox-screenshot-field">截图按钮位置
                <select id="st-toolbox-screenshot-button-placement" class="text_pole">
                    <option value="inline">常驻按钮栏（编辑按钮旁）</option>
                    <option value="extra">“…”展开菜单内（节省按钮栏空间）</option>
                </select>
            </label>
            <label class="checkbox_label"><input id="st-toolbox-screenshot-multi-select" type="checkbox"><span>在扩展菜单显示多选截图入口</span></label>
            <label class="st-toolbox-screenshot-field">
                <span class="st-toolbox-screenshot-label-line">
                    <span class="st-toolbox-screenshot-label-title">截图倍率 <i class="fa-solid fa-circle-question st-toolbox-setting-hint" title="控制输出分辨率：2× 会让宽和高各变为 2 倍。倍率越高越清晰，但截图更慢、占用内存更多。" aria-label="截图倍率说明"></i></span>
                    <span><output id="st-toolbox-screenshot-scale-value"></output>×</span>
                </span>
                <input id="st-toolbox-screenshot-scale" type="range" min="1" max="3" step="0.25">
            </label>
            <label class="st-toolbox-screenshot-field">图片格式
                <select id="st-toolbox-screenshot-format" class="text_pole"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select>
            </label>
            <label class="st-toolbox-screenshot-field">
                <span class="st-toolbox-screenshot-label-line">
                    <span class="st-toolbox-screenshot-label-title">图片质量 <i class="fa-solid fa-circle-question st-toolbox-setting-hint" title="仅影响 JPEG/WebP 的压缩质量：数值越高细节越完整、文件越大。PNG 为无损格式，不受此设置影响。" aria-label="图片质量说明"></i></span>
                    <span><output id="st-toolbox-screenshot-quality-value"></output>%</span>
                </span>
                <input id="st-toolbox-screenshot-quality" type="range" min="10" max="100" step="1">
            </label>
            <label class="st-toolbox-screenshot-field">背景模式
                <select id="st-toolbox-screenshot-background" class="text_pole">
                    <option value="current">当前 SillyTavern 背景（保证不透明）</option>
                    <option value="solid">主题纯色（保证不透明）</option>
                    <option value="transparent">透明背景</option>
                </select>
            </label>
            <label class="st-toolbox-screenshot-field">长按菜单最大相邻消息数
                <select id="st-toolbox-screenshot-neighbor-count" class="text_pole"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select>
            </label>
            <p class="st-toolbox-help">当前背景模式会显式合成 #bg1、Moonlit 的 #sheld::before 遮罩和 #chat 色层；即使背景图片读取失败，也会使用不透明主题底色，不会导出透明图片。复杂的消息内 backdrop-filter 会采用近似效果。JPEG 不支持透明，选择透明模式时会自动铺主题底色。</p>
        `;
        const find = selector => section.querySelector(selector);
        controls = {
            enabled: find('#st-toolbox-screenshot-enabled'),
            messageButtons: find('#st-toolbox-screenshot-message-buttons'),
            buttonPlacement: find('#st-toolbox-screenshot-button-placement'),
            multiSelect: find('#st-toolbox-screenshot-multi-select'),
            scale: find('#st-toolbox-screenshot-scale'),
            scaleValue: find('#st-toolbox-screenshot-scale-value'),
            format: find('#st-toolbox-screenshot-format'),
            quality: find('#st-toolbox-screenshot-quality'),
            qualityValue: find('#st-toolbox-screenshot-quality-value'),
            background: find('#st-toolbox-screenshot-background'),
            neighborCount: find('#st-toolbox-screenshot-neighbor-count'),
        };
        bindSettings();
        updateSettingsControls();
        container.appendChild(section);
    }

    function syncSettings() {
        if (!featureSettings.enabled) {
            invalidateTask();
            closeRangeMenu();
            exitSelectionMode();
        }
        updateSettingsControls();
        scheduleRefresh();
    }

    return { init, renderSettings, syncSettings };
}
