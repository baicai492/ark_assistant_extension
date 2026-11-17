const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const status = document.querySelector('#status');
const interval = document.querySelector('#interval');
const reserve = document.querySelector('#reserve');
let tabId; let poll;
let initialized = false;
function show(state) {
  start.disabled = state.running;
  stop.disabled = !state.running;
  interval.disabled = state.running;
  reserve.disabled = state.running;
  // 重开面板时从页面脚本恢复参数，停止后允许修改且不被轮询覆盖。
  if (!initialized || state.running) {
    interval.value = state.interval;
    reserve.checked = state.reserve;
    initialized = true;
  }
  const remaining = Math.max(0, Math.ceil((state.waitUntil - Date.now()) / 1000));
  const waiting = state.waitUntil
    ? `剩余等待：${Math.floor(remaining / 3600)} 小时 ${Math.floor(remaining % 3600 / 60)} 分 ${remaining % 60} 秒\n预计局部刷新：${new Date(state.waitUntil).toLocaleString('zh-CN', { hour12: false })}`
    : '剩余等待：未在计时';
  status.textContent = `${state.running ? '运行中' : '已停止'}｜${state.message}\n已完成 ${state.rounds} 轮\n${waiting}`;
}
function showError(error) { clearInterval(poll); start.disabled = true; stop.disabled = true; status.textContent = `连接失败：${error.message}`; }
async function send(action) { return chrome.tabs.sendMessage(tabId, { type: 'fengbao-fog', action, interval: interval.value, reserve: reserve.checked }); }
start.addEventListener('click', async () => { try { show(await send('start')); } catch (error) { showError(error); } });
stop.addEventListener('click', async () => { try { show(await send('stop')); } catch (error) { showError(error); } });
async function initialize() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab.url || !/^https:\/\/game\.arkengine\.me\/cultivate\/fog\/?(?:[?#]|$)/.test(tab.url)) { status.textContent = '请在“修仙-迷雾”页面打开此扩展'; return; } tabId = tab.id; await chrome.scripting.executeScript({ target: { tabId }, files: ['fog/content.js'] }); show(await send('status')); poll = setInterval(async () => { try { show(await send('status')); } catch (error) { showError(error); } }, 500); }
initialize().catch(showError);
