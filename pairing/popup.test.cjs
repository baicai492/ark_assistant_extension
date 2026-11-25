const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, 'popup.html'), 'utf8');
const script = readFileSync(join(__dirname, 'popup.js'), 'utf8');
const settle = async () => { for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate); };
async function popup(task = null, saved) {
  class Element {
    constructor() { this.checked = false; this.disabled = false; this.hidden = false; this.textContent = ''; this.children = []; this.listeners = {}; }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    replaceChildren() { this.children = []; }
    append(...items) { this.children.push(...items); }
    async emit(name) { for (const fn of this.listeners[name] ?? []) await fn({ preventDefault() {} }); await settle(); }
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  elements.get('group-count').valueAsNumber = 1;
  elements.get('group-count').id = 'group-count';
  elements.get('group-count').type = 'number';
  elements.get('group-count').validity = { valid: true };
  const values = new Map(saved === undefined ? [] : [['fengbao-pairing-return', saved]]), injections = [];
  const page = vm.createContext({ __fengbaoDormAssignment: task });
  vm.runInContext(`
    function startDormAssignment(pairs, options) {
      globalThis.selectedPairs = pairs;
      globalThis.selectedOptions = options;
      globalThis.__fengbaoDormAssignment = { running: false, monitoring: options.returnToWork, returnToWork: options.returnToWork,
        message: '配对已挂载', completed: [], entries: [], issues: [], wake() { globalThis.woken = true; } };
    }
  `, page);
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id), querySelector: selector => { assert.ok(elements.has(selector.slice(1)), selector); return elements.get(selector.slice(1)); },
      createElement: () => new Element() },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    setTimeout: () => 1, clearTimeout() {},
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => [{ id: 7, url: 'https://game.arkengine.me/shelter' }] }, scripting: {
      executeScript: async request => {
        injections.push(request);
        if (request.files) {
          if (request.files[0] === 'pairing/content.js') return [{ result: { checkedAt: 1000000, count: 2, eligibleCount: 2, excluded: [],
            eligible: [1, 2].map(id => ({ id, name: `居民${id}`, parents: [], stats: [5, 5, 5, 5, 5, 5, 5], total: 35 })) } }];
          return [];
        }
        page.args = request.args ?? [];
        const result = vm.runInContext(`(${request.func.toString()})(...args)`, page);
        // 真实注入返回值要可序列化，页面中的 wake 函数不能随状态返回。
        return [{ result: result === undefined ? undefined : structuredClone(result) }];
      }
    } }
  });
  for (const file of ['../shared/settings-storage.js', 'settings.js']) vm.runInContext(readFileSync(join(__dirname, file), 'utf8'), context);
  vm.runInContext(script, context);
  await settle();
  return { context, page, elements, values, injections };
}

test('配对面板默认自动归岗，计算后注入执行器并传递选项', async () => {
  for (const enabled of [true, false]) {
    const ui = await popup();
    assert.equal(ui.elements.get('return-to-work').checked, true);
    ui.elements.get('return-to-work').checked = enabled;
    await ui.elements.get('return-to-work').emit('change');
    assert.equal(ui.values.get('fengbao-pairing-return'), String(enabled));
    await ui.elements.get('settings').emit('submit');
    assert.equal(ui.elements.get('assign-dorms').disabled, false);
    await ui.elements.get('assign-dorms').emit('click');
    assert.equal(ui.page.selectedOptions.returnToWork, enabled);
    assert.deepEqual(Array.from(ui.page.selectedPairs[0], item => item.id), [1, 2]);
    assert.ok(ui.injections.some(item => item.files?.includes('pairing/assign.js')));
    assert.equal(ui.elements.get('calculate').disabled, enabled);
    assert.equal(ui.elements.get('return-now').disabled, !enabled);
  }
});

test('重开面板恢复挂载记录，结束按钮请求归岗，完成后可重新计算', async () => {
  const task = { running: false, monitoring: true, returnToWork: true, message: '等待组建家庭', completed: [], issues: [],
    entries: [{ name: '居民1', originalLabel: '1 层房间 1', status: 'waiting', note: '原岗位已满' }], wake() { this.woken = true; } };
  const ui = await popup(task, 'false');
  assert.equal(ui.elements.get('return-to-work').checked, true, '以已启动任务的选项为准');
  assert.match(ui.elements.get('return-records').children[0].textContent, /原岗位已满/);
  assert.equal(ui.elements.get('assign-dorms').disabled, true);
  await ui.elements.get('return-now').emit('click');
  assert.equal(task.returnRequested, true);
  assert.equal(task.woken, true);
  assert.equal(ui.elements.get('return-now').disabled, true);
  task.monitoring = false;
  task.entries[0].status = 'returned';
  await ui.context.refreshAssignment();
  assert.equal(ui.elements.get('calculate').disabled, false);
  assert.match(ui.elements.get('return-records').children[0].textContent, /已归岗/);
});

test('配对面板展示不可用宿舍和归岗等待的具体标签，状态恢复后清除', async () => {
  const task = { running: false, monitoring: true, returnToWork: true, message: '等待归岗', completed: [], issues: [],
    entries: [{ name: '居民1', originalLabel: '1 层房间 1', status: 'waiting', note: '原岗位：升级中，等待归岗' }],
    unavailableRooms: [{ id: 3, label: '3 层宿舍（房间 3）', reasons: ['升级中', '停电'] }], wake() {} };
  const ui = await popup(task);
  assert.equal(ui.elements.get('unavailable-rooms').hidden, false);
  assert.match(ui.elements.get('unavailable-room-list').children[0].textContent, /房间 3.*升级中、停电/);
  assert.match(ui.elements.get('return-records').children[0].textContent, /原岗位：升级中/);
  task.unavailableRooms = [];
  await ui.context.refreshAssignment();
  assert.equal(ui.elements.get('unavailable-rooms').hidden, true);
  assert.equal(ui.elements.get('unavailable-room-list').children.length, 0);
});
