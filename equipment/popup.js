const settings = document.querySelector('#settings');
const weapons = document.querySelector('#weapons');
const outfits = document.querySelector('#outfits');
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const status = document.querySelector('#status');
let tabId, polling, submitting = false;
function showError(error) {
  status.textContent = `读取装备分配状态失败：${error.message}。请重新打开面板。`;
  start.disabled = stop.disabled = true;
}
async function refresh() {
  clearTimeout(polling);
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({
    task: globalThis.__fengbaoEquipmentAssignment ?? null,
    busy: Boolean(globalThis.__fengbaoShelterAuto?.running || globalThis.__fengbaoWorkAssignment?.running ||
      globalThis.__fengbaoDormAssignment?.running || globalThis.__fengbaoResidentRename?.running)
  }) });
  const { task, busy } = injection.result;
  const running = Boolean(task?.running);
  start.disabled = submitting || running || busy || (!weapons.checked && !outfits.checked);
  stop.disabled = !running || task.stopRequested;
  stop.textContent = running && task.stopRequested ? '正在停止…' : '停止';
  weapons.disabled = outfits.disabled = submitting || running;
  status.textContent = task?.message ?? '选择装备类型后，点击一键分配。';
  if (busy && !running) status.textContent = '其他避难所任务正在运行，请等待完成或先在托管页关闭托管。';
  for (const [id, entries, title] of [
    ['results', task?.completed ?? [], '已确认穿戴'], ['excluded', task?.excluded ?? [], '跳过居民']
  ]) {
    document.querySelector(`#${id}`).hidden = !entries.length;
    document.querySelector(`#${id === 'results' ? 'result' : 'excluded'}-count`).textContent = `${title} ${entries.length} · 查看详情`;
    const list = document.querySelector(`#${id === 'results' ? 'result' : 'excluded'}-list`);
    list.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement('li');
      item.textContent = typeof entry === 'string' ? entry : `${entry.name}：${entry.reason}`;
      list.append(item);
    }
  }
  polling = setTimeout(() => refresh().catch(showError), 750);
}
settings.addEventListener('submit', async event => {
  event.preventDefault();
  if (start.disabled || (!weapons.checked && !outfits.checked)) return;
  submitting = true;
  start.disabled = true;
  weapons.disabled = outfits.disabled = true;
  const options = { weapons: weapons.checked, outfits: outfits.checked };
  status.textContent = '正在计算装备分配…';
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['equipment/planner.js', 'equipment/runner.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, args: [options],
      func: options => { startShelterEquipment(options); } });
    submitting = false;
    await refresh();
  } catch (error) { submitting = false; showError(error); }
});
stop.addEventListener('click', async () => {
  stop.disabled = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      if (globalThis.__fengbaoEquipmentAssignment?.running) globalThis.__fengbaoEquipmentAssignment.stopRequested = true;
    } });
    await refresh();
  } catch (error) { showError(error); }
});
for (const input of [weapons, outfits]) input.addEventListener('change', () => { if (tabId !== undefined) refresh().catch(showError); });
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/game\.arkengine\.me\/shelter\/?(?:[?#]|$)/.test(tab.url)) {
    status.textContent = '请在自己的“避难所”页面打开此功能';
    return;
  }
  tabId = tab.id;
  await refresh();
})().catch(showError);
