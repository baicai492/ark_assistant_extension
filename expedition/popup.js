const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const burst = document.querySelector('#burst');
const status = document.querySelector('#status');
let tabId;
let poll;
let reconnects = 0;
let nextPoll = 0;

function show(state) {
  reconnects = 0;
  nextPoll = 0;
  start.disabled = state.running;
  stop.disabled = !state.running;
  burst.disabled = state.running;
  if (state.running) burst.checked = state.burst;
  const remaining = state.dueAt ? `\n距离领取检查：${Math.max(0, Math.ceil((state.dueAt - Date.now()) / 1000))} 秒` : '';
  status.textContent = `${state.message}${remaining}\n已完成 ${state.rounds} 轮`;
}

function showError(error) {
  clearInterval(poll);
  start.disabled = true;
  stop.disabled = true;
  status.textContent = `连接失败：${error.message}`;
}

async function send(action) {
  return chrome.tabs.sendMessage(tabId, { type: 'fengbao-expedition', action, burst: burst.checked });
}

start.addEventListener('click', async () => {
  try { await savedSettings.save(); show(await send('start')); } catch (error) { showError(error); }
});
stop.addEventListener('click', async () => {
  try { show(await send('stop')); } catch (error) { showError(error); }
});

async function initialize() {
  await savedSettings.ready;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url || !/^https:\/\/game\.arkengine\.me\/activities\/expedition\/?(?:[?#]|$)/.test(tab.url)) {
    status.textContent = '请在 “远征” 页面打开此扩展';
    return;
  }
  tabId = tab.id;
  // 仅注入当前远征页面，重复打开面板不会重复创建任务。
  await chrome.scripting.executeScript({ target: { tabId }, files: ['expedition/content.js'] });
  const state = await send('status');
  show(state);
  if (state.running) await savedSettings.save();
  poll = setInterval(async () => {
    if (Date.now() < nextPoll) return;
    try { show(await send('status')); } catch (error) {
      // 刷新会销毁旧页面的消息连接，等待新页面脚本加载后恢复状态显示。
      const disconnected = /Receiving end does not exist|message port closed|message channel closed|Frame with ID .* was removed|Could not establish connection/i.test(error.message);
      if (!disconnected || ++reconnects >= 20) {
        showError(error);
        return;
      }
      nextPoll = Date.now() + 5000;
      start.disabled = true;
      stop.disabled = true;
      burst.disabled = true;
      status.textContent = `页面连接暂时中断，正在重连（${reconnects}/20）…`;
    }
  }, 500);
}

initialize().catch(showError);

