import { state } from './state';
import { ensureLocalSettings } from './settings';
import { fullProbe, refreshStatus, warm, clearCache, refreshBrowserLogs, clearBrowserLogs } from './api';
import { registerServiceWorker, unregisterServiceWorker } from './service-worker';
export function renderPanel(host?: HTMLElement) {
  const root = host || document.getElementById('tomatojuice-backend-panel');
  if (!root) return;
  root.replaceChildren();
  root.classList.add('st-toolbox-backend-panel');
  const status = document.createElement('p');
  status.textContent = state.backend?.ok ? 'st-toolbox-server：可用；缓存按用户持久化、按文件签名失效。' : '后端未安装：使用酒馆原生请求，前端优化仍可使用。';
  root.append(status);
  const note = document.createElement('p');
  note.textContent = '首屏加速可在上方管理区点击安装，管理员确认后生效于下次刷新；设置与聊天差量保存保留原生保存和冲突检查。SW 为可选项，不自动覆盖其他根作用域 SW。更新请使用酒馆原生扩展更新；后端手动复制更新。';
  root.append(note);
  const actions = document.createElement('div'); actions.className = 'st-toolbox-backend-actions';
  actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '后端与缓存操作');
  root.append(actions);
  const result = document.createElement('pre'); result.className = 'st-toolbox-backend-result';
  result.style.cssText = 'max-height:24em;overflow:auto;white-space:pre-wrap';
  const show = () => { result.textContent = JSON.stringify({ cache: state.backend?.status, settingsGet: state.backend?.settingsGet, settingsSave: state.backend?.settingsSave, chatSave: state.backend?.chatSave, sw: state.sw }, null, 2); };
  const add = (text: string, action: () => Promise<unknown>, backend = false) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button'; button.textContent = text; button.disabled = backend && !state.backend?.ok;
    button.addEventListener('click', async () => { button.disabled = true; try { const output = await action(); if (typeof output === 'string') result.textContent = output; else show(); } catch (error) { result.textContent = String(error); } finally { button.disabled = backend && !state.backend?.ok; } }); actions.append(button);
  };
  add('重新检测', async () => { await fullProbe(); renderPanel(root); });
  add('预热（不强制重建）', () => warm(true), true);
  add('清理当前用户缓存', () => clearCache(), true);
  add('刷新状态', () => refreshStatus(), true);
  add('注册可选 SW', async () => {
    if (!confirm('SW 将接管本站根作用域。确认没有其他插件的 SW，并继续？')) return;
    await registerServiceWorker();
  }, true);
  add('注销 tomatojuice SW', () => unregisterServiceWorker());
  add('读取当前用户日志', async () => { const logs = await refreshBrowserLogs(); return logs?.text || '无日志（默认不采集浏览器全局日志）'; }, true);
  add('清理当前用户日志', () => clearBrowserLogs(), true);
  const settings = ensureLocalSettings();
  const label = document.createElement('label'); label.className = 'checkbox_label';
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = settings.autoWarm;
  checkbox.addEventListener('change', async () => { const { updateLocalBool } = await import('./settings'); updateLocalBool('autoWarm', checkbox.checked); });
  label.append(checkbox, ' 启动时补充预热（有效缓存不重建）'); root.append(label);
  root.append(result); show();
}
