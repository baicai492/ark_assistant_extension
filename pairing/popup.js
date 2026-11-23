const calculate = document.querySelector('#calculate');
const settings = document.querySelector('#settings');
const groupCount = document.querySelector('#group-count');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const pairList = document.querySelector('#pairs');
const excluded = document.querySelector('#excluded');
const excludedList = document.querySelector('#excluded-list');
const assignDorms = document.querySelector('#assign-dorms');
const labels = ['力', '感', '耐', '魅', '智', '敏', '幸'];
let tabId;
let recommendedPairs = [];

function setBusy(busy) {
  calculate.disabled = busy;
  groupCount.disabled = busy;
  assignDorms.disabled = busy || recommendedPairs.length === 0;
}

async function refreshAssignment() {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId }, func: () => globalThis.__fengbaoDormAssignment ?? null
  });
  const task = injection.result;
  if (!task) return false;
  status.textContent = [task.message, ...task.completed].join('\n');
  setBusy(task.running);
  if (task.running) setTimeout(() => refreshAssignment().catch(showAssignmentError), 750);
  return true;
}

function showAssignmentError(error) {
  status.textContent = `无法读取安排状态：${error.message}。请重新打开面板查看，或检查游戏页面。`;
}

function show(data, requestedGroups) {
  const time = new Date(data.checkedAt).toLocaleTimeString('zh-CN', { hour12: false });
  const candidates = [];
  for (let leftIndex = 0; leftIndex < data.eligible.length; leftIndex++) {
    const left = data.eligible[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < data.eligible.length; rightIndex++) {
      const right = data.eligible[rightIndex];
      // 只按真实居民 ID 判断亲属，改名不影响；同父或同母、双方任一亲子关系均排除。
      if (left.parents.includes(right.id) || right.parents.includes(left.id) ||
          left.parents.some(parentId => right.parents.includes(parentId))) continue;
      candidates.push([left, right]);
    }
  }
  // 从全部合法组合中优先选总分最高的一组，再选未使用居民的下一组。
  candidates.sort((left, right) => (right[0].total + right[1].total) - (left[0].total + left[1].total));
  const pairs = [];
  const used = new Set();
  for (const pair of candidates) {
    if (pairs.length === requestedGroups) break;
    if (used.has(pair[0].id) || used.has(pair[1].id)) continue;
    pairs.push(pair);
    used.add(pair[0].id);
    used.add(pair[1].id);
  }
  const count = pairs.length;
  recommendedPairs = pairs;
  status.textContent = `已读取 ${data.count} 人 · 状态可用 ${data.eligibleCount} 人\n已推荐 ${count} 组 · 计算时间：${time}`;
  result.hidden = count === 0;
  if (result.hidden) status.textContent += data.eligibleCount < 2 ?
    '\n状态可用的居民不足 2 人，暂无推荐组合。' : '\n可用居民之间均有亲属关系，暂无推荐组合。';
  else if (count < requestedGroups) status.textContent += '\n其余居民不足两人或存在亲属关系，未凑满指定组数。';
  for (let index = 0; index < count; index++) {
    const pair = pairs[index];
    const group = document.createElement('li');
    const groupHeading = document.createElement('p');
    groupHeading.className = 'result-heading';
    const title = document.createElement('strong');
    title.textContent = `第 ${index + 1} 组`;
    const score = document.createElement('span');
    score.textContent = '合计 ';
    const scoreValue = document.createElement('b');
    scoreValue.textContent = pair[0].total + pair[1].total;
    score.append(scoreValue);
    groupHeading.append(title, score);
    const members = document.createElement('ul');
    members.className = 'pair-members';
    for (const resident of pair) {
      const item = document.createElement('li');
      const heading = document.createElement('div');
      heading.className = 'resident-heading';
      const name = document.createElement('strong');
      name.className = 'resident-name';
      // 居民可自行改名，用 textContent 展示，避免将名字解释成 HTML。
      name.textContent = resident.name;
      const total = document.createElement('span');
      total.className = 'resident-total';
      total.textContent = `${resident.total} 点`;
      heading.append(name, total);
      const stats = document.createElement('div');
      stats.className = 'stats';
      resident.stats.forEach((value, index) => {
        const stat = document.createElement('span');
        stat.textContent = `${labels[index]} ${value}`;
        stats.append(stat);
      });
      item.append(heading, stats);
      members.append(item);
    }
    group.append(groupHeading, members);
    pairList.append(group);
  }
  excluded.hidden = data.excluded.length === 0;
  document.querySelector('#excluded-count').textContent = `已排除 ${data.excluded.length} 人 · 查看原因`;
  for (const resident of data.excluded) {
    const item = document.createElement('li');
    item.textContent = `${resident.name}（属性合计 ${resident.total} 点）：${resident.reasons.join('；')}`;
    excludedList.append(item);
  }
}

async function calculateResidents(requestedGroups) {
  recommendedPairs = [];
  setBusy(true);
  result.hidden = true;
  excluded.hidden = true;
  excluded.open = false;
  pairList.replaceChildren();
  excludedList.replaceChildren();
  status.textContent = '正在读取全部居民并计算…';
  try {
    // 脚本在当前游戏页读取同源数据；每次点击都重新读取，不缓存过期推荐。
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, files: ['pairing/content.js'] });
    if (injection.result.error) throw new Error(injection.result.error);
    show(injection.result, requestedGroups);
  } catch (error) {
    status.textContent = `计算失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

settings.addEventListener('submit', event => {
  event.preventDefault();
  calculateResidents(groupCount.valueAsNumber);
});
assignDorms.addEventListener('click', async () => {
  setBusy(true);
  status.textContent = '正在安排宿舍…';
  try {
    const [auto] = await chrome.scripting.executeScript({ target: { tabId }, func: () => Boolean(globalThis.__fengbaoShelterAuto?.running) });
    if (auto.result) {
      status.textContent = '一键托管正在运行，请先关闭托管再安排宿舍。';
      setBusy(false);
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['pairing/skip-unavailable.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, func: startDormAssignment, args: [recommendedPairs] });
    // 本批结果执行后失效，必须重新计算才能再发起安排。
    recommendedPairs = [];
    await refreshAssignment();
  } catch (error) {
    showAssignmentError(error);
  }
});

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !/^https:\/\/game\.arkengine\.me\/shelter\/?(?:[?#]|$)/.test(tab.url)) {
    status.textContent = '请在 “避难所” 页面打开此功能';
    return;
  }
  tabId = tab.id;
  // 面板关闭或切换功能不打断调动，重新打开时接着显示同一批次。
  if (await refreshAssignment()) return;
  setBusy(false);
  status.textContent = '选择推荐组数后计算配对。';
}

initialize().catch(error => {
  status.textContent = `读取当前页面失败：${error.message}`;
});
