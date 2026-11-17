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
const toggle = document.querySelector('#toggle');
const status = document.querySelector('#status');
const logs = document.querySelector('#logs');
let tabId, running = false, polling, godCycle;
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
}
for (const [section, checkbox] of [[rescueSection, rescueEnabled], [dismissSection, dismissNewcomers], [godSection, godEnabled], [birthSection, birthEnabled]]) {
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
async function refresh() {
  clearTimeout(polling);
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const task = globalThis.__fengbaoShelterAuto;
    return task ? { running: task.running, stopRequested: task.stopRequested, intervalSeconds: task.intervalSeconds, rescueEnabled: task.rescueEnabled, rescueMode: task.rescueMode, rescueCount: task.rescueCount, recallEvents: task.recallEvents, dismissEnabled: task.dismissEnabled, dismissTotal: task.dismissTotal, dismissStatEnabled: task.dismissStatEnabled, dismissStatKey: task.dismissStatKey, dismissStat: task.dismissStat, godEnabled: task.godEnabled, birthEnabled: task.birthEnabled, logs: task.logs, message: task.message, nextAt: task.nextAt } : null;
  } });
  const task = result.result;
  running = Boolean(task?.running);
  toggle.textContent = running ? task.stopRequested ? '正在关闭…' : '关闭' : '开启';
  toggle.disabled = Boolean(task?.stopRequested && running);
  interval.disabled = recall.disabled = rescueEnabled.disabled = dismissNewcomers.disabled = godEnabled.disabled = birthEnabled.disabled = running;
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
  }
  updateOptions();
  status.textContent = task?.message ?? '尚未开启托管。';
  if (running && task.nextAt && !task.stopRequested) status.textContent += ` 下次检查倒计时：${Math.max(0, Math.ceil((task.nextAt - Date.now()) / 1000))} 秒。`;
  const value = task?.logs.join('\n') ?? '';
  if (logs.value !== value) { logs.value = value; logs.scrollTop = logs.scrollHeight; }
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
    } else {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['workforce/planner.js', 'workforce/gear.js', 'stewardship/god-plan.js', 'stewardship/runner.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, func: (seconds, events, dismiss, total, statEnabled, statKey, stat, rescues, rescue, mode, god, birth) => { startShelterAuto(seconds, events, dismiss, total, statEnabled, statKey, stat, rescues, rescue, mode, god, birth); }, args: [Number(interval.value), Number(recall.value), dismissNewcomers.checked && dismissEnabled.checked, Number(dismissTotal.value), dismissNewcomers.checked && dismissStatEnabled.checked, dismissStatKey.value, Number(dismissStat.value), Number(rescueCount.value), rescueEnabled.checked, rescueAuto.checked ? 'auto' : 'workers', godEnabled.checked, birthEnabled.checked] });
    }
    await refresh();
  } catch (error) { showError(error); toggle.disabled = false; }
});
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !/^https:\/\/game\.arkengine\.me\/shelter\/?(?:[?#]|$)/.test(tab.url)) { status.textContent = '请在自己的避难所页面使用'; return; }
  tabId = tab.id;
  await refresh();
})().catch(showError);
