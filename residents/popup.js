const buttons = [...document.querySelectorAll('[data-view]')];
const rename = document.querySelector('#rename');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const list = document.querySelector('#residents');
const distribution = document.querySelector('#distribution');
const distributionScope = document.querySelector('#distribution-scope');
const distributionGroup = document.querySelector('#distribution-group');
const distributionStat = document.querySelector('#distribution-stat');
const distributionControls = [distributionScope, distributionGroup, distributionStat];
let distributionData = null;
const labels = ['力', '感', '耐', '魅', '智', '敏', '幸'];
const titles = { total: '属性总和 · 降序', totalAsc: '属性总和 · 升序', combatPower: '战斗力 · 降序', romances: '感情进度 · 家庭冷却', children: '婴儿出生 · 儿童成长', training: '训练进度 · 含暂停及练满' };
let tabId;

function showDistribution(data) {
  const report = residentDistribution(data.residents, distributionScope.value);
  const number = value => value === null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(2);
  const scopeName = { living: '存活居民', adults: '存活成人', idle: '在家待岗成人' }[distributionScope.value];
  status.textContent = `${scopeName} ${report.count} 人 · 数据时间：${new Date(data.checkedAt).toLocaleString('zh-CN', { hour12: false })}`;
  document.querySelector('#result-title').textContent = '存量居民 · 基础属性分布';
  document.querySelector('#training-note').hidden = true;
  const census = report.census;
  document.querySelector('#distribution-census').textContent = `存活 ${census.living} 人（成人 ${census.adults}、儿童 ${census.children}）；其中外出 ${census.away}、在家待岗成人 ${census.idle}。另有倒下 ${census.down}、待出生 ${data.births.length}。`;
  document.querySelector('#distribution-summary').textContent = report.count
    ? `总属性：均值 ${number(report.total.mean)} · 中位数 ${number(report.total.median)} · 最低 ${report.total.min} · 最高 ${report.total.max}`
    : '当前范围没有居民。';
  document.querySelector('#distribution-low-count').textContent = `总属性 <60：${report.low.length} 人（${(report.count ? report.low.length / report.count * 100 : 0).toFixed(1)}%）；≥60：${report.count - report.low.length} 人。`;
  const chart = (selector, rows) => {
    const target = document.querySelector(selector);
    target.replaceChildren();
    if (!report.count) {
      const empty = document.createElement('p'); empty.className = 'note'; empty.textContent = '暂无数据'; target.append(empty); return;
    }
    for (const row of rows) {
      const line = document.createElement('div'); line.className = 'distribution-row'; line.setAttribute('role', 'listitem');
      const label = document.createElement('span'); label.textContent = row.label;
      const bar = document.createElement('span'); bar.className = 'distribution-bar'; bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span'); fill.className = 'distribution-fill'; fill.style.width = `${row.percent}%`;
      bar.append(fill);
      const count = document.createElement('span'); count.className = 'distribution-count'; count.textContent = `${row.count} 人 · ${row.percent.toFixed(1)}%`;
      line.append(label, bar, count); target.append(line);
    }
  };
  chart('#distribution-total-chart', report.total[distributionGroup.value]);
  const attribute = report.stats[Number(distributionStat.value)];
  document.querySelector('#distribution-stat-chart').setAttribute('aria-label', `${attribute.name}基础属性人数及占比`);
  chart('#distribution-stat-chart', attribute.buckets.filter(row => row.min > 0 || row.count > 0));
  const summary = document.querySelector('#distribution-stat-summary'); summary.replaceChildren();
  for (const stat of report.stats) {
    const row = document.createElement('tr');
    const heading = document.createElement('th'); heading.setAttribute('scope', 'row'); heading.textContent = stat.name; row.append(heading);
    for (const value of [number(stat.mean), number(stat.median), stat.min === null ? '—' : `${stat.min}–${stat.max}`, `${stat.maxed} 人`]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    summary.append(row);
  }
  document.querySelector('#distribution-low-title').textContent = `低于 60 分的居民（${report.low.length} 人）`;
  const lowList = document.querySelector('#distribution-low-list'); lowList.replaceChildren();
  for (const resident of report.low) {
    const item = document.createElement('li'); item.textContent = `${resident.name} #${resident.id} · ${resident.total} 分 · ${resident.room}`;
    const stats = document.createElement('small'); stats.textContent = labels.map((label, index) => `${label} ${resident.stats[index]}`).join(' · ');
    if (resident.reasons.length) stats.textContent += ` · ${resident.reasons.join('；')}`;
    item.append(stats); lowList.append(item);
  }
  list.hidden = true;
  distribution.hidden = false;
  result.hidden = false;
}
for (const control of distributionControls) control.addEventListener('change', () => {
  if (!distributionData || distribution.hidden) return;
  try { showDistribution(distributionData); }
  catch (error) { result.hidden = true; status.textContent = `统计失败：${error.message}`; }
});

function show(data, mode) {
  distribution.hidden = true;
  list.hidden = false;
  if (mode === 'distribution') { showDistribution(data); return; }
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
  distribution.hidden = true;
  distributionData = null;
  distributionControls.forEach(control => { control.disabled = true; });
  list.replaceChildren();
  status.textContent = '正在读取全部居民…';
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, files: ['residents/content.js'] });
    if (injection.result.error) throw new Error(injection.result.error);
    show(injection.result, mode);
    if (mode === 'distribution') distributionData = injection.result;
  } catch (error) {
    status.textContent = `读取失败：${error.message}`;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
    rename.disabled = false;
    distributionControls.forEach(control => { control.disabled = false; });
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
  distribution.hidden = true;
  distributionData = null;
  list.hidden = false;
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
  status.textContent = '选择属性分布、排序、感情进度、儿童成长或训练进度查看信息；再次点击可刷新数据。';
  await refreshRename();
})().catch(error => { status.textContent = `读取当前页面失败：${error.message}`; });
