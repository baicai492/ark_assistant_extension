const start = document.querySelector('#start');
const organize = document.querySelector('#organize');
const status = document.querySelector('#status');
let tabId;
const orderList = document.querySelector('#room-order');
const roomOptions = shelterRoomOrder();
let roomOrder = JSON.parse(localStorage.getItem('shelterRoomOrder')) ?? roomOptions.map(item => item.key);
function renderRoomOrder() {
  orderList.replaceChildren();
  roomOrder.forEach(key => {
    const item = document.createElement('li');
    item.dataset.key = key;
    const label = document.createElement('span');
    label.textContent = roomOptions.find(option => option.key === key).name;
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'room-drag-handle';
    handle.textContent = '☰';
    handle.draggable = true;
    handle.title = '按住拖动调整顺序';
    handle.setAttribute('aria-label', `拖动排序：${label.textContent}`);
    handle.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', key);
      event.dataTransfer.setDragImage(item, 20, item.offsetHeight / 2);
      item.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      // 拖动时直接调整列表位置，结束后保存实际顺序。
      roomOrder = [...orderList.children].map(row => row.dataset.key);
      localStorage.setItem('shelterRoomOrder', JSON.stringify(roomOrder));
    });
    item.append(label, handle);
    orderList.append(item);
  });
}
orderList.addEventListener('dragover', event => {
  const dragging = orderList.querySelector('.dragging');
  if (!dragging) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const before = [...orderList.children].find(item => {
    const rect = item.getBoundingClientRect();
    return item !== dragging && event.clientY < rect.top + rect.height / 2;
  });
  orderList.insertBefore(dragging, before ?? null);
});
orderList.addEventListener('drop', event => { event.preventDefault(); });
renderRoomOrder();
function showError(error) {
  status.textContent = `无法读取安排状态：${error.message}。请重新打开面板或检查游戏页面。`;
}
async function refresh() {
  const [auto] = await chrome.scripting.executeScript({ target: { tabId }, func: () => Boolean(globalThis.__fengbaoShelterAuto?.running) });
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__fengbaoWorkAssignment ?? null });
  let task = injection.result;
  if (organize) {
    document.querySelector('#room-confirmation').hidden = !task?.pendingRoomConfirmation;
    document.querySelector('#confirm-rooms').disabled = !task?.pendingRoomConfirmation;
    document.querySelector('#cancel-rooms').disabled = !task?.pendingRoomConfirmation;
  }
  start.disabled = Boolean(task?.running) || auto.result;
  if (organize) organize.disabled = start.disabled;
  if (auto.result) {
    status.textContent = '一键托管正在运行，请先在托管页关闭后再手动操作。';
    setTimeout(() => refresh().catch(showError), 750);
    return;
  }
  if (!task) { status.textContent = '请选择安排居民或整理房间。'; return; }
  status.textContent = task.message;
  const rates = document.querySelector('#rates');
  rates.hidden = !task.rates;
  if (task.rates) rates.textContent = '预计净产出（废料已扣除工坊消耗）：\n' + [['power', '电力'], ['food', '食物'], ['water', '净水'], ['scrap', '废料'], ['parts', '零件'], ['stimpak', '治疗针']].map(([key, label]) => {
    const value = task.rates[key];
    return `${label}：${value >= 0 ? '+' : ''}${value.toFixed(Math.abs(value) < 10 ? 1 : 0)}/时`;
  }).join('\n');
  const rooms = document.querySelector('#rooms');
  rooms.replaceChildren();
  for (const text of task.rooms) { const item = document.createElement('li'); item.textContent = text; rooms.append(item); }
  document.querySelector('#excluded').hidden = !task.excluded.length;
  document.querySelector('#excluded-count').textContent = `保留/不调动 ${task.excluded.length} 人 · 查看原因`;
  const excluded = document.querySelector('#excluded-list');
  excluded.replaceChildren();
  for (const resident of task.excluded) {
    const item = document.createElement('li');
    item.textContent = `${resident.name}：${resident.reason}`;
    excluded.append(item);
  }
  if (task.running && !task.pendingRoomConfirmation) setTimeout(() => refresh().catch(showError), 750);
}
start.addEventListener('click', async () => {
  // 居民安排需要二次确认，取消时不启动任务。
  if (!confirm('确定一键安排居民吗？\n将按最高属性重新分配生产岗位及训练室，无合适空位的居民会移到门外。资源亏损需手动调整，已执行的调动不会自动恢复。')) return;
  start.disabled = true;
  if (organize) organize.disabled = true;
  status.textContent = '正在计算安排…';
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['workforce/planner.js', 'workforce/runner.js'] });
    await refresh();
  } catch (error) { showError(error); }
});
organize?.addEventListener('click', async () => {
  start.disabled = true;
  organize.disabled = true;
  status.textContent = '正在检查房间并规划整理顺序…';
  try {
    await chrome.scripting.executeScript({ target: { tabId }, args: [roomOrder], func: order => {
      globalThis.__fengbaoRoomOrder = order;
    } });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['workforce/room-planner.js', 'workforce/room-runner.js'] });
    await refresh();
  } catch (error) { showError(error); }
});
if (organize) {
  for (const [id, approved] of [['confirm-rooms', true], ['cancel-rooms', false]]) {
    document.querySelector(`#${id}`).addEventListener('click', async () => {
      document.querySelector('#confirm-rooms').disabled = true;
      document.querySelector('#cancel-rooms').disabled = true;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, args: [approved], func: approved => {
          globalThis.__fengbaoConfirmRoomPlan?.(approved);
        } });
        await refresh();
      } catch (error) { showError(error); }
    });
  }
}
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !/^https:\/\/game\.arkengine\.me\/shelter\/?(?:[?#]|$)/.test(tab.url)) {
    status.textContent = '请在自己的“避难所”页面打开此功能';
    return;
  }
  tabId = tab.id;
  await refresh();
})().catch(showError);
