const settings = document.querySelector('#settings');
const interval = document.querySelector('#interval');
const rescueEnabled = document.querySelector('#rescue-enabled');
const rescueSection = document.querySelector('#rescue-section');
const rescueOptions = document.querySelector('#rescue-options');
const rescueAuto = document.querySelector('#rescue-mode-auto');
const rescueWorkers = document.querySelector('#rescue-mode-workers');
const rescueCount = document.querySelector('#rescue-count');
const recall = document.querySelector('#recall-events');
const dismissNewcomers = document.querySelector('#dismiss-newcomers-enabled');
const dismissSection = document.querySelector('#dismiss-section');
const dismissOptions = document.querySelector('#dismiss-options');
const dismissEnabled = document.querySelector('#dismiss-enabled');
const dismissTotal = document.querySelector('#dismiss-total');
const dismissStatEnabled = document.querySelector('#dismiss-stat-enabled');
const dismissStatKey = document.querySelector('#dismiss-stat-key');
const dismissStat = document.querySelector('#dismiss-stat');
const godEnabled = document.querySelector('#god-enabled');
const godSection = document.querySelector('#god-section');
const godStatus = document.querySelector('#god-status');
const godParents = document.querySelector('#god-parents');
const birthEnabled = document.querySelector('#birth-enabled');
const birthSection = document.querySelector('#birth-section');
const questEnabled = document.querySelector('#quest-enabled');
const questSection = document.querySelector('#quest-section');
const toggle = document.querySelector('#toggle');
const status = document.querySelector('#status');
const logs = document.querySelector('#logs');
const logFile = document.querySelector('#log-file');
const logHost = 'com.fengbao.shelter_log';
const exportLogs = document.querySelector('#export-logs');
const clearLogs = document.querySelector('#clear-logs');
let tabId, running = false, polling, godCycle;

clearLogs.addEventListener('click', async () => {
  await chrome.storage.local.remove('shelterLogs');
  // 同时清掉页面里的内存日志，避免刷新间隔内又作为兜底显示出来。
  await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const task = globalThis.__fengbaoShelterAuto;
    if (task) task.logs = [];
  } }).catch(() => {});
  // 本地日志文件也清空，下次写入从新日志开始。
  await chrome.runtime.sendNativeMessage(logHost, { command: 'log', logs: [] }).catch(() => {});
  logs.value = '';
  status.textContent = '日志已清空。';
});
// 自动写入项目目录由本地 host 负责；手动导出时由用户选择保存位置，
// 不支持文件选择器的浏览器回退为普通下载。
exportLogs.addEventListener('click', async () => {
  const text = logs.value;
  if (!text) { status.textContent = '暂无日志可导出。'; return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `shelter-log-${stamp}.txt`;
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: '日志文件', accept: { 'text/plain': ['.txt', '.log'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      status.textContent = `日志已保存：${handle.name}`;
      return;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    // 文件选择器不可用时回退为下载。
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status.textContent = `日志已下载：${name}`;
});
function updateOptions() {
  rescueOptions.disabled = running || !rescueEnabled.checked;
  rescueCount.disabled = running || !rescueEnabled.checked || !rescueAuto.checked;
  dismissOptions.disabled = running || !dismissNewcomers.checked;
  dismissTotal.disabled = running || !dismissNewcomers.checked || !dismissEnabled.checked;
  dismissStatKey.disabled = dismissStat.disabled = running || !dismissNewcomers.checked || !dismissStatEnabled.checked;
  if (!rescueEnabled.checked) rescueSection.open = false;
  if (!dismissNewcomers.checked) dismissSection.open = false;
  if (!godEnabled.checked) godSection.open = false;
  if (!birthEnabled.checked) birthSection.open = false;
  if (!questEnabled.checked) questSection.open = false;
}
for (const [section, checkbox] of [[rescueSection, rescueEnabled], [dismissSection, dismissNewcomers], [godSection, godEnabled], [birthSection, birthEnabled], [questSection, questEnabled]]) {
  section.querySelector('summary').addEventListener('click', event => {
    // 标题点击交给勾选框处理，由 change 事件统一联动展开与收起。
    if (event.target.tagName === 'SPAN' && !checkbox.disabled) {
      event.preventDefault();
      checkbox.click();
    } else if (!checkbox.checked && event.target !== checkbox) event.preventDefault();
  });
  checkbox.addEventListener('change', () => { section.open = checkbox.checked; updateOptions(); });
}
for (const radio of [rescueAuto, rescueWorkers, dismissEnabled, dismissStatEnabled]) radio.addEventListener('change', updateOptions);
godEnabled.addEventListener('change', () => {
  if (godEnabled.checked) {
    godCycle = null;
    refreshGodParents().catch(showGodError);
  }
});
updateOptions();
async function refreshGodParents() {
  godStatus.textContent = '正在读取造神亲本训练情况…';
  await chrome.scripting.executeScript({ target: { tabId }, files: ['workforce/planner.js', 'stewardship/god-plan.js'] });
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    const response = await fetch('/api/shelter', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok || response.redirected) throw new Error('读取训练情况失败或登录已失效');
    const view = await response.json();
    return { parents: planShelterGod(view).parents, paused: view.state.rooms.some(room => room.incident) || Boolean(globalThis.__fengbaoShelterAuto?.incidentSnapshot) };
  } });
  if (!godEnabled.checked) return;
  const { parents, paused } = result.result;
  godStatus.textContent = parents.length ? `造神亲本 ${parents.length} 人${paused ? '，事件处理中，暂停调动。' : '，下一站按当前空位预估。'}` : '训练室内暂无造神亲本。';
  godParents.replaceChildren();
  for (const parent of parents) {
    const item = document.createElement('li');
    const name = document.createElement('strong');
    // 居民名称只按文本显示，训练进度使用服务端已结算的数据。
    name.textContent = parent.name;
    const current = document.createElement('p');
    current.textContent = `当前训练：${parent.stat} ${parent.current}/10 · ${parent.current >= 10 ? '已练满' : `本级进度 ${(parent.progress * 100).toFixed(1)}%`}`;
    const progress = document.createElement('progress');
    progress.max = 1;
    progress.value = parent.progress;
    progress.setAttribute('aria-label', `${parent.name}的${parent.stat}训练进度`);
    const next = document.createElement('p');
    next.textContent = `下一步：${parent.nextRoom}`;
    const room = document.createElement('small');
    room.textContent = parent.room;
    item.append(name, current, progress, next, room);
    godParents.append(item);
  }
}
function showGodError(error) { godStatus.textContent = `读取造神亲本失败：${error.message}`; }
// 直接询问本地 host，确认日志目录存在且可写；host 未安装时会明确提示。
async function checkLogHost() {
  try {
    const response = await chrome.runtime.sendNativeMessage(logHost, { command: 'ping' });
    logFile.textContent = response?.file ? `本地日志文件：${response.file}` : '本地日志 host 返回异常。';
  } catch {
    logFile.textContent = '本地日志未安装：到扩展管理页重新加载后，双击项目里的 tools/install-log-host.cmd 安装一次。';
  }
}
async function refresh() {
  clearTimeout(polling);
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const task = globalThis.__fengbaoShelterAuto;
    return task ? { running: task.running, stopRequested: task.stopRequested, intervalSeconds: task.intervalSeconds, rescueEnabled: task.rescueEnabled, rescueMode: task.rescueMode, rescueCount: task.rescueCount, recallEvents: task.recallEvents, dismissEnabled: task.dismissEnabled, dismissTotal: task.dismissTotal, dismissStatEnabled: task.dismissStatEnabled, dismissStatKey: task.dismissStatKey, dismissStat: task.dismissStat, godEnabled: task.godEnabled, birthEnabled: task.birthEnabled, questEnabled: task.questEnabled, logs: task.logs, message: task.message, nextAt: task.nextAt } : null;
  } });
  const task = result.result;
  running = Boolean(task?.running);
  toggle.textContent = running ? task.stopRequested ? '正在关闭…' : '关闭' : '开启';
  toggle.disabled = Boolean(task?.stopRequested && running);
  interval.disabled = recall.disabled = rescueEnabled.disabled = dismissNewcomers.disabled = godEnabled.disabled = birthEnabled.disabled = questEnabled.disabled = running;
  if (running) {
    interval.value = task.intervalSeconds; recall.value = task.recallEvents;
    rescueEnabled.checked = task.rescueEnabled; rescueAuto.checked = task.rescueMode === 'auto'; rescueWorkers.checked = task.rescueMode === 'workers'; rescueCount.value = task.rescueCount;
    dismissNewcomers.checked = task.dismissEnabled || task.dismissStatEnabled;
    if (dismissNewcomers.checked) { dismissEnabled.checked = task.dismissEnabled; dismissStatEnabled.checked = task.dismissStatEnabled; }
    dismissTotal.value = task.dismissTotal;
    if (task.dismissStatEnabled) { dismissStatKey.value = task.dismissStatKey; dismissStat.value = task.dismissStat; }
    if (godEnabled.checked !== task.godEnabled) godSection.open = task.godEnabled;
    godEnabled.checked = task.godEnabled;
    if (birthEnabled.checked !== task.birthEnabled) birthSection.open = task.birthEnabled;
    birthEnabled.checked = task.birthEnabled;
    if (questEnabled.checked !== task.questEnabled) questSection.open = task.questEnabled;
    questEnabled.checked = task.questEnabled;
  }
  updateOptions();
  status.textContent = task?.message ?? '尚未开启托管。';
  if (running && task.nextAt && !task.stopRequested) status.textContent += ` 下次检查倒计时：${Math.max(0, Math.ceil((task.nextAt - Date.now()) / 1000))} 秒。`;
  const { shelterLogs = [], shelterLogStatus } = await chrome.storage.local.get(['shelterLogs', 'shelterLogStatus']);
  const value = (shelterLogs.length ? shelterLogs : task?.logs ?? []).join('\n');
  if (logs.value !== value) { logs.value = value; logs.scrollTop = logs.scrollHeight; }
  if (shelterLogStatus?.ok === false) logFile.textContent = `本地日志写入失败：${shelterLogStatus.error}`;
  // 每轮结束后 nextAt 才会更新，亲本信息随托管循环刷新，不再单独定时请求。
  if (running && godEnabled.checked && (godCycle === undefined || task.nextAt && godCycle !== task.nextAt)) {
    godCycle = task.nextAt;
    await refreshGodParents().catch(showGodError);
  }
  if (running) polling = setTimeout(() => refresh().catch(showError), 1000);
}
function showError(error) { status.textContent = `读取托管状态失败：${error.message}`; }
settings.addEventListener('submit', async event => {
  event.preventDefault();
  toggle.disabled = true;
  try {
    if (running) {
      await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        const task = globalThis.__fengbaoShelterAuto;
        task.stopRequested = true;
        clearTimeout(task.timer);
        task.wake?.();
      } });
      chrome.runtime.sendMessage({ type: 'fengbao-shelter-log-watch', tabId, running: false }).catch(() => {});
    } else {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['workforce/planner.js', 'workforce/gear.js', 'stewardship/god-plan.js', 'stewardship/runner.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, func: (seconds, events, dismiss, total, statEnabled, statKey, stat, rescues, rescue, mode, god, birth, quest) => { startShelterAuto(seconds, events, dismiss, total, statEnabled, statKey, stat, rescues, rescue, mode, god, birth, quest); }, args: [Number(interval.value), Number(recall.value), dismissNewcomers.checked && dismissEnabled.checked, Number(dismissTotal.value), dismissNewcomers.checked && dismissStatEnabled.checked, dismissStatKey.value, Number(dismissStat.value), Number(rescueCount.value), rescueEnabled.checked, rescueAuto.checked ? 'auto' : 'workers', godEnabled.checked, birthEnabled.checked, questEnabled.checked] });
      chrome.runtime.sendMessage({ type: 'fengbao-shelter-log-watch', tabId, running: true }).catch(() => {});
    }
    await refresh();
  } catch (error) { showError(error); toggle.disabled = false; }
});
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !/^https:\/\/game\.arkengine\.me\/shelter\/?(?:[?#]|$)/.test(tab.url)) { status.textContent = '请在自己的避难所页面使用'; return; }
  tabId = tab.id;
  await refresh();
  await checkLogHost();
})().catch(showError);
