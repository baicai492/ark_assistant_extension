const buttons = [...document.querySelectorAll('[data-view]')];
const rename = document.querySelector('#rename');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const list = document.querySelector('#residents');
const labels = ['力', '感', '耐', '魅', '智', '敏', '幸'];
const titles = { total: '属性总和 · 降序', totalAsc: '属性总和 · 升序', combatPower: '战斗力 · 降序', romances: '感情进度 · 家庭冷却', children: '婴儿出生 · 儿童成长', training: '训练进度 · 含暂停及练满' };
let tabId;

function show(data, mode) {
  // 属性升序与降序共用总和字段，同分仍按居民 ID 排列。
  const sortKey = mode === 'totalAsc' ? 'total' : mode;
  const residents = mode === 'training' ? data.training : mode === 'romances' ? [...data.romances, ...data.cooldowns] : mode === 'children' ? [...data.births, ...data.children] :
    [...data.residents].sort((left, right) => (mode === 'totalAsc' ? left.total - right.total : right[sortKey] - left[sortKey]) || left.id - right.id);
  const time = new Date(data.checkedAt).toLocaleTimeString('zh-CN', { hour12: false });
  const count = mode === 'romances' ? `培养感情 ${data.romances.length} 对（含暂停） · 家庭冷却 ${data.cooldowns.length} 人` :
    mode === 'children' ? `待出生婴儿 ${data.births.length} 人 · 儿童 ${data.children.length} 人` : `居民 ${residents.length} 人`;
  status.textContent = `${count} · 更新时间：${time}`;
  if (!residents.length) status.textContent += mode === 'romances' ? '\n当前没有正在培养感情或家庭冷却中的居民。' :
    mode === 'children' ? '\n当前没有待出生婴儿或儿童。' : mode === 'training' ? '\n当前训练室中没有居民。' : '\n当前没有居民。';
  document.querySelector('#result-title').textContent = titles[mode];
  document.querySelector('#training-note').hidden = mode !== 'training';
  result.hidden = false;
  residents.forEach((resident, index) => {
    const item = document.createElement('li');
    const heading = document.createElement('div');
    heading.className = 'resident-heading';
    const name = document.createElement('strong');
    // 名字由用户设置，只作为文本显示。
    name.textContent = mode === 'romances' ? resident.names.join(' ＋ ') : `${index + 1}. ${resident.name}`;
    const score = document.createElement('span');
    score.className = 'resident-total';
    heading.append(name, score);
    item.append(heading);
    const summary = document.createElement('small');
    if (mode === 'romances' && 'familyCooldownUntil' in resident) {
      // 冷却按居民单独展示，剩余时间与本次读取的服务器时间保持一致。
      const seconds = Math.ceil((resident.familyCooldownUntil - data.checkedAt) / 1000);
      const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
      score.textContent = '家庭冷却';
      const remaining = document.createElement('p');
      remaining.textContent = `冷却剩余 ${hours ? `${hours} 小时 ` : ''}${minutes} 分 ${seconds % 60} 秒`;
      item.append(remaining);
      summary.textContent = `冷却结束：${new Date(resident.familyCooldownUntil).toLocaleString('zh-CN', { hour12: false })}`;
    } else if (mode === 'romances') {
      // 未结算到 100% 的配对最多显示 99%，与游戏详情的进度口径一致。
      score.textContent = `${resident.progress >= 1 ? 100 : Math.min(99, Math.round(resident.progress * 100))}%`;
      const progress = document.createElement('progress');
      progress.max = 1;
      progress.value = resident.progress;
      progress.setAttribute('aria-label', `${resident.names.join('与')}的感情进度`);
      item.append(progress);
      summary.textContent = [resident.room, resident.paused ? `暂停中：${resident.paused}` :
        resident.progress >= 1 ? '感情已满，等待人口空位及服务端结算' : '正在培养感情'].filter(Boolean).join(' · ');
    } else if (mode === 'training') {
      const stat = { str: '力量', per: '感知', end: '耐力', cha: '魅力', int: '智力', agi: '敏捷', lck: '幸运' }[resident.stat];
      score.textContent = resident.maxed ? '已练满' : `${(resident.progress * 100).toFixed(1)}%`;
      const detail = document.createElement('p');
      detail.textContent = resident.maxed ? `${stat}基础属性已满（${resident.current}）` : `${stat} ${resident.current} → ${resident.current + 1}`;
      item.append(detail);
      const stats = document.createElement('div');
      stats.className = 'stats';
      stats.textContent = labels.map((label, index) => `${label} ${resident.stats[index]}`).join(' · ');
      item.append(stats);
      if (!resident.maxed) {
        const progress = document.createElement('progress');
        progress.max = 1;
        progress.value = resident.progress;
        progress.setAttribute('aria-label', `${resident.name}的${stat}训练进度`);
        item.append(progress);
      }
      summary.textContent = `${resident.room} · ${resident.maxed ? '可调去训练其他属性' : resident.paused ? `暂停中：${resident.paused}` : resident.progress >= 1 ? '等待服务端结算确认' : '正在训练'}`;
      if (resident.remainingSeconds !== null && resident.progress < 1) {
        const totalMinutes = Math.ceil(resident.remainingSeconds / 60);
        const hours = Math.floor(totalMinutes / 60), minutes = totalMinutes % 60;
        const remaining = document.createElement('p');
        remaining.textContent = `属性 +1 预计剩余 ${hours ? `${hours} 小时 ` : ''}${minutes} 分`;
        item.append(remaining);
      }
    } else if (mode === 'children') {
      // 用服务器读取时间计算剩余时长，不受电脑时钟偏差影响。
      const unborn = 'dueAt' in resident;
      const targetAt = unborn ? resident.dueAt : resident.adultAt;
      const seconds = Math.max(0, Math.ceil((targetAt - data.checkedAt) / 1000));
      const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
      score.textContent = unborn ? '待出生' : '未成年';
      const remaining = document.createElement('p');
      remaining.textContent = `${unborn ? '出生倒计时：' : ''}剩余 ${hours ? `${hours} 小时 ` : ''}${minutes} 分 ${seconds % 60} 秒`;
      item.append(remaining);
      summary.textContent = `${unborn ? '出生' : '成年'}时间：${new Date(targetAt).toLocaleString('zh-CN', { hour12: false })}`;
    } else {
      score.textContent = `${resident[sortKey]} 点`;
      summary.textContent = `${resident.level} 级 · 属性合计 ${resident.total} · 战力 ${resident.combatPower} · ${resident.room}`;
      const stats = document.createElement('div');
      stats.className = 'stats';
      stats.textContent = labels.map((label, index) => `${label} ${resident.stats[index]}`).join(' · ');
      item.append(summary, stats);
    }
    if (mode === 'romances' || mode === 'children' || mode === 'training') item.append(summary);
    if (mode !== 'romances' && resident.reasons.length) {
      const state = document.createElement('small');
      state.textContent = resident.reasons.join('；');
      item.append(state);
    }
    list.append(item);
  });
}

async function refresh(mode) {
  buttons.forEach(button => { button.disabled = true; button.setAttribute('aria-pressed', String(button.dataset.view === mode)); });
  rename.disabled = true;
  result.hidden = true;
  list.replaceChildren();
  status.textContent = '正在读取全部居民…';
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, files: ['residents/content.js'] });
    if (injection.result.error) throw new Error(injection.result.error);
    show(injection.result, mode);
  } catch (error) {
    status.textContent = `读取失败：${error.message}`;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
    rename.disabled = false;
  }
}
buttons.forEach(button => button.addEventListener('click', () => refresh(button.dataset.view)));

function showRenameError(error) {
  status.textContent = `无法读取改名状态：${error.message}。请重新打开面板或检查游戏页面。`;
}
async function refreshRename() {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__fengbaoResidentRename ?? null });
  const task = injection.result;
  rename.disabled = Boolean(task?.running);
  buttons.forEach(button => { button.disabled = Boolean(task?.running); });
  if (!task) return;
  status.textContent = task.message;
  // 改名结果只展示名称实际发生变化的居民。
  const renamed = task.completed.filter(resident => resident.oldName !== resident.name);
  result.hidden = !renamed.length;
  document.querySelector('#result-title').textContent = '最高属性-编号 · 改名结果';
  document.querySelector('#training-note').hidden = true;
  list.replaceChildren();
  for (const resident of renamed) {
    const item = document.createElement('li');
    item.textContent = `${resident.oldName} → ${resident.name} · ${resident.level} 级`;
    list.append(item);
  }
  if (task.running) setTimeout(() => refreshRename().catch(showRenameError), 750);
}
rename.addEventListener('click', async () => {
  rename.disabled = true;
  buttons.forEach(button => { button.disabled = true; button.setAttribute('aria-pressed', 'false'); });
  result.hidden = true;
  list.replaceChildren();
  status.textContent = '正在按最高属性改名并保留已有编号…';
  try {
    const [auto] = await chrome.scripting.executeScript({ target: { tabId }, func: () => Boolean(globalThis.__fengbaoShelterAuto?.running) });
    if (auto.result) {
      status.textContent = '一键托管正在运行，请先关闭托管再手动改名。';
      rename.disabled = false;
      buttons.forEach(button => { button.disabled = false; });
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['residents/rename.js'] });
    await refreshRename();
  } catch (error) { showRenameError(error); }
});
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !/^https:\/\/game\.arkengine\.me\/shelter\/?(?:[?#]|$)/.test(tab.url)) {
    status.textContent = '请在自己的“避难所”页面打开此功能';
    return;
  }
  tabId = tab.id;
  status.textContent = '选择排序、感情进度、儿童成长或训练进度查看信息，也可一键改名。';
  await refreshRename();
})().catch(error => { status.textContent = `读取当前页面失败：${error.message}`; });
