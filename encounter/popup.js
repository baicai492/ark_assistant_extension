const form = document.querySelector("#settings");
const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
const status = document.querySelector("#status");
const fields = ["waitSec", "maxRetries", "cycleSec"];
let tabId;
let poll;

function show(state) {
  start.disabled = state.running;
  stop.disabled = !state.running;
  fields.forEach(id => { document.getElementById(id).disabled = state.running; });
  status.textContent = `${state.message} · 已处理 ${state.rounds} 轮`;
}

function showError(error) {
  clearInterval(poll);
  start.disabled = true;
  stop.disabled = true;
  status.textContent = `连接失败：${error.message}`;
}

async function send(action, settings) {
  return chrome.tabs.sendMessage(tabId, { type: "fengbao-encounter", action, settings });
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const settings = Object.fromEntries(fields.map(id => [id, Number(document.getElementById(id).value)]));
  try { show(await send("start", settings)); } catch (error) { showError(error); }
});
stop.addEventListener("click", async () => {
  try { show(await send("stop")); } catch (error) { showError(error); }
});

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab.url);
  if (url.origin !== "https://game.arkengine.me" || !/^\/cultivate\/?$/.test(url.pathname)) {
    status.textContent = "请在 “修仙” 页面打开此扩展";
    return;
  }
  tabId = tab.id;
  // 仅在用户打开扩展时注入到当前目标页，不申请全站访问权限。
  await chrome.scripting.executeScript({ target: { tabId }, files: ["encounter/content.js"] });
  const state = await send("status");
  fields.forEach(id => { document.getElementById(id).value = state.settings[id]; });
  show(state);
  poll = setInterval(async () => {
    try { show(await send("status")); } catch (error) { showError(error); }
  }, 500);
}
initialize().catch(showError);

