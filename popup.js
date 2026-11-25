const panel = document.querySelector('#panel');
let panelObserver;
panel.addEventListener('load', () => {
  panelObserver?.disconnect();
  const body = panel.contentDocument.body;
  // 按内容和上下边距撑开面板，不设最小高度，避免留白撑出外层滚动条。
  panelObserver = new ResizeObserver(() => {
    panel.style.height = `${Math.ceil(body.getBoundingClientRect().height) + 32}px`;
  });
  panelObserver.observe(body);
});
const buttons = [...document.querySelectorAll('nav button')];
const mode = document.querySelector('#mode');
// 切换模式时保留本次打开面板中各模式最后查看的功能。
const selectedModules = { cultivation: 'encounter', shelter: 'pairing' };
function selectModule(name) {
  const selectedMode = buttons.find(button => button.dataset.module === name).closest('nav').dataset.mode;
  mode.value = selectedMode;
  selectedModules[selectedMode] = name;
  for (const nav of document.querySelectorAll('nav')) nav.hidden = nav.dataset.mode !== selectedMode;
  for (const button of buttons) {
    button.setAttribute('aria-pressed', String(button.dataset.module === name));
    if (button.dataset.module === name) panel.title = button.textContent;
  }
  // 各功能独立加载原有控制面板，任务状态仍由页面脚本管理。
  panel.src = `${name}/popup.html`;
}
buttons.forEach(button => button.addEventListener('click', () => selectModule(button.dataset.module)));
mode.addEventListener('change', () => selectModule(selectedModules[mode.value]));
async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const path = tab.url ? new URL(tab.url).pathname : '';
  const name = /^\/shelter\/?$/.test(path) ? 'pairing' :
    /^\/cultivate\/fog\/?$/.test(path) ? 'fog' :
    /^\/activities\/expedition\/?$/.test(path) ? 'expedition' :
    /^\/cultivate\/?$/.test(path) ? 'encounter' : 'overload';
  selectModule(name);
}
initialize().catch(error => {
  document.querySelector('footer').textContent = `读取当前页面失败：${error.message}`;
  selectModule('encounter');
});
