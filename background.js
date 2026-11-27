const focusPrefix = 'fengbao-overload-focus-';
const awakePrefix = 'fengbao-overload-awake-';
const shelterLogPrefix = 'fengbao-shelter-log-';
const shelterLogHost = 'com.fengbao.shelter_log';
// 扩展存储和面板只保留最近一段；发给 host 的也是最近一段快照，
// host 会根据本地文件尾部去重后追加，本地文件本身持续累积。
const shelterLogLimit = 2000;
// 推送和清空都串行执行，避免多个 native host 进程同时写同一个日志文件。
let shelterLogQueue = Promise.resolve();
// 单次读取页面失败（页面切换、扩展刚重载）不能立刻停掉定时推送；
// 连续多次确认页面里确实没有运行中的任务后才停止。
const shelterLogMisses = new Map();
function queueShelterLogTask(task) {
  const run = shelterLogQueue.then(task);
  shelterLogQueue = run.catch(() => {});
  return run;
}

async function stopShelterLog(tabId) {
  await chrome.alarms.clear(`${shelterLogPrefix}${tabId}`);
}

// 通过本地 native host 把日志快照追加写入插件目录的 logs/shelter.log。
// host 自己会和文件尾部比对，只写新增行，所以重复发送快照不会产生重复日志。
// 写入结果存到扩展存储，面板可以显示具体路径或失败原因。
async function sendShelterLogs(logs) {
  try {
    const response = await chrome.runtime.sendNativeMessage(shelterLogHost, { command: 'log', logs });
    if (response?.error || response?.ok !== true) throw new Error(response?.error || '本地日志程序未确认写入');
    await chrome.storage.local.set({ shelterLogStatus: { ok: true, file: response?.file ?? '', at: Date.now() } });
  } catch (error) {
    try {
      await chrome.storage.local.set({ shelterLogStatus: { ok: false, error: error.message, at: Date.now() } });
    } catch {}
  }
}

async function clearShelterLogs() {
  try {
    const response = await chrome.runtime.sendNativeMessage(shelterLogHost, { command: 'clear' });
    if (response?.error || response?.ok !== true) throw new Error(response?.error || '本地日志程序未确认清空');
    await chrome.storage.local.set({ shelterLogStatus: { ok: true, file: response?.file ?? '', at: Date.now() } });
  } catch (error) {
    try {
      await chrome.storage.local.set({ shelterLogStatus: { ok: false, error: error.message, at: Date.now() } });
    } catch {}
    throw error;
  }
}

// 当前页面的内存日志是完整的；存储里可能已有其中一部分。找到页面日志开头
// 与存储末尾的重叠部分，只补新增行，避免重复写入。
function mergeLogs(stored, page) {
  if (!stored.length) return page;
  if (!page.length) return stored;
  for (let size = Math.min(stored.length, page.length); size > 0; size--) {
    let same = true;
    for (let index = 0; index < size; index++) {
      if (stored[stored.length - size + index] !== page[index]) { same = false; break; }
    }
    if (same) return stored.concat(page.slice(size));
  }
  return stored.concat(page);
}

async function readPageLog(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const task = globalThis.__fengbaoShelterAuto;
        return task
          ? { running: Boolean(task.running), logs: Array.isArray(task.logs) ? task.logs : [] }
          : { running: false, logs: [] };
      }
    });
    const page = result?.result;
    return page ? { ok: true, ...page } : { ok: true, running: false, logs: [] };
  } catch {
    return { ok: false, running: false, logs: [] };
  }
}

// 记录哪些标签页需要持续推送日志；扩展重载或后台重启后据此恢复 alarm。
async function rememberShelterLogWatch(tabId, running) {
  try {
    const { shelterLogWatch = {} } = await chrome.storage.local.get('shelterLogWatch');
    if (running) shelterLogWatch[tabId] = true;
    else delete shelterLogWatch[tabId];
    await chrome.storage.local.set({ shelterLogWatch });
  } catch {}
}
async function restoreShelterLogWatches() {
  try {
    const { shelterLogWatch = {} } = await chrome.storage.local.get('shelterLogWatch');
    for (const id of Object.keys(shelterLogWatch)) {
      const tabId = Number(id);
      if (!Number.isInteger(tabId)) continue;
      await chrome.alarms.create(`${shelterLogPrefix}${tabId}`, { periodInMinutes: 0.5 });
      await queueShelterLogTask(() => pushShelterLog(tabId)).catch(() => {});
    }
  } catch {}
}

// 每 30 秒把最近一段日志交给 host 追加；host 会去重，重复发送不会写重复行。
async function pushShelterLog(tabId) {
  const page = await readPageLog(tabId);
  const { shelterLogs = [] } = await chrome.storage.local.get('shelterLogs');
  // 先各自截断再合并，避免为了写最近一段而反复拷贝整份历史日志。
  const logs = mergeLogs(shelterLogs.slice(-shelterLogLimit), (page.logs ?? []).slice(-shelterLogLimit)).slice(-shelterLogLimit);
  if (logs.length) await sendShelterLogs(logs);
  if (!page.ok) return;
  if (page.running) {
    shelterLogMisses.delete(tabId);
    return;
  }
  const misses = (shelterLogMisses.get(tabId) ?? 0) + 1;
  shelterLogMisses.set(tabId, misses);
  if (misses < 3) return;
  shelterLogMisses.delete(tabId);
  await rememberShelterLogWatch(tabId, false);
  await stopShelterLog(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'fengbao-shelter-log-clear') return;
  (async () => {
    await queueShelterLogTask(clearShelterLogs);
  })().then(() => respond({ ok: true }), error => respond({ error: error.message }));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'fengbao-shelter-log-watch') return;
  const tabId = Number(message.tabId);
  (async () => {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('缺少标签页');
    if (message.running) {
      await chrome.alarms.create(`${shelterLogPrefix}${tabId}`, { periodInMinutes: 0.5 });
      await rememberShelterLogWatch(tabId, true);
      await queueShelterLogTask(() => pushShelterLog(tabId));
    } else {
      // 关闭托管时页面里可能还有最后几行没写入存储，稍等后取一次内存日志。
      await new Promise(resolve => setTimeout(resolve, 500));
      await queueShelterLogTask(() => pushShelterLog(tabId));
      await rememberShelterLogWatch(tabId, false);
      await stopShelterLog(tabId);
    }
  })().then(() => respond({ ok: true }), error => respond({ error: error.message }));
  return true;
});

chrome.runtime.onStartup?.addListener(() => { void restoreShelterLogWatches(); });
chrome.runtime.onInstalled?.addListener(() => { void restoreShelterLogWatches(); });
chrome.tabs.onRemoved?.addListener(tabId => {
  shelterLogMisses.delete(tabId);
  void rememberShelterLogWatch(tabId, false);
  void stopShelterLog(tabId);
});

async function focusTab(tabId) {
  // 激活游戏标签页，同时将所属浏览器窗口置于前台。
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function releaseTab(tabId) {
  await chrome.alarms.clear(`${focusPrefix}${tabId}`);
  await chrome.alarms.clear(`${awakePrefix}${tabId}`);
  const alarms = await chrome.alarms.getAll();
  if (!alarms.some(alarm => alarm.name.startsWith(focusPrefix) || alarm.name.startsWith(awakePrefix))) {
    chrome.power.releaseKeepAwake();
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'fengbao-overload-keep-awake') return;
  const tabId = sender.tab.id;
  (async () => {
    if (message.running) {
      // 系统级防休眠允许屏幕关闭；后台闹钟不依赖游戏页面的定时器。
      chrome.power.requestKeepAwake('system');
      // 闹钟名称区分仅防休眠与主动聚焦，后台重启后仍保留用户选择。
      const prefix = message.autoFocus ? focusPrefix : awakePrefix;
      const otherPrefix = message.autoFocus ? awakePrefix : focusPrefix;
      await chrome.alarms.clear(`${otherPrefix}${tabId}`);
      await chrome.alarms.create(`${prefix}${tabId}`, { periodInMinutes: 0.5 });
      if (message.autoFocus) await focusTab(tabId);
    } else {
      await releaseTab(tabId);
    }
  })().then(() => respond({ ok: true }), async error => {
    console.error('速刷关卡保活失败：', error);
    await releaseTab(tabId);
    respond({ error: error.message });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name.startsWith(shelterLogPrefix)) {
    void queueShelterLogTask(() => pushShelterLog(Number(alarm.name.slice(shelterLogPrefix.length)))).catch(() => {});
    return;
  }
  const autoFocus = alarm.name.startsWith(focusPrefix);
  if (!autoFocus && !alarm.name.startsWith(awakePrefix)) return;
  const tabId = Number(alarm.name.slice((autoFocus ? focusPrefix : awakePrefix).length));
  try {
    chrome.power.requestKeepAwake('system');
    if (autoFocus) await focusTab(tabId);
  } catch (error) {
    console.error('速刷关卡定期保活失败：', error);
    await releaseTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => { void releaseTab(tabId); void stopShelterLog(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 离开任务页面时释放保活，正常关卡跳转不受影响。
  if (changeInfo.url && !/^https:\/\/game\.arkengine\.me\/(?:levels|play\/35)\/?(?:[?#]|$)/.test(changeInfo.url)) {
    void releaseTab(tabId);
  }
});
