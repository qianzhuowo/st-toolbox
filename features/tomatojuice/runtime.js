var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// core/backend-client.js
async function discoverBackend({ refresh: refresh2 = false } = {}) {
  if (!discovery || refresh2) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3e3);
    discovery = fetch(`${PREFIX}/capabilities`, { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async (res) => res.ok ? res.json() : null).catch(() => null).finally(() => clearTimeout(timeout));
  }
  return discovery;
}
function moduleUrl(module, route = "") {
  if (!/^[a-z][a-z0-9-]*$/.test(module) || !route.startsWith("/")) throw new Error("Invalid module route");
  return `${PREFIX}/modules/${module}${route}`;
}
async function backendRequest(module, route, body = {}, { signal } = {}) {
  const ctx = globalThis.SillyTavern?.getContext?.();
  const res = await fetch(moduleUrl(module, route), { method: "POST", credentials: "same-origin", headers: ctx?.getRequestHeaders?.() || { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message = typeof detail?.error === "string" ? `\uFF1A${detail.error.slice(0, 500)}` : "";
    throw Object.assign(new Error(`Backend ${module}${route}: HTTP ${res.status}${message}`), { status: res.status });
  }
  return res.json();
}
var PREFIX, discovery;
var init_backend_client = __esm({
  "core/backend-client.js"() {
    PREFIX = "/api/plugins/st-toolbox-server";
  }
});

// features/tomatojuice/client/constants.ts
var API_PREFIX, FETCH_OBSERVER_FLAG;
var init_constants = __esm({
  "features/tomatojuice/client/constants.ts"() {
    API_PREFIX = "/api/plugins/st-toolbox-server/modules/tomatojuice";
    FETCH_OBSERVER_FLAG = "__tomatojuiceFetchObserverInstalled";
  }
});

// features/tomatojuice/client/st-context.ts
function getCtx() {
  try {
    return globalThis.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}
function saveSettings() {
  try {
    getCtx()?.saveSettingsDebounced?.();
  } catch {
  }
}
function log(_message, _extra) {
}
var init_st_context = __esm({
  "features/tomatojuice/client/st-context.ts"() {
  }
});

// features/tomatojuice/client/state.ts
var DEFAULT_LOCAL_SETTINGS, DEFAULT_UPDATE_STATUS, state;
var init_state = __esm({
  "features/tomatojuice/client/state.ts"() {
    DEFAULT_LOCAL_SETTINGS = {
      autoRegisterServiceWorker: false,
      autoWarm: true,
      autoRefreshCharactersAfterAsyncMiss: true,
      autoCheckUpdates: false,
      skippedUpdateVersion: ""
    };
    DEFAULT_UPDATE_STATUS = {
      checking: false,
      checked: false,
      frontendCurrentVersion: null,
      frontendLatestVersion: null,
      frontendUpdateAvailable: false,
      backendCurrentVersion: null,
      backendLatestVersion: null,
      backendUpdateAvailable: false,
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      error: null,
      lastCheckedAt: null
    };
    state = {
      backend: null,
      update: { ...DEFAULT_UPDATE_STATUS },
      sw: {
        supported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
        registered: false,
        controlled: false,
        scriptURL: "",
        scope: ""
      },
      browserLogs: null,
      busy: false,
      localSettings: { ...DEFAULT_LOCAL_SETTINGS }
    };
  }
});

// features/tomatojuice/client/settings.ts
var settings_exports = {};
__export(settings_exports, {
  ensureLocalSettings: () => ensureLocalSettings,
  updateLocalBool: () => updateLocalBool,
  updateLocalString: () => updateLocalString
});
function ensureLocalSettings() {
  const ctx = getCtx();
  const root = ctx?.extensionSettings;
  if (!root) return state.localSettings;
  root["st-toolbox"] ||= {};
  root["st-toolbox"].tomatojuice ||= {};
  const tomatojuice = root["st-toolbox"].tomatojuice;
  tomatojuice.backend ||= { ...root["cocktail-plus"] || {} };
  const s = tomatojuice.backend;
  for (const [k, v] of Object.entries(DEFAULT_LOCAL_SETTINGS)) {
    if (s[k] === void 0) s[k] = v;
  }
  s.autoRegisterServiceWorker = Boolean(s.autoRegisterServiceWorker);
  s.autoWarm = Boolean(s.autoWarm);
  s.autoRefreshCharactersAfterAsyncMiss = Boolean(s.autoRefreshCharactersAfterAsyncMiss);
  s.autoCheckUpdates = Boolean(s.autoCheckUpdates);
  s.skippedUpdateVersion = String(s.skippedUpdateVersion ?? "").trim();
  state.localSettings = s;
  return s;
}
function updateLocalBool(key, value) {
  const s = ensureLocalSettings();
  s[key] = Boolean(value);
  state.localSettings = s;
  saveSettings();
}
function updateLocalString(key, value) {
  const s = ensureLocalSettings();
  s[key] = String(value ?? "");
  state.localSettings = s;
  saveSettings();
}
var init_settings = __esm({
  "features/tomatojuice/client/settings.ts"() {
    init_st_context();
    init_state();
  }
});

// features/tomatojuice/client/cache-policy.ts
function cacheEnabled(endpoint) {
  return state.backend?.ok === true && state.backend.readPolicy?.endpoints?.[endpoint]?.enabled === true;
}
function applyReadPolicy() {
  const disabled = {
    enabled: false,
    endpoints: {
      "characters-all": { enabled: false, timeoutMs: 2e3 },
      version: { enabled: false, timeoutMs: 2e3 }
    }
  };
  const bridge = globalThis.__tomatojuiceEarlyBridge;
  bridge?.updatePolicy?.(state.backend?.ok ? state.backend.readPolicy || disabled : disabled);
}
var init_cache_policy = __esm({
  "features/tomatojuice/client/cache-policy.ts"() {
    init_state();
  }
});

// features/tomatojuice/client/service-worker.ts
function getServiceWorkerScriptURL(reg) {
  return reg.active?.scriptURL || reg.waiting?.scriptURL || reg.installing?.scriptURL || "";
}
function isOurRegistration(reg) {
  const scriptURL = getServiceWorkerScriptURL(reg);
  try {
    const url = new URL(scriptURL);
    return url.origin === location.origin && url.pathname === `${API_PREFIX}/sw.js`;
  } catch {
    return false;
  }
}
async function refreshServiceWorkerState() {
  state.sw.supported = "serviceWorker" in navigator;
  state.sw.registered = false;
  state.sw.controlled = Boolean(navigator.serviceWorker?.controller);
  state.sw.scriptURL = "";
  state.sw.scope = "";
  if (!state.sw.supported) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  const reg = regs.find(isOurRegistration);
  if (reg) {
    state.sw.registered = true;
    state.sw.scriptURL = getServiceWorkerScriptURL(reg);
    state.sw.scope = reg.scope;
  }
}
async function inspectMigrationWorkers() {
  if (!navigator.serviceWorker?.getRegistrations) return [];
  const registrations = await navigator.serviceWorker.getRegistrations();
  return registrations.flatMap((registration) => {
    const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
    const urls = workers.map((worker) => worker.scriptURL);
    const recognized = urls.length > 0 && urls.every((value) => {
      try {
        const url = new URL(value);
        return url.origin === location.origin && (url.pathname === "/api/plugins/cocktail-plus/sw.js" || url.pathname === API_PREFIX + "/sw.js");
      } catch {
        return false;
      }
    });
    return recognized ? [{ registration, urls }] : [];
  });
}
async function cleanupMigrationWorkers() {
  const entries = await inspectMigrationWorkers();
  if (!entries.length) return "\u672A\u53D1\u73B0\u53EF\u8BC6\u522B\u7684 cocktail-plus / tomatojuice SW\u3002\u5176\u4ED6 SW \u4E0D\u4F1A\u6E05\u7406\u3002";
  if (!globalThis.confirm("\u4EC5\u6CE8\u9500\u4EE5\u4E0B\u540C\u6E90\u5DF2\u8BC6\u522B SW\uFF0C\u4E0D\u4F1A\u6E05\u7406\u5176\u4ED6 SW \u6216\u7F13\u5B58\u3002\u8BF7\u5148\u4FDD\u5B58\u5DE5\u4F5C\uFF0C\u5B8C\u6210 HTML \u4FEE\u590D\u540E\u518D\u5237\u65B0\u3002\n" + entries.flatMap((entry) => entry.urls).join("\n"))) return "\u5DF2\u53D6\u6D88";
  let count = 0;
  for (const entry of entries) if (await entry.registration.unregister()) count++;
  return "\u5DF2\u6CE8\u9500 " + count + " \u4E2A\u5DF2\u8BC6\u522B SW\uFF1B\u5F53\u524D\u9875\u9762\u53EF\u80FD\u4ECD\u53D7\u63A7\uFF0C\u4FDD\u5B58\u5DE5\u4F5C\u5E76\u5B8C\u6210 HTML \u4FEE\u590D\u540E\u5237\u65B0\u3002";
}
var init_service_worker = __esm({
  "features/tomatojuice/client/service-worker.ts"() {
    init_constants();
    init_st_context();
    init_state();
  }
});

// features/tomatojuice/client/api.ts
var api_exports = {};
__export(api_exports, {
  clearBrowserLogs: () => clearBrowserLogs,
  clearCache: () => clearCache,
  fullProbe: () => fullProbe,
  postJson: () => postJson,
  probeBackend: () => probeBackend,
  refreshBrowserLogs: () => refreshBrowserLogs,
  refreshStatus: () => refreshStatus,
  warm: () => warm
});
async function postJson(url, body = {}, options = {}) {
  if (!url.startsWith(API_PREFIX + "/")) throw new Error("Invalid tomatojuice backend route");
  return backendRequest("tomatojuice", url.slice(API_PREFIX.length), body, options);
}
async function probeBackend() {
  try {
    state.backend = await postJson(`${API_PREFIX}/probe`);
  } catch (error) {
    state.backend = null;
    console.info("[tomatojuice] \u53EF\u9009\u540E\u7AEF\u4E0D\u53EF\u7528\uFF0C\u4FDD\u7559\u539F\u751F\u8BF7\u6C42", String(error));
  }
  applyReadPolicy();
}
async function warm(wait = false) {
  const endpoints = ["characters-all", "version"].filter(cacheEnabled);
  if (!endpoints.length) return { ok: true, skipped: true, reason: "cache-disabled-or-unavailable" };
  const result = await postJson(`${API_PREFIX}/warm`, { endpoints, wait });
  await refreshStatus();
  return result;
}
async function clearCache() {
  const result = await postJson(`${API_PREFIX}/cache/clear`, { endpoints: ["characters-all", "version"] });
  await refreshStatus();
  return result;
}
async function refreshStatus() {
  await refreshServiceWorkerState();
  if (state.backend) state.backend = { ...state.backend, ...await postJson(`${API_PREFIX}/status`) };
  applyReadPolicy();
}
async function fullProbe() {
  await Promise.allSettled([probeBackend(), refreshServiceWorkerState()]);
}
async function refreshBrowserLogs(limit = 1e3) {
  if (!state.backend?.ok) return null;
  const result = await postJson(`${API_PREFIX}/browser-logs/list`, { limit });
  state.browserLogs = result;
  return result;
}
async function clearBrowserLogs() {
  await postJson(`${API_PREFIX}/browser-logs/clear`);
  await refreshBrowserLogs();
}
var init_api = __esm({
  "features/tomatojuice/client/api.ts"() {
    init_backend_client();
    init_constants();
    init_service_worker();
    init_state();
    init_cache_policy();
  }
});

// features/tomatojuice/client/index.ts
init_backend_client();
init_constants();
init_settings();
init_state();
init_cache_policy();
init_api();

// features/tomatojuice/client/fetch-observer.ts
init_constants();

// features/tomatojuice/client/characters-refresh.ts
init_constants();
init_st_context();
init_cache_policy();
var pending;
var refreshing = false;
var repeat = false;
function scheduleCharactersRefresh(source) {
  clearTimeout(pending);
  pending = setTimeout(() => {
    void refresh(source);
  }, 250);
}
async function refresh(source) {
  if (refreshing) {
    repeat = true;
    return;
  }
  refreshing = true;
  try {
    if (cacheEnabled("characters-all")) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2e3);
      try {
        const { postJson: postJson2 } = await Promise.resolve().then(() => (init_api(), api_exports));
        await postJson2(`${API_PREFIX}/invalidate`, { endpoints: ["characters-all"], reason: source }, { signal: controller.signal });
        await postJson2(`${API_PREFIX}/warm`, { endpoints: ["characters-all"], wait: false }, { signal: controller.signal });
      } catch (error) {
        console.warn("[tomatojuice] \u53EF\u9009\u89D2\u8272\u7F13\u5B58\u51C6\u5907\u5931\u8D25\uFF0C\u7EE7\u7EED\u539F\u751F\u5237\u65B0", error);
      } finally {
        clearTimeout(timer);
      }
    }
    const mod = await import(
      /* @vite-ignore */
      "/script.js"
    );
    if (typeof mod.getCharacters !== "function") throw new Error("Core getCharacters export not available");
    await mod.getCharacters();
    log("\u89D2\u8272\u5217\u8868\u5DF2\u66F4\u65B0", { source });
  } catch (error) {
    console.warn("[tomatojuice] \u89D2\u8272\u5217\u8868\u5237\u65B0\u5931\u8D25\uFF0C\u53EF\u4F7F\u7528\u9152\u9986\u539F\u751F\u5237\u65B0", error);
  } finally {
    refreshing = false;
    if (repeat) {
      repeat = false;
      scheduleCharactersRefresh("queued-mutation");
    }
  }
}

// features/tomatojuice/client/fetch-observer.ts
var mutations = /* @__PURE__ */ new Set(["create", "import", "edit", "edit-attribute", "delete", "rename", "duplicate", "merge-attributes"]);
function installFetchObserver() {
  if (globalThis[FETCH_OBSERVER_FLAG]) return;
  globalThis[FETCH_OBSERVER_FLAG] = true;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const response = await baseFetch.call(this, input, init);
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin !== location.origin || method !== "POST" || !response.ok) return response;
      const mutation = url.pathname.startsWith("/api/characters/") && mutations.has(url.pathname.split("/").pop() || "") || url.pathname.endsWith("/modules/tomatojuice/fast/characters-edit");
      if (mutation) scheduleCharactersRefresh(url.pathname);
    } catch (error) {
      console.warn("[tomatojuice] \u89D2\u8272\u5199\u5165\u89C2\u5BDF\u5931\u8D25", error);
    }
    return response;
  };
}

// features/tomatojuice/client/panel.ts
init_state();
init_settings();
init_api();
function renderPanel(host) {
  const root = host || document.getElementById("tomatojuice-backend-panel");
  if (!root) return;
  root.replaceChildren();
  root.classList.add("st-toolbox-backend-panel");
  const status2 = document.createElement("p");
  status2.textContent = state.backend?.ok ? "st-toolbox-server\uFF1A\u53EF\u7528\uFF1B\u7F13\u5B58\u6309\u7528\u6237\u6301\u4E45\u5316\u3001\u6309\u6587\u4EF6\u7B7E\u540D\u5931\u6548\u3002" : "\u540E\u7AEF\u672A\u5B89\u88C5\uFF1A\u4F7F\u7528\u9152\u9986\u539F\u751F\u8BF7\u6C42\uFF0C\u524D\u7AEF\u4F18\u5316\u4ECD\u53EF\u4F7F\u7528\u3002";
  root.append(status2);
  const note = document.createElement("p");
  note.textContent = "\u9ED8\u8BA4\u4FDD\u7559\u539F\u751F\u6A21\u5757\u4E0E\u4FDD\u5B58\u8BF7\u6C42\uFF1B\u53EF\u9009\u6865\u63A5\u4EC5\u52A0\u901F\u53EA\u8BFB\u8BF7\u6C42\uFF0C\u9650\u65F6\u5931\u8D25\u56DE\u9000\u3002\u65E0\u9700\u6CE8\u518C SW\u3002\u540E\u7AEF\u624B\u52A8\u66F4\u65B0\uFF0C\u4E0D\u6267\u884C\u670D\u52A1\u5668\u547D\u4EE4\u3002";
  root.append(note);
  const advanced = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "\u7F13\u5B58\u4E0E\u8BCA\u65AD\uFF08\u9AD8\u7EA7\uFF09";
  advanced.append(summary);
  root.append(advanced);
  const actions = document.createElement("div");
  actions.className = "st-toolbox-backend-actions";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "\u540E\u7AEF\u4E0E\u7F13\u5B58\u64CD\u4F5C");
  advanced.append(actions);
  const result = document.createElement("pre");
  result.className = "st-toolbox-backend-result";
  result.style.cssText = "max-height:24em;overflow:auto;white-space:pre-wrap";
  const show = () => {
    result.textContent = JSON.stringify({ cache: state.backend?.status, settingsGet: state.backend?.settingsGet, settingsSave: state.backend?.settingsSave, chatSave: state.backend?.chatSave, sw: state.sw }, null, 2);
  };
  const add = (text, action, backend = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu_button";
    button.textContent = text;
    button.disabled = backend && !state.backend?.ok;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const output = await action();
        if (typeof output === "string") result.textContent = output;
        else show();
      } catch (error) {
        result.textContent = String(error);
      } finally {
        button.disabled = backend && !state.backend?.ok;
      }
    });
    actions.append(button);
  };
  add("\u91CD\u65B0\u68C0\u6D4B", async () => {
    await fullProbe();
    renderPanel(root);
  });
  add("\u9884\u70ED\uFF08\u4E0D\u5F3A\u5236\u91CD\u5EFA\uFF09", () => warm(true), true);
  add("\u6E05\u7406\u5F53\u524D\u7528\u6237\u7F13\u5B58", () => clearCache(), true);
  add("\u5237\u65B0\u72B6\u6001", () => refreshStatus(), true);
  add("\u8BFB\u53D6\u5F53\u524D\u7528\u6237\u65E5\u5FD7", async () => {
    const logs = await refreshBrowserLogs();
    return logs?.text || "\u65E0\u65E5\u5FD7\uFF08\u9ED8\u8BA4\u4E0D\u91C7\u96C6\u6D4F\u89C8\u5668\u5168\u5C40\u65E5\u5FD7\uFF09";
  }, true);
  add("\u6E05\u7406\u5F53\u524D\u7528\u6237\u65E5\u5FD7", () => clearBrowserLogs(), true);
  const settings = ensureLocalSettings();
  const label = document.createElement("label");
  label.className = "checkbox_label";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = settings.autoWarm;
  checkbox.addEventListener("change", async () => {
    const { updateLocalBool: updateLocalBool2 } = await Promise.resolve().then(() => (init_settings(), settings_exports));
    updateLocalBool2("autoWarm", checkbox.checked);
  });
  label.append(checkbox, " \u542F\u52A8\u65F6\u8865\u5145\u9884\u70ED\uFF08\u6709\u6548\u7F13\u5B58\u4E0D\u91CD\u5EFA\uFF09");
  advanced.append(label);
  advanced.append(result);
  show();
}

// features/tomatojuice/client/early-management.ts
init_service_worker();
init_backend_client();
var status = {
  phase: "unchecked",
  management: null,
  busy: false,
  message: "",
  reloadNeeded: false
};
var views = /* @__PURE__ */ new Map();
function publish() {
  for (const [node, render] of views) {
    if (!node.isConnected) views.delete(node);
    else render();
  }
}
function accept(reply) {
  if (!reply?.ok || !reply.management || typeof reply.management.canManage !== "boolean" || typeof reply.management.installed !== "boolean") {
    throw new Error("\u540E\u7AEF\u7BA1\u7406\u72B6\u6001\u683C\u5F0F\u4E0D\u517C\u5BB9\uFF0C\u8BF7\u66F4\u65B0 st-toolbox-server\u3002");
  }
  status.management = reply.management;
  status.phase = "ready";
}
async function check() {
  if (status.busy) return;
  status.busy = true;
  status.message = "";
  publish();
  try {
    const info = await discoverBackend({ refresh: true });
    const module = info?.modules?.find((entry) => entry.id === "tomatojuice");
    status.management = null;
    if (!info || !module) status.phase = "missing";
    else if (info.protocol !== 1 || !module.capabilities?.includes("early-management")) status.phase = "unsupported";
    else accept(await backendRequest("tomatojuice", "/early/manage/status"));
  } catch (error) {
    status.phase = "error";
    status.message = String(error);
  } finally {
    status.busy = false;
    publish();
  }
}
async function change(action, blockedReason) {
  const current = status.management;
  if (status.busy || status.phase !== "ready" || !current?.canManage) return;
  if (action === "install" && (blockedReason || current.conflict)) return;
  if (action === "uninstall" && !current.installed) return;
  const explanation = action === "cleanup-legacy" ? "\u786E\u8BA4\u5907\u4EFD\u5E76\u79FB\u9664\u53EF\u8BC6\u522B cocktail-plus HTML \u5165\u53E3\u3001\u6062\u590D\u539F\u751F\u6A21\u5757URL\uFF1F\u5F02\u5E38\u7ED3\u6784\u4F1A\u62D2\u7EDD\u4FEE\u6539\u3002\u4E0D\u4F1A\u6CE8\u9500SW\u3001\u505C\u7528\u65E7\u524D\u7AEF\u6216\u5237\u65B0\u9875\u9762\u3002" : action === "install" ? "\u5B89\u88C5\uFF0F\u4FEE\u590D\u9996\u5C4F\u63A5\u5165\u5C06\u4FEE\u6539\u9152\u9986 public/index.html\uFF0C\u5F71\u54CD\u6B64\u670D\u52A1\u5668\u7684\u6240\u6709\u7528\u6237\u3002\u4F1A\u5148\u81EA\u52A8\u5907\u4EFD\uFF0C\u518D\u6DFB\u52A0\u53EF\u5931\u8D25\u7684\u5F02\u6B65\u53EA\u8BFB\u6865\u63A5\uFF1B\u4FDD\u7559\u539F\u751F\u6838\u5FC3\u6A21\u5757\u5165\u53E3\u3002\u4E0D\u6267\u884C\u7CFB\u7EDF\u547D\u4EE4\uFF0C\u4E5F\u4E0D\u81EA\u52A8\u5237\u65B0\u9875\u9762\u3002\n\n\u786E\u8BA4\u7EE7\u7EED\uFF1F" : "\u64A4\u9500\u5C06\u79FB\u9664 public/index.html \u4E2D\u5C5E\u4E8E Tomatojuice \u7684\u9996\u5C4F\u5165\u53E3\u4E0E\u6A21\u5757\u6620\u5C04\uFF0C\u5F71\u54CD\u6240\u6709\u7528\u6237\u3002\u4F1A\u5148\u5907\u4EFD\u5E76\u4FDD\u7559\u5176\u4ED6\u7F16\u8F91\uFF1B\u4E0D\u4F1A\u6CE8\u9500 SW \u6216\u505C\u6B62\u5F53\u524D\u9875\u9762\u5DF2\u52A0\u8F7D\u7684\u4EE3\u7801\u3002\n\n\u786E\u8BA4\u7EE7\u7EED\uFF1F";
  if (!globalThis.confirm(explanation)) return;
  status.busy = true;
  status.message = "";
  publish();
  try {
    const reply = await backendRequest("tomatojuice", `/early/${action}`, { confirm: true });
    accept(reply);
    status.reloadNeeded = true;
    status.message = `${reply.changed ? action === "install" ? "\u9996\u5C4F\u63A5\u5165\u5DF2\u5B89\u88C5\uFF0F\u4FEE\u590D\u3002" : "\u9996\u5C4F\u63A5\u5165\u5DF2\u64A4\u9500\u3002" : "\u5165\u53E3\u5DF2\u5904\u4E8E\u76EE\u6807\u72B6\u6001\uFF0C\u65E0\u9700\u91CD\u590D\u4FEE\u6539\u3002"}${reply.backupCreated ? "\u5DF2\u4FDD\u5B58 HTML \u5907\u4EFD\u3002" : ""}\u8BF7\u4FDD\u5B58\u5F53\u524D\u5DE5\u4F5C\u540E\u5237\u65B0\u9875\u9762\u3002${action === "uninstall" ? "\u82E5\u6CE8\u518C\u8FC7 Tomatojuice SW\uFF0C\u8BF7\u53E6\u884C\u6CE8\u9500\u3002" : ""}`;
  } catch (error) {
    status.phase = "error";
    status.message = `\u64CD\u4F5C\u672A\u786E\u8BA4\u6210\u529F\uFF1A${String(error)}\u3002\u8BF7\u5148\u70B9\u51FB\u201C\u68C0\u67E5\u9996\u5C4F\u72B6\u6001\u201D\uFF0C\u4E0D\u8981\u76F2\u76EE\u91CD\u590D\u63D0\u4EA4\u3002`;
  } finally {
    status.busy = false;
    publish();
  }
}
function renderEarlyManagement(host, { installBlockedReason = "" } = {}) {
  const root = document.createElement("section");
  root.className = "st-toolbox-feature-body tomatojuice-early-management";
  root.dataset.tomatojuiceEarlyManagement = "true";
  host.append(root);
  const title = document.createElement("h4");
  title.textContent = "\u8FC1\u79FB\u8BCA\u65AD\u4E0E\u53EF\u9009\u53EA\u8BFB\u52A0\u901F";
  const description = document.createElement("p");
  description.textContent = "\u65E0\u9700\u5B89\u88C5\u5165\u53E3\u6216\u6CE8\u518C SW \u5373\u53EF\u4F7F\u7528\u9152\u9986\u3002\u53EF\u9009\u6865\u63A5\u4EC5\u52A0\u901F\u53EA\u8BFB\u8BF7\u6C42\uFF0C\u5931\u8D25\u9650\u65F6\u56DE\u9000\u539F\u751F\uFF1B\u4E0D\u518D\u4EE3\u7406\u6838\u5FC3\u6A21\u5757\u6216\u4FDD\u5B58\u8BF7\u6C42\u3002\u8FC1\u79FB\u987A\u5E8F\uFF1A\u505C\u7528\u65E7\u524D\u7AEF \u2192 \u5907\u4EFD\u4FEE\u590D HTML \u2192 \u6CE8\u9500\u5DF2\u8BC6\u522B SW \u2192 \u4FDD\u5B58\u540E\u5237\u65B0\u3002\u5DF2\u635F\u574F\u9875\u9762\u65E0\u6CD5\u8FDB\u5165\u6B64\u9762\u677F\u65F6\u8BF7\u4F7F\u7528\u968F\u9644\u79BB\u7EBF CLI\u3002";
  const line = document.createElement("p");
  line.setAttribute("role", "status");
  line.setAttribute("aria-live", "polite");
  const message = document.createElement("p");
  message.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "flex-container flexGap5";
  const advanced = document.createElement("details");
  const advancedTitle = document.createElement("summary");
  advancedTitle.textContent = "\u65E7\u7248\u8FC1\u79FB / \u9AD8\u7EA7\u6062\u590D";
  const advancedActions = document.createElement("div");
  advancedActions.className = "flex-container flexGap5";
  advanced.append(advancedTitle, advancedActions);
  let actionHost = actions;
  function button(text, action) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "menu_button";
    node.textContent = text;
    node.addEventListener("click", () => {
      void action();
    });
    actionHost.append(node);
    return node;
  }
  const checkButton = button("\u68C0\u67E5\u9996\u5C4F\u72B6\u6001", async () => {
    await check();
    await diagnoseWorkers();
  });
  const install = button("\u5B89\u88C5\uFF0F\u4FEE\u590D\u9996\u5C4F\u63A5\u5165", () => change("install", installBlockedReason));
  const remove = button("\u64A4\u9500\u9996\u5C4F\u63A5\u5165", () => change("uninstall", ""));
  actionHost = advancedActions;
  const cleanup = button("\u6E05\u7406\u53EF\u8BC6\u522B\u65E7 HTML", () => change("cleanup-legacy", ""));
  const workerInfo = document.createElement("p");
  async function diagnoseWorkers() {
    try {
      const workers = await inspectMigrationWorkers();
      const scripts = Array.from(document.scripts || []).map((script) => script.src).filter((src) => /\/third-party\/(cocktail|cocktail-plus)\//.test(src));
      workerInfo.textContent = "\u65E7\u524D\u7AEF\uFF1A" + (scripts.join(", ") || (globalThis.__cocktailPlusEarlyBridge ? "\u65E7 bridge \u5DF2\u52A0\u8F7D" : "\u672A\u68C0\u6D4B\u5230")) + "\uFF1B\u5DF2\u8BC6\u522BSW\uFF1A" + (workers.flatMap((entry) => entry.urls).join(", ") || "\u65E0") + "\u3002\u672A\u77E5SW\u4E0D\u4F1A\u6E05\u7406\u3002";
    } catch (error) {
      workerInfo.textContent = String(error);
    }
  }
  button("\u68C0\u67E5\u65E7\u524D\u7AEF / SW", diagnoseWorkers);
  button("\u786E\u8BA4\u6CE8\u9500\u5DF2\u8BC6\u522B SW", async () => {
    try {
      workerInfo.textContent = await cleanupMigrationWorkers();
    } catch (error) {
      workerInfo.textContent = `\u6CE8\u9500\u672A\u786E\u8BA4\u5B8C\u6210\uFF1A${String(error)}\u3002\u8BF7\u91CD\u65B0\u68C0\u67E5 SW \u72B6\u6001\uFF0C\u4E0D\u8981\u76F2\u76EE\u91CD\u8BD5\u3002`;
    }
  });
  advanced.append(workerInfo);
  actionHost = actions;
  const reload = button("\u5237\u65B0\u9875\u9762\u4F7F\u5176\u751F\u6548", () => {
    if (globalThis.confirm("\u8BF7\u5148\u4FDD\u5B58\u5F53\u524D\u804A\u5929\u548C\u8BBE\u7F6E\u3002\u786E\u5B9A\u73B0\u5728\u5237\u65B0\u9875\u9762\uFF1F")) globalThis.location.reload();
  });
  root.append(title, description, line, actions, message, advanced);
  const render = () => {
    const value = status.management;
    const states = { unchecked: "\u6B63\u5728\u83B7\u53D6\u9996\u5C4F\u5B89\u88C5\u72B6\u6001\u2026\u2026", missing: "\u540E\u7AEF\u4E0D\u53EF\u7528\uFF1A\u539F\u751F\u9152\u9986\u53EF\u6B63\u5E38\u4F7F\u7528\uFF0C\u4EC5\u53EF\u9009\u52A0\u901F\u4E0D\u53EF\u7528\u3002\u9700\u8981\u52A0\u901F\u65F6\u518D\u90E8\u7F72 st-toolbox-server\u3002", unsupported: "\u5F53\u524D\u540E\u7AEF\u4E0D\u652F\u6301\u9762\u677F\u7BA1\u7406\uFF0C\u8BF7\u66F4\u65B0 st-toolbox-server \u5E76\u91CD\u542F\u9152\u9986\u3002", error: "\u65E0\u6CD5\u786E\u8BA4\u5F53\u524D\u72B6\u6001\u3002", ready: value?.installed ? value.needsRepair ? "\u5DF2\u5B89\u88C5\uFF0C\u4F46\u9700\u8981\u4FEE\u590D\uFF0F\u66F4\u65B0\u3002" : "\u5DF2\u5B89\u88C5\uFF0C\u5165\u53E3\u4E3A\u5F53\u524D\u7248\u672C\u3002" : "\u5C1A\u672A\u5B89\u88C5\u9996\u5C4F\u5165\u53E3\u3002" };
    line.textContent = status.busy ? "\u6B63\u5728\u68C0\u67E5\u6216\u6267\u884C\u9996\u5C4F\u64CD\u4F5C\uFF0C\u8BF7\u7A0D\u5019\u2026\u2026" : states[status.phase];
    const warnings = [status.message, value?.reason, value?.conflict, installBlockedReason];
    if (value?.legacy?.moduleDependency) warnings.push("\u65E7 HTML \u7684\u6838\u5FC3\u6A21\u5757\u4F9D\u8D56\u65E7\u540E\u7AEF\uFF1B\u8BF7\u5148\u4FEE\u590D HTML \u518D\u5220\u9664\u65E7\u540E\u7AEF\u3002\u65E7 SW \u5E76\u4E0D\u4E00\u5B9A\u662F\u9ED1\u5C4F\u539F\u56E0\u3002");
    if (status.reloadNeeded && !status.message) warnings.push("\u672C\u9875\u64CD\u4F5C\u5DF2\u5B8C\u6210\uFF0C\u4FDD\u5B58\u5F53\u524D\u5DE5\u4F5C\u540E\u5237\u65B0\u9875\u9762\uFF1B\u5F53\u524D\u5DF2\u52A0\u8F7D\u7684\u4EE3\u7801\u4E0D\u4F1A\u88AB\u70ED\u64A4\u9500\u3002");
    message.textContent = warnings.filter(Boolean).join(" ");
    checkButton.disabled = status.busy;
    const blocked = status.busy || status.phase !== "ready" || !value?.canManage;
    install.disabled = blocked || !!value?.conflict || !!installBlockedReason;
    remove.disabled = blocked || !value?.installed;
    cleanup.disabled = blocked || !value?.legacyCleanable;
    reload.hidden = !status.reloadNeeded;
    reload.disabled = status.busy;
    root.setAttribute("aria-busy", String(status.busy));
  };
  for (const node of views.keys()) if (!node.isConnected) views.delete(node);
  views.set(root, render);
  render();
  const panel = host.closest?.('[role="tabpanel"]');
  panel?.addEventListener("st-toolbox:settings-visible", () => {
    if (root.isConnected) void check();
  });
  void check().then(diagnoseWorkers);
}

// features/tomatojuice/client/index.ts
var started = false;
async function startBackendClient() {
  if (started) return;
  started = true;
  ensureLocalSettings();
  installFetchObserver();
  const ctx = globalThis.SillyTavern?.getContext?.();
  for (const key of ["CHARACTER_CREATED", "CHARACTER_DELETED", "CHARACTER_EDITED", "CHARACTER_IMPORTED", "CHARACTER_DUPLICATED", "CHARACTER_RENAMED"]) {
    const event = ctx?.eventTypes?.[key];
    if (event) ctx.eventSource.on(event, () => scheduleCharactersRefresh(key));
  }
  const capabilities = await discoverBackend();
  if (!capabilities?.modules?.some((module) => module.id === "tomatojuice")) return;
  await fullProbe();
  if (!state.backend?.ok) return;
  if (!globalThis.__tomatojuiceEarlyBridge && state.backend.readPolicy?.enabled && (cacheEnabled("characters-all") || cacheEnabled("version"))) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const script = document.createElement("script");
      script.async = true;
      script.src = `${API_PREFIX}/early/bridge.js`;
      script.onload = done;
      script.onerror = () => {
        console.warn("[tomatojuice] bridge unavailable; native requests retained");
        done();
      };
      document.head.append(script);
    });
  }
  applyReadPolicy();
  if (state.localSettings.autoWarm) await warm(false).catch((error) => console.warn("[tomatojuice] \u9884\u70ED\u5931\u8D25", error));
}
export {
  renderEarlyManagement,
  renderPanel,
  startBackendClient
};
