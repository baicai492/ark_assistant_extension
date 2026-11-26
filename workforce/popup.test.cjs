const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, 'popup.html'), 'utf8');
const script = readFileSync(join(__dirname, 'popup.js'), 'utf8');
const storageKey = 'fengbao-workforce-options';
const settle = async () => { for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate); };

async function popup({ task = null, busy = false, saved, url = 'https://game.arkengine.me/shelter' } = {}) {
  class Element {
    constructor() { this.checked = false; this.disabled = false; this.hidden = false; this.textContent = ''; this.children = []; this.listeners = {}; this.dataset = {}; this.classList = { add() {}, remove() {} }; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    replaceChildren() { this.children = []; }
    append(child) { this.children.push(child); }
    async emit(name) { await this.listeners[name]?.({ preventDefault() {} }); await settle(); }
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  elements.get('strategy').value = html.match(/<select id="strategy"><option value="([^"]+)"/)[1];
  const values = new Map(saved === undefined ? [] : [[storageKey, saved]]);
  const page = vm.createContext({ __fengbaoWorkAssignment: task, __fengbaoShelterAuto: { running: busy } });
  vm.runInContext(`
    function startWorkforce(options) {
      globalThis.selected = options;
      globalThis.__fengbaoWorkAssignment = { kind: 'residents', running: true, stopRequested: false, options, message: '正在安排', excluded: [], rooms: [] };
    }
    globalThis.__fengbaoConfirmRoomPlan = approved => {
      globalThis.roomApproved = approved;
      globalThis.__fengbaoWorkAssignment.pendingRoomConfirmation = false;
      globalThis.__fengbaoWorkAssignment.running = false;
    };
  `, page);
  const injections = [], timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    document: { querySelector: selector => {
      const element = elements.get(selector.slice(1));
      assert.ok(element, `面板元素 ${selector} 存在`);
      return element;
    }, createElement: () => new Element() },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    confirm: () => true,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    chrome: {
      tabs: { query: async () => [{ id: 42, url }] },
      scripting: { executeScript: async request => {
        injections.push(request);
        assert.equal(request.target.tabId, 42);
        if (request.files) return [];
        page.__args = request.args ?? [];
        const result = vm.runInContext(`(${request.func.toString()})(...__args)`, page);
        return [{ result: result === undefined ? undefined : structuredClone(result) }];
      } }
    }
  });
  vm.runInContext(readFileSync(join(__dirname, 'room-planner.js'), 'utf8'), context);
  vm.runInContext(script, context);
  await settle();
  return { elements, page, context, injections, values, timers };
}

test('面板默认关闭魅力幸运训练，保存并传递所选策略和训练选项', async () => {
  const ui = await popup();
  const get = id => ui.elements.get(id);
  assert.equal(get('strategy').value, 'production');
  assert.equal(get('train-charisma').checked, false);
  assert.equal(get('train-luck').checked, false);
  assert.equal(get('start').disabled, false);
  get('strategy').value = 'highest';
  get('train-luck').checked = true;
  get('reassign-training').checked = true;
  await get('strategy').emit('change');
  const expected = { strategy: 'highest', trainCharisma: false, trainLuck: true, reassignTraining: true };
  assert.deepEqual(JSON.parse(ui.values.get(storageKey)), expected);
  await get('start').emit('click');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.page.selected)), expected);
  assert.deepEqual(Array.from(ui.injections.find(item => item.files).files), ['workforce/planner.js', 'workforce/runner.js']);
  assert.equal(get('start').disabled, true);
  assert.equal(get('strategy').disabled, true);
  assert.equal(get('stop').disabled, false);
  const reopened = await popup({ saved: ui.values.get(storageKey), task: ui.page.__fengbaoWorkAssignment });
  assert.equal(reopened.elements.get('train-luck').checked, true);
  assert.equal(reopened.elements.get('reassign-training').checked, true);
  assert.equal(reopened.elements.get('strategy').disabled, true);
});

test('面板停止正在运行的居民安排，并展示停止后的实际净产出', async () => {
  const beforeRates = { power: 0, food: -1, water: 0, scrap: 0, parts: 0, stimpak: 0 };
  const ui = await popup({ task: { kind: 'residents', running: true, stopRequested: false, beforeRates,
    rates: { ...beforeRates, power: 8, food: 2 }, message: '正在安排', excluded: [], rooms: [] } });
  await ui.elements.get('stop').emit('click');
  assert.equal(ui.page.__fengbaoWorkAssignment.stopRequested, true);
  assert.equal(ui.elements.get('stop').disabled, true);
  ui.page.__fengbaoWorkAssignment.running = false;
  ui.page.__fengbaoWorkAssignment.message = '已停止居民安排';
  await ui.context.refresh();
  assert.match(ui.elements.get('rates').textContent, /安排前 → 停止后/);
  assert.match(ui.elements.get('rates').textContent, /食物：-1\.0 → \+2\.0/);
  assert.equal(ui.elements.get('start').disabled, false);
});

test('原有房间整理确认和取消仍可操作，托管运行时禁止开始安排', async () => {
  for (const [button, approved] of [['confirm-rooms', true], ['cancel-rooms', false]]) {
    const ui = await popup({ task: { running: true, pendingRoomConfirmation: true, rooms: [], excluded: [] } });
    assert.equal(ui.elements.get('room-confirmation').hidden, false);
    assert.equal(ui.elements.get('start').disabled, true);
    assert.equal(ui.elements.get('stop').disabled, true);
    await ui.elements.get(button).emit('click');
    assert.equal(ui.page.roomApproved, approved);
    assert.equal(ui.elements.get('room-confirmation').hidden, true);
  }
  const busy = await popup({ busy: true });
  assert.equal(busy.elements.get('start').disabled, true);
  assert.equal(busy.elements.get('organize').disabled, true);
  assert.match(busy.elements.get('status').textContent, /托管/);
  const wrongPage = await popup({ url: 'https://game.arkengine.me/hub' });
  assert.equal(wrongPage.injections.length, 0);
  assert.match(wrongPage.elements.get('status').textContent, /避难所/);
});

test('一键安排面板展示多个不可用标签，重新安排后清除旧状态', async () => {
  const task = { kind: 'residents', running: false, message: '已安排', rooms: [], excluded: [],
    unavailableRooms: [{ id: 2, label: '2 层发电站（房间 2）', reasons: ['升级中', '停电'] }] };
  const ui = await popup({ task });
  assert.equal(ui.elements.get('unavailable-rooms').hidden, false);
  assert.match(ui.elements.get('unavailable-room-count').textContent, /1 间/);
  assert.match(ui.elements.get('unavailable-room-list').children[0].textContent, /房间 2.*升级中、停电/);
  task.unavailableRooms = [];
  await ui.context.refresh();
  assert.equal(ui.elements.get('unavailable-rooms').hidden, true);
  assert.equal(ui.elements.get('unavailable-room-list').children.length, 0);
});

test('面板同时展示即时产量、长期心情产量、电台加成和库存读取状态', async () => {
  const task = { kind: 'residents', running: false, message: '已安排', rooms: [], excluded: [], unavailableRooms: [],
    beforeRates: { power: 4, food: -1, water: 0, scrap: 2, parts: 0, stimpak: 0 },
    rates: { power: 8, food: 2, water: 1, scrap: 0, parts: 1, stimpak: 0 },
    beforeLongTermRates: { power: 5, food: 0, water: 1, scrap: 1, parts: 0, stimpak: 0 },
    longTermRates: { power: 9, food: 3, water: 2, scrap: -6, parts: 1, stimpak: 0 },
    happiness: { averageCurrent: 62.5, averageOneHour: 73.4, averageTarget: 84.2, radioActive: true,
      stockBasis: { food: 'stock', water: 'unknown' } },
    doorGuardRequired: false };
  const ui = await popup({ task });
  assert.equal(ui.elements.get('rates').hidden, false);
  assert.match(ui.elements.get('rates').textContent, /当前心情净产出/);
  assert.match(ui.elements.get('rates').textContent, /废料：\+2\.0 → \+0\.0\/时/);
  assert.equal(ui.elements.get('long-term-rates').hidden, false);
  assert.match(ui.elements.get('long-term-rates').textContent, /长期目标净产出/);
  assert.match(ui.elements.get('long-term-rates').textContent, /平均心情：当前 62\.5 → 1 小时后 73\.4 → 长期目标 84\.2/);
  assert.match(ui.elements.get('long-term-rates').textContent, /电台全体心情加成：已生效并计入产出/);
  assert.match(ui.elements.get('long-term-rates').textContent, /食物已读取、净水未读取/);
});

test('面板在夜间提示大门居民可生产，在白天提示恢复门卫', async () => {
  const base = { kind: 'residents', running: false, message: '已安排', rooms: [], excluded: [], unavailableRooms: [],
    rates: { power: 1, food: 1, water: 1, scrap: 0, parts: 0, stimpak: 0 } };
  const night = await popup({ task: { ...base, doorGuardRequired: false } });
  assert.equal(night.elements.get('guard-status').hidden, false);
  assert.match(night.elements.get('guard-status').textContent, /00:00–07:59/);
  assert.match(night.elements.get('guard-status').textContent, /08:00 后请重新一键安排/);
  const day = await popup({ task: { ...base, doorGuardRequired: true } });
  assert.equal(day.elements.get('guard-status').hidden, false);
  assert.match(day.elements.get('guard-status').textContent, /白天，已保留大门居民值守/);
});