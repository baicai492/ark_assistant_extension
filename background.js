const focusPrefix = 'fengbao-overload-focus-';
const awakePrefix = 'fengbao-overload-awake-';

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

chrome.tabs.onRemoved.addListener(tabId => { void releaseTab(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 离开任务页面时释放保活，正常关卡跳转不受影响。
  if (changeInfo.url && !/^https:\/\/game\.arkengine\.me\/(?:levels|play\/35)\/?(?:[?#]|$)/.test(changeInfo.url)) {
    void releaseTab(tabId);
  }
});
