const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
async function popup({ task = null, saved, stored = {}, hostError = false } = {}) {
  class Element {
    constructor(tag = '') {
      this.tagName = tag.toUpperCase(); this.value = ''; this.checked = this.disabled = this.open = false;
      this.textContent = ''; this.children = []; this.listeners = {}; this.dataset = {};
    }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    async emit(name) { for (const fn of this.listeners[name] ?? []) await fn({ preventDefault() {}, target: this }); await settle(); }
    querySelector() { return this.summary ??= new Element('summary'); }
    querySelectorAll(tag) { return this.children.filter(child => child.tagName === tag.toUpperCase()); }
    setAttribute(name, value) { this[name] = value; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    append(...children) { for (const child of children) this.children.push(...(child.tagName === 'FRAGMENT' ? child.children : [child])); }
  }
  const elements = new Map();
  for (const [, tag, attrs, id] of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const el = new Element(tag);
    el.id = id; el.type = attrs.match(/\btype="([^"]*)"/)?.[1] ?? '';
    Object.defineProperty(el, 'valueAsNumber', { get() { return Number(this.value); } });
    el.validity = { valid: true };
    el.checked = /\bchecked\b/.test(attrs); el.disabled = /\bdisabled\b/.test(attrs); el.open = /\bopen\b/.test(attrs);
    el.value = attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
    elements.set(id, el);
  }
  elements.get('dismiss-stat-key').value = 'end';
  const values = new Map(saved ? [['fengbao-auto-training', saved]] : []);
  const store = { shelterLogs: ['测试日志'], ...structuredClone(stored) }, injections = [], messages = [], exported = [];
  const local = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]])); },
    async set(values) { Object.assign(store, values); }, async remove(key) { delete store[key]; } };
  const page = vm.createContext({ __fengbaoShelterAuto: task, chrome: { storage: { local } }, clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ serverTime: 1000000, state: { rooms: [], residents: [], births: [], quests: [] } }) }) });
  vm.runInContext(`function startShelterAuto(...args) {
    globalThis.selected = args;
    globalThis.__fengbaoShelterAuto = { running: true, intervalSeconds: args[0], recallEvents: args[1],
      dismissEnabled: args[2], dismissTotal: args[3], dismissStatEnabled: args[4], dismissStatKey: args[5], dismissStat: args[6],
      rescueCount: args[7], rescueEnabled: args[8], rescueMode: args[9], godEnabled: args[10], birthEnabled: args[11],
      questEnabled: args[12], trainingOptions: args[13], upgradeEnabled: args[14], upgradeDigEnabled: args[15], upgradeOrder: args[16], craftOutfitsEnabled: args[17], targetEnabled: args[18], targetRoom: args[19], targetCount: args[20], targetStat: args[21], populationOptions: args[22], logs: [], parentReturns: [], message: '运行中' };
  }`, page);
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id), querySelector(selector) { assert.ok(elements.has(selector.slice(1)), selector); return elements.get(selector.slice(1)); },
      createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment') },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    setTimeout: () => 1, clearTimeout() {},
    window: { showSaveFilePicker: async () => ({ name: '日志.txt', createWritable: async () => ({
      write: async text => exported.push(text), close: async () => {} }) }) },
    chrome: { storage: { local }, tabs: { query: async () => [{ id: 42, url: 'https://game.arkengine.me/shelter' }] },
      runtime: { sendMessage: async message => { messages.push(message); return hostError ? { error: '未安装' } : { ok: true }; },
        sendNativeMessage: async () => { if (hostError) throw new Error('未安装'); return { ok: true, file: '测试目录/logs/shelter.log' }; } },
      scripting: { executeScript: async request => {
        injections.push(request);
        assert.equal(request.target.tabId, 42);
        if (request.files) {
          for (const file of request.files.filter(file => !file.endsWith('runner.js'))) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), page);
          return [];
        }
        page.args = request.args ?? [];
        const result = await vm.runInContext(`(${request.func.toString()})(...args)`, page);
        return [{ result: result === undefined ? undefined : structuredClone(result) }];
      } }
    }
  });
  for (const file of ['../shared/settings-storage.js', 'settings.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  vm.runInContext(script, context); await settle();
  return { elements, page, context, values, store, exported, messages };
}

test('托管面板默认600秒、原生救援一次，进阶开关关闭并传递保存的训练偏好', async () => {
  const ui = await popup(); const get = id => ui.elements.get(id);
  assert.equal(get('interval').value, '600');
  assert.ok(get('rescue-enabled').checked && get('rescue-mode-auto').checked);
  assert.equal(get('rescue-count').value, '1');
  for (const id of ['god-enabled', 'birth-enabled', 'quest-enabled', 'train-charisma', 'train-luck']) assert.equal(get(id).checked, false);
  get('train-luck').checked = true; await get('train-luck').emit('change');
  get('quest-enabled').checked = true;
  await get('settings').emit('submit');
  assert.equal(ui.page.selected[12], true);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.page.selected[13])), { trainCharisma: false, trainLuck: true });
  assert.equal(get('train-luck').disabled, true);
  const reopened = await popup({ saved: ui.values.get('fengbao-auto-training') });
  assert.equal(reopened.elements.get('train-luck').checked, true);
});

test('托管面板恢复运行参数、显示具体归岗原因并请求结束配对和停止', async () => {
  const task = { running: true, godEnabled: false, birthEnabled: true, intervalSeconds: 600, recallEvents: 6,
    rescueEnabled: true, rescueMode: 'auto', rescueCount: 1, dismissTotal: 20, trainingOptions: { trainLuck: true },
    parentReturns: [{ residentId: 1, name: '亲本★', originalRoomId: 2, status: 'waiting', note: '升级中、停电' }], logs: [],
    wake() { this.woken = true; } };
  const ui = await popup({ task });
  assert.equal(ui.elements.get('toggle').formNoValidate, true);
  assert.equal(ui.elements.get('train-luck').checked, true);
  assert.match(ui.elements.get('return-records').children[0].textContent, /升级中、停电/);
  await ui.elements.get('return-parents').emit('click');
  assert.equal(task.birthEnabled, false); assert.equal(task.returnRequested, true); assert.equal(task.woken, true);
  await ui.elements.get('settings').emit('submit');
  assert.equal(task.stopRequested, true);
  task.running = false; await ui.context.refresh();
  assert.match(ui.elements.get('status').textContent, /重新开启托管/);
});

test('托管设置保存升级挖层造服装选项，重开后恢复并按相同参数启动', async () => {
  const ui = await popup();
  for (const id of ['upgrade-enabled', 'upgrade-dig-enabled', 'upgrade-craft-enabled']) {
    ui.elements.get(id).checked = true; await ui.elements.get(id).emit('change');
  }
  const reopened = await popup({ stored: ui.store });
  for (const id of ['upgrade-enabled', 'upgrade-dig-enabled', 'upgrade-craft-enabled']) assert.equal(reopened.elements.get(id).checked, true);
  await reopened.elements.get('settings').emit('submit');
  assert.equal(reopened.page.selected[14], true);
  assert.equal(reopened.page.selected[15], true);
  assert.equal(reopened.page.selected[17], true);
  assert.equal(reopened.elements.get('upgrade-enabled').disabled, true);
  assert.equal(reopened.elements.get('upgrade-order').children.length, 13);
});

test('目标建造控件独立保存恢复，启动参数不挤占训练偏好及升级选项', async () => {
  const ui = await popup();
  ui.elements.get('target-enabled').checked = true;
  ui.elements.get('target-room').value = 'training';
  ui.elements.get('target-count').value = '12';
  ui.elements.get('target-stat').value = 'agi';
  await ui.elements.get('target-enabled').emit('change');
  const reopened = await popup({ stored: ui.store });
  assert.equal(reopened.elements.get('target-enabled').checked, true);
  assert.equal(reopened.elements.get('target-stat').disabled, false);
  await reopened.elements.get('settings').emit('submit');
  assert.deepEqual(Array.from(reopened.page.selected.slice(18, 22)), [true, 'training', 12, 'agi']);
  assert.equal(reopened.page.selected[14], false);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.page.selected[13])), { trainCharisma: false, trainLuck: false });
});

test('日志导出和清空可用，本地日志未安装时保留托管能力并显示错误', async () => {
  let cleared = false;
  const task = { running: false, logs: ['测试日志'], parentReturns: [], clearLogs: async () => { cleared = true; task.logs = []; } };
  const ui = await popup({ task, hostError: true });
  assert.match(ui.elements.get('log-file').textContent, /未安装/);
  await ui.elements.get('export-logs').emit('click');
  assert.deepEqual(ui.exported, ['测试日志']);
  await ui.elements.get('clear-logs').emit('click');
  assert.equal(cleared, true);
  assert.match(ui.elements.get('status').textContent, /本地日志文件清空失败.*未安装/);
  assert.equal(ui.elements.get('toggle').disabled, false);
});

test('人口优化默认关闭、阈值60和待岗5人，设置保存并追加传参，不改原新人遣散配置', async () => {
  const ui = await popup();
  assert.equal(ui.elements.get('population-enabled').checked, false);
  assert.equal(ui.elements.get('population-total').value, '60');
  assert.equal(ui.elements.get('population-min-idle').value, '5');
  assert.equal(ui.elements.get('population-total').disabled, true);
  ui.elements.get('population-enabled').checked = true;
  ui.elements.get('population-total').value = '63';
  ui.elements.get('population-min-idle').value = '8';
  await ui.elements.get('population-enabled').emit('change');
  assert.equal(ui.elements.get('population-total').disabled, false);
  const reopened = await popup({ stored: ui.store });
  assert.equal(reopened.elements.get('population-enabled').checked, true);
  assert.equal(reopened.elements.get('population-total').value, 63);
  await reopened.elements.get('settings').emit('submit');
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.page.selected[22])), { enabled: true, total: 63, minIdle: 8 });
  assert.equal(reopened.page.selected[2], false);
  assert.equal(reopened.page.selected[4], false);
  assert.equal(reopened.elements.get('population-enabled').disabled, true);
  assert.equal(reopened.elements.get('population-min-idle').disabled, true);
});

test('人口优化运行参数优先于本地配置，旧任务无该参数时维持关闭', async () => {
  const task = { running: true, intervalSeconds: 600, recallEvents: 6, dismissTotal: 60,
    populationOptions: { enabled: true, total: 60, minIdle: 7 }, parentReturns: [], logs: [] };
  const ui = await popup({ task, stored: { 'fengbao-settings-stewardship': { 'population-total': 65 } } });
  assert.equal(ui.elements.get('population-total').value, 60);
  assert.equal(ui.elements.get('population-min-idle').value, 7);
  delete task.populationOptions;
  await ui.context.refresh();
  assert.equal(ui.elements.get('population-enabled').checked, false);
});
