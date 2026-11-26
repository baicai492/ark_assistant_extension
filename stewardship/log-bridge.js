// 避难所日志桥接：页面里的托管脚本通过 postMessage 发送日志，
// 这里批量写入 chrome.storage.local，刷新页面或关闭面板后仍可查看。
// 与 yuyugu 等扩展的做法一致，不依赖本地进程。
(() => {
  if (globalThis.__fengbaoShelterLogBridge) return;
  globalThis.__fengbaoShelterLogBridge = true;
  let pending = [];
  let timer = 0;
  // 与托管脚本保持一致：只保留最近一段日志，避免存储无限增长。
  const logLimit = 2000;
  const flush = async () => {
    timer = 0;
    try {
      const { shelterLogs = [] } = await chrome.storage.local.get('shelterLogs');
      const batch = pending;
      pending = [];
      await chrome.storage.local.set({ shelterLogs: shelterLogs.concat(batch).slice(-logLimit) });
    } catch {}
  };
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.src !== 'fengbao-shelter-log') return;
    // 目标建造进度：注入环境拿不到 storage API 时仍能保存，重启后继续原进度。
    if (data.type === 'target-progress') {
      if (data.progress && typeof data.progress === 'object') {
        chrome.storage.local.set({ shelterTargetProgress: data.progress }).catch(() => {});
      }
      return;
    }
    if (data.type !== 'log' || typeof data.line !== 'string') return;
    pending.push(data.line);
    if (!timer) timer = setTimeout(flush, 400);
  });
  // 弹窗里点了“清空日志”时，丢弃尚未写入的批次，避免旧日志被重新写回。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.shelterLogs && !changes.shelterLogs.newValue) pending = [];
  });
})();
