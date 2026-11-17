const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const status = document.querySelector('#status');
const autoFocus = document.querySelector('#autoFocus');
let tabId;
let poll;

function show(state) {
  start.disabled = state.running;
  stop.disabled = !state.running;
  autoFocus.disabled = state.running;
  if (state.running) autoFocus.checked = state.autoFocus === true;
  status.textContent = `${state.message}\n已完成 ${state.rounds} 轮 · 已布置 ${state.step}/9`;
}

function showError(error) {
  status.textContent = `页面连接失败：${error.message}\n页面跳转时请稍候；若持续失败，请刷新页面后重新打开扩展。`;
  start.disabled = true;
  stop.disabled = true;
}

async function send(action) {
  return chrome.tabs.sendMessage(tabId, { type: 'fengbao-overload', action, autoFocus: autoFocus.checked });
}

start.addEventListener('click', async () => {
  try { show(await send('start')); } catch (error) { showError(error); }
});
stop.addEventListener('click', async () => {
  try { show(await send('stop')); } catch (error) { showError(error); }
});

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url?.startsWith('https://game.arkengine.me/')) {
    status.textContent = '请在 “作战” 页面打开此扩展';
    return;
  }
  tabId = tab.id;
  // 兼容安装前已打开的页面，脚本本身会防止重复初始化。
  await chrome.scripting.executeScript({ target: { tabId }, files: ['overload/content.js'] });
  show(await send('status'));
  poll = setInterval(async () => {
    try { show(await send('status')); } catch (error) { showError(error); }
  }, 500);
}

window.addEventListener('pagehide', () => clearInterval(poll));
initialize().catch(showError);

