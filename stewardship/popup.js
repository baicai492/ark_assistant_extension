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
const populationEnabled = document.querySelector('#population-enabled');
const populationSection = document.querySelector('#population-section');
const populationOptions = document.querySelector('#population-options');
const populationTotal = document.querySelector('#population-total');
const populationMinIdle = document.querySelector('#population-min-idle');
const godEnabled = document.querySelector('#god-enabled');
const trainCharisma = document.querySelector('#train-charisma');
const trainLuck = document.querySelector('#train-luck');
const trainingInputs = [trainCharisma, trainLuck];
const trainingOptions = () => ({ trainCharisma: trainCharisma.checked, trainLuck: trainLuck.checked });
try {
  const saved = JSON.parse(localStorage.getItem('fengbao-auto-training') || localStorage.getItem('fengbao-workforce-options') || '{}');
  trainCharisma.checked = saved.trainCharisma === true;
  trainLuck.checked = saved.trainLuck === true;
} catch { /* 不可读时保留默认值。 */ }
for (const input of trainingInputs) input.addEventListener('change', () => {
  try { localStorage.setItem('fengbao-auto-training', JSON.stringify(trainingOptions())); } catch {}
  if (godEnabled.checked && tabId != null) refreshGodParents().catch(showGodError);
});
const godSection = document.querySelector('#god-section');
const godStatus = document.querySelector('#god-status');
const godParents = document.querySelector('#god-parents');
const birthEnabled = document.querySelector('#birth-enabled');
const birthSection = document.querySelector('#birth-section');
const questEnabled = document.querySelector('#quest-enabled');
const questSection = document.querySelector('#quest-section');
const upgradeEnabled = document.querySelector('#upgrade-enabled');
const upgradeSection = document.querySelector('#upgrade-section');
const upgradeDigEnabled = document.querySelector('#upgrade-dig-enabled');
const upgradeCraftEnabled = document.querySelector('#upgrade-craft-enabled');
const targetSection = document.querySelector('#target-section');
const targetEnabled = document.querySelector('#target-enabled');
const targetRoom = document.querySelector('#target-room');
const targetCount = document.querySelector('#target-count');
const targetStat = document.querySelector('#target-stat');
const targetStatRow = document.querySelector('#target-stat-row');
const upgradeOrderList = document.querySelector('#upgrade-order');
const toggle = document.querySelector('#toggle');
const status = document.querySelector('#status');
const logs = document.querySelector('#logs');
const logFile = document.querySelector('#log-file');
const logHost = 'com.fengbao.shelter_log';
const exportLogs = document.querySelector('#export-logs');
const clearLogs = document.querySelector('#clear-logs');
const returnParents = document.querySelector('#return-parents');
returnParents.addEventListener('click', async () => {
  await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const task = globalThis.__fengbaoShelterAuto;
    if (!task?.running) return;
    task.birthEnabled = false;
    task.returnRequested = true;
    task.wake?.();
  } });
  await refresh();
});
let tabId, running = false, polling, godCycle;
// 与托管脚本保持一致：面板只读取并显示最近一段日志。
const logLimit = 2000;
let logSignature = '';

// 自动升级顺序：每项都是具体房间类型，运行时按这个顺序找下一间可升级的房间。
const upgradeLabels = {
  power: '发电站', scrap: '废料回收站', workshop: '零件工坊', diner: '餐厅', water: '净水站',
  quarters: '宿舍', storage: '仓库', training: '训练室', armory: '武器工坊', tailor: '服装工坊', door: '大门',
  medbay: '医务室', radio: '电台'
};
const defaultUpgradeOrder = Object.keys(upgradeLabels);
let upgradeOrder = defaultUpgradeOrder.slice();
let upgradeOrderSignature = '';
function normalizeUpgradeOrder(order) {
  const result = [];
  for (const key of Array.isArray(order) ? order : []) {
    if (Object.hasOwn(upgradeLabels, key) && !result.includes(key)) result.push(key);
  }
  for (const key of defaultUpgradeOrder) if (!result.includes(key)) result.push(key);
  return result;
}
function renderUpgradeOrder(order = upgradeOrder) {
  upgradeOrder = normalizeUpgradeOrder(order);
  const signature = upgradeOrder.join(',');
  if (signature === upgradeOrderSignature && upgradeOrderList.children.length) return;
  upgradeOrderSignature = signature;
  const fragment = document.createDocumentFragment();
  upgradeOrder.forEach(key => {
    const item = document.createElement('li');
    item.dataset.key = key;
    const label = document.createElement('span');
    label.className = 'order-label';
    label.textContent = upgradeLabels[key];
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'order-button';
    up.textContent = '↑';
    up.setAttribute('aria-label', `上移${upgradeLabels[key]}`);
    up.addEventListener('click', () => moveUpgrade(key, -1));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'order-button';
    down.textContent = '↓';
    down.setAttribute('aria-label', `下移${upgradeLabels[key]}`);
    down.addEventListener('click', () => moveUpgrade(key, 1));
    item.append(label, up, down);
    fragment.append(item);
  });
  upgradeOrderList.replaceChildren(fragment);
  updateOptions();
}
function moveUpgrade(key, delta) {
  if (running) return;
  const from = upgradeOrder.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= upgradeOrder.length) return;
  upgradeOrder.splice(from, 1);
  upgradeOrder.splice(to, 0, key);
  upgradeOrderSignature = '';
  renderUpgradeOrder();
  chrome.storage.local.set({ shelterUpgradeOrder: upgradeOrder }).catch(() => {});
}

clearLogs.addEventListener('click', async () => {
  // 同时清掉页面里的内存日志，避免刷新间隔内又作为兜底显示出来。
  await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    const task = globalThis.__fengbaoShelterAuto;
    if (task?.clearLogs) await task.clearLogs();
    else { if (task) task.logs = []; await chrome.storage.local.remove('shelterLogs'); }
  } }).catch(() => chrome.storage.local.remove('shelterLogs'));
  // 本地日志文件通过后台队列清空，确保排在进行中的追加写入之后。
  let clearedFile = true, clearError = '';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'fengbao-shelter-log-clear' });
    if (response?.error) { clearedFile = false; clearError = response.error; }
  } catch (error) {
    clearedFile = false;
    clearError = error.message;
  }
  logs.value = '';
  status.textContent = clearedFile
    ? '日志已清空（含本地日志文件）。'
    : `扩展日志已清空；本地日志文件清空失败${clearError ? `：${clearError}` : ''}。`;
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
  for (const input of trainingInputs) input.disabled = running;
  rescueOptions.disabled = running || !rescueEnabled.checked;
  rescueCount.disabled = running || !rescueEnabled.checked || !rescueAuto.checked;
  dismissOptions.disabled = running || !dismissNewcomers.checked;
  dismissTotal.disabled = running || !dismissNewcomers.checked || !dismissEnabled.checked;
  dismissStatKey.disabled = dismissStat.disabled = running || !dismissNewcomers.checked || !dismissStatEnabled.checked;
  populationEnabled.disabled = running;
  populationOptions.disabled = populationTotal.disabled = populationMinIdle.disabled = running || !populationEnabled.checked;
  upgradeDigEnabled.disabled = running || !upgradeEnabled.checked;
  upgradeCraftEnabled.disabled = running || !upgradeEnabled.checked;
  targetEnabled.disabled = running;
  targetRoom.disabled = running || !targetEnabled.checked;
  targetCount.disabled = running || !targetEnabled.checked;
  targetStat.disabled = running || !targetEnabled.checked || targetRoom.value !== 'training';
  targetStatRow.hidden = targetRoom.value !== 'training';
  // 第一项不能上移、最后一项不能下移；运行中顺序已锁定。
  [...upgradeOrderList.children].forEach((item, index) => {
    const [up, down] = item.querySelectorAll('button');
    if (up) up.disabled = running || !upgradeEnabled.checked || index === 0;
    if (down) down.disabled = running || !upgradeEnabled.checked || index === upgradeOrderList.children.length - 1;
  });
  if (!rescueEnabled.checked) rescueSection.open = false;
  if (!dismissNewcomers.checked) dismissSection.open = false;
  if (!populationEnabled.checked) populationSection.open = false;
  if (!godEnabled.checked) godSection.open = false;
  if (!birthEnabled.checked) birthSection.open = false;
  if (!questEnabled.checked) questSection.open = false;
  if (!upgradeEnabled.checked) upgradeSection.open = false;
  if (!targetEnabled.checked) targetSection.open = false;
}
for (const [section, checkbox] of [[rescueSection, rescueEnabled], [dismissSection, dismissNewcomers], [populationSection, populationEnabled], [godSection, godEnabled], [birthSection, birthEnabled], [questSection, questEnabled], [upgradeSection, upgradeEnabled], [targetSection, targetEnabled]]) {
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
targetRoom.addEventListener('change', updateOptions);
godEnabled.addEventListener('change', () => {
  if (godEnabled.checked) {
    godCycle = null;
    refreshGodParents().catch(showGodError);
  }
});
// 先渲染默认顺序；即使当前标签页不是避难所，设置区也有内容。
renderUpgradeOrder();
async function refreshGodParents() {
  godStatus.textContent = '正在读取造神亲本训练情况…';
  await chrome.scripting.executeScript({ target: { tabId }, files: ['workforce/planner.js', 'stewardship/god-plan.js'] });
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: async options => {
    const response = await fetch('/api/shelter', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok || response.redirected) throw new Error('读取训练情况失败或登录已失效');
    const view = await response.json();
    return { parents: planShelterGod(view, new Set(), false, false, options).parents, paused: view.state.rooms.some(room => room.incident) || Boolean(globalThis.__fengbaoShelterAuto?.incidentSnapshot) };
  }, args: [trainingOptions()] });
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
    // 当前所在房间与居民名称同行显示。
    const heading = document.createElement('div');
    heading.className = 'god-parent-heading';
    heading.append(name, room);
    item.append(heading, current, progress, next);
    godParents.append(item);
  }
}
function showGodError(error) { godStatus.textContent = `读取造神亲本失败：${error.message}`; }
// 直接询问本地 host，确认日志目录存在且可写；host 未安装时会明确提示。
async function checkLogHost() {
  try {
    const response = await chrome.runtime.sendNativeMessage(logHost, { command: 'ping' });
    if (response?.error || response?.ok !== true) throw new Error(response?.error || '本地日志程序未确认可用');
    logFile.textContent = response?.file ? `本地日志文件：${response.file}` : '本地日志 host 返回异常。';
  } catch {
    logFile.textContent = '本地日志未安装：到扩展管理页重新加载后，双击项目里的 tools/install-log-host.cmd 安装一次。';
  }
}
async function refresh() {
  clearTimeout(polling);
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const task = globalThis.__fengbaoShelterAuto;
    return task ? { running: task.running, stopRequested: task.stopRequested, intervalSeconds: task.intervalSeconds, rescueEnabled: task.rescueEnabled, rescueMode: task.rescueMode, rescueCount: task.rescueCount, recallEvents: task.recallEvents, dismissEnabled: task.dismissEnabled, dismissTotal: task.dismissTotal, dismissStatEnabled: task.dismissStatEnabled, dismissStatKey: task.dismissStatKey, dismissStat: task.dismissStat, populationOptions: task.populationOptions, godEnabled: task.godEnabled, birthEnabled: task.birthEnabled, questEnabled: task.questEnabled, upgradeEnabled: task.upgradeEnabled, upgradeDigEnabled: task.upgradeDigEnabled, craftOutfitsEnabled: task.craftOutfitsEnabled, targetEnabled: task.targetEnabled, targetRoom: task.targetRoom, targetCount: task.targetCount, targetStat: task.targetStat, upgradeOrder: task.upgradeOrder, trainingOptions: task.trainingOptions, parentReturns: task.parentReturns, incidentSnapshot: task.incidentSnapshot, logs: task.logs, message: task.message, nextAt: task.nextAt } : null;
  } });
  const task = result.result;
  running = Boolean(task?.running);
  toggle.textContent = running ? task.stopRequested ? '正在关闭…' : '关闭' : '开启';
  toggle.disabled = Boolean(task?.stopRequested && running);
  // 关闭时必须绕过表单校验：功能设置里有必填项时，无效值会阻止 submit，导致“关闭”点了没反应。
  toggle.formNoValidate = running;
  interval.disabled = recall.disabled = rescueEnabled.disabled = dismissNewcomers.disabled = godEnabled.disabled = birthEnabled.disabled = questEnabled.disabled = upgradeEnabled.disabled = running;
  if (running) {
    trainCharisma.checked = task.trainingOptions?.trainCharisma === true;
    trainLuck.checked = task.trainingOptions?.trainLuck === true;
    interval.value = task.intervalSeconds; recall.value = task.recallEvents;
    rescueEnabled.checked = task.rescueEnabled; rescueAuto.checked = task.rescueMode === 'auto'; rescueWorkers.checked = task.rescueMode === 'workers'; rescueCount.value = task.rescueCount;
    dismissNewcomers.checked = task.dismissEnabled || task.dismissStatEnabled;
    if (dismissNewcomers.checked) { dismissEnabled.checked = task.dismissEnabled; dismissStatEnabled.checked = task.dismissStatEnabled; }
    dismissTotal.value = task.dismissTotal;
    populationEnabled.checked = task.populationOptions?.enabled === true;
    populationTotal.value = task.populationOptions?.total ?? 60;
    populationMinIdle.value = task.populationOptions?.minIdle ?? 5;
    if (task.dismissStatEnabled) { dismissStatKey.value = task.dismissStatKey; dismissStat.value = task.dismissStat; }
    // 面板重新打开时功能分组保持折叠，勾选状态从任务恢复即可；
    // 只有用户手动点开时才展开，运行中的轮询不再自动展开。
    godEnabled.checked = task.godEnabled;
    birthEnabled.checked = task.birthEnabled;
    questEnabled.checked = task.questEnabled;
    upgradeEnabled.checked = Boolean(task.upgradeEnabled);
    upgradeDigEnabled.checked = Boolean(task.upgradeDigEnabled);
    upgradeCraftEnabled.checked = Boolean(task.craftOutfitsEnabled);
    targetEnabled.checked = Boolean(task.targetEnabled);
    targetRoom.value = task.targetRoom || '';
    targetCount.value = task.targetCount ?? 12;
    targetStat.value = task.targetStat ?? 'str';
    renderUpgradeOrder(task.upgradeOrder ?? defaultUpgradeOrder);
  }
  if (!running) {
    // 关闭托管后功能分组统一收起，勾选状态保留，下次开启不用重新设置。
    for (const section of [rescueSection, dismissSection, populationSection, godSection, birthSection, questSection, upgradeSection, targetSection]) section.open = false;
  }
  updateOptions();
  status.textContent = running && task?.stopRequested ? '正在关闭托管…' : task?.message ?? '尚未开启托管。';
  const records = [...(task?.parentReturns ?? []), ...(task?.incidentSnapshot ?? [])].filter(entry => entry.status === 'waiting');
  returnParents.disabled = !running || !(task?.parentReturns?.length);
  const recordList = document.querySelector('#return-records');
  recordList.replaceChildren();
  for (const entry of records) {
    const item = document.createElement('li');
    item.textContent = `${entry.name} → ${entry.originalRoomId === null ? '门外' : `原房间 ${entry.originalRoomId}`}：${entry.note || '等待归岗，原位名额保留'}`;
    recordList.append(item);
  }
  if (!running && records.length) status.textContent += ' 归岗记录保留；重新开启托管后继续恢复。';
  if (running && task.nextAt && !task.stopRequested) status.textContent += ` 下次检查倒计时：${Math.max(0, Math.ceil((task.nextAt - Date.now()) / 1000))} 秒。`;
  const { shelterLogs = [], shelterLogStatus } = await chrome.storage.local.get(['shelterLogs', 'shelterLogStatus']);
  const source = shelterLogs.length ? shelterLogs.slice(-logLimit) : task?.logs ?? [];
  // 日志没变化时不再拼接和重写整个 textarea；否则面板每秒都要处理几十万字符。
  const signature = `${source.length}:${source[source.length - 1] ?? ''}`;
  if (signature !== logSignature) {
    logSignature = signature;
    const value = source.join('\n');
    if (logs.value !== value) { logs.value = value; logs.scrollTop = logs.scrollHeight; }
  }
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
      // 先给出反馈，避免关闭请求等待后台退出时看起来没反应。
      toggle.textContent = '正在关闭…';
      status.textContent = '正在关闭托管…';
      await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        const task = globalThis.__fengbaoShelterAuto;
        task.stopRequested = true;
        clearTimeout(task.timer);
        task.wake?.();
      } });
      chrome.runtime.sendMessage({ type: 'fengbao-shelter-log-watch', tabId, running: false }).catch(() => {});
    } else {
      await savedSettings.save();
      await chrome.storage.local.set({ shelterUpgradeOrder: upgradeOrder });
      const storedTarget = targetEnabled.checked
        ? await chrome.storage.local.get('shelterTargetProgress').catch(() => ({}))
        : {};
      const shelterTargetProgress = storedTarget.shelterTargetProgress ?? null;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['stewardship/log-bridge.js', 'stewardship/upgrade-plan.js', 'stewardship/target-plan.js', 'workforce/planner.js', 'workforce/gear.js', 'stewardship/god-plan.js', 'stewardship/runner.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, func: (seconds, events, dismiss, total, statEnabled, statKey, stat, rescues, rescue, mode, god, birth, quest, training, upgrade, dig, order, craft, targetOn, room, count, targetTraining, population, storedTargetProgress) => { startShelterAuto(seconds, events, dismiss, total, statEnabled, statKey, stat, rescues, rescue, mode, god, birth, quest, training, upgrade, dig, order, craft, targetOn, room, count, targetTraining, population, storedTargetProgress); }, args: [Number(interval.value), Number(recall.value), dismissNewcomers.checked && dismissEnabled.checked, Number(dismissTotal.value), dismissNewcomers.checked && dismissStatEnabled.checked, dismissStatKey.value, Number(dismissStat.value), Number(rescueCount.value), rescueEnabled.checked, rescueAuto.checked ? 'auto' : 'workers', godEnabled.checked, birthEnabled.checked, questEnabled.checked, trainingOptions(), upgradeEnabled.checked, upgradeDigEnabled.checked, upgradeOrder, upgradeEnabled.checked && upgradeCraftEnabled.checked, targetEnabled.checked, targetRoom.value, Number(targetCount.value), targetStat.value, { enabled: populationEnabled.checked, total: Number(populationTotal.value), minIdle: Number(populationMinIdle.value) }, shelterTargetProgress] });
      chrome.runtime.sendMessage({ type: 'fengbao-shelter-log-watch', tabId, running: true }).catch(() => {});
    }
    await refresh();
  } catch (error) { showError(error); toggle.disabled = false; toggle.textContent = running ? '关闭' : '开启'; }
});
(async () => {
  await savedSettings.ready;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !/^https:\/\/game\.arkengine\.me\/shelter\/?(?:[?#]|$)/.test(tab.url)) { status.textContent = '请在自己的避难所页面使用'; return; }
  tabId = tab.id;
  const stored = await chrome.storage.local.get('shelterUpgradeOrder').catch(() => ({}));
  renderUpgradeOrder(stored.shelterUpgradeOrder ?? defaultUpgradeOrder);
  await initializeStewardshipSettings();
  await checkLogHost();
})().catch(showError);
