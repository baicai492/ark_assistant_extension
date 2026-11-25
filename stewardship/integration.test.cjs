const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const scripts = ['stewardship/upgrade-plan.js', 'workforce/planner.js', 'workforce/gear.js', 'stewardship/god-plan.js', 'stewardship/runner.js'];
const source = scripts.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const keys = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'];
const stats = (value = 5, extra = {}) => Object.assign(Object.fromEntries(keys.map(key => [key, value])), extra);
const now = 1000000;
const at = (hour, minute = 0) => new Date(2026, 10, 24, hour, minute, 0, 0).getTime();
const room = (id, type, extra = {}) => ({ id, type, level: 1, width: 1, floor: id, col: 0,
  builtAt: 0, upgradeAt: null, incident: null, unpowered: false, craft: null, trainStat: null, ...extra });
const person = (id, extra = {}) => ({ id, name: `居民-${String(id).padStart(3, '0')}`, roomId: null,
  adultAt: 0, away: null, deadAt: null, xp: 0, hp: 100, happiness: 100, stats: stats(), parents: [],
  familyCooldownUntil: null, romance: null, weaponId: null, outfitId: null, training: 0, ...extra });
const view = (residents = [], rooms = [], extra = {}) => ({ serverTime: now, env: { quests: [], events: [], week: 'w1' },
  state: { residents, rooms, items: [], births: [], quests: [], weekly: { week: 'w1', completed: [] },
    explorers: [], resources: { stimpak: 100 }, legacy: { perks: {} }, ...extra } });
const plain = value => JSON.parse(JSON.stringify(value));
function load(globals = {}) {
  const context = vm.createContext({ AbortSignal, crypto: { randomUUID }, Date,
    location: { origin: 'https://game.arkengine.me', pathname: '/shelter' }, ...globals });
  vm.runInContext(source, context);
  return context;
}
const settle = async () => { for (let turn = 0; turn < 80; turn++) await new Promise(setImmediate); };
async function run(initial, options = {}, hooks = {}) {
  const server = structuredClone(initial), actions = [], requests = [], timers = new Map();
  let timerId = 0, clock = initial.serverTime, gets = 0;
  class FakeDate extends Date { static now() { return clock; } }
  const context = load({ Date: FakeDate,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, ...hooks.globals });
  context.fetch = async (url, init = {}) => {
    const payload = init.method === 'POST' ? JSON.parse(init.body) : null;
    const action = payload?.action;
    if (action) { actions.push(structuredClone(action)); requests.push(payload); } else gets++;
    const response = await hooks.before?.({ server, action, payload, actions, gets, context });
    if (response) return response;
    if (action) {
      const resident = server.state.residents.find(item => item.id === action.residentId);
      if (action.type === 'assign') {
        const target = server.state.rooms.find(room => room.id === action.roomId);
        if (target) {
          assert.equal(target.upgradeAt, null, '提交时不能入住升级房间');
          assert.equal(target.unpowered, false, '提交时不能入住停电房间');
          assert.ok(target.builtAt <= server.serverTime);
          if (!target.incident) assert.ok(server.state.residents.filter(item => item.roomId === target.id && item.deadAt === null && item.adultAt <= server.serverTime).length < target.width * 2);
        }
        resident.roomId = action.roomId;
      } else if (action.type === 'rename_resident') resident.name = action.name;
      else if (action.type === 'dismiss') server.state.residents = server.state.residents.filter(item => item.id !== action.residentId);
      else if (action.type === 'equip') {
        const field = action.slot === 'weapon' ? 'weaponId' : 'outfitId';
        for (const item of server.state.residents) if (item[field] === action.itemId) item[field] = null;
        resident[field] = action.itemId;
      } else if (action.type === 'quest_start') server.state.quests.push({ id: server.state.quests.length + 1, questId: action.questId,
        team: [...action.team], returnAt: null, status: 'active' });
      else if (action.type === 'quest_claim') server.state.quests = server.state.quests.filter(item => item.id !== action.runId);
      else if (action.type === 'rescue_incident') server.state.rooms.find(item => item.id === action.roomId).incident = null;
      else if (action.type === 'upgrade') server.state.rooms.find(item => item.id === action.roomId).upgradeAt = server.serverTime + 3600000;
      else if (action.type === 'craft') server.state.rooms.find(item => item.id === action.roomId).craft = { tier: action.tier, doneAt: server.serverTime + 3600000 };
      else if (action.type === 'dig') server.state.digging = { floor: server.state.depth + 1 };
    }
    await hooks.after?.({ server, action, actions, gets, context });
    return { ok: true, status: 200, redirected: false, json: async () => structuredClone(action ? { view: server } : server) };
  };
  context.startShelterAuto(600, 6, options.dismiss ?? false, options.total ?? 20,
    options.dismissStat ?? false, options.statKey ?? 'end', options.stat ?? 4, options.rescues ?? 1,
    options.rescue ?? false, options.mode ?? 'auto', options.god ?? false, options.birth ?? false, options.quest ?? false,
    options.training ?? {}, options.upgrade ?? false, options.dig ?? false, options.upgradeOrder ?? [], options.craft ?? false);
  await settle();
  const task = context.__fengbaoShelterAuto;
  assert.ok(task, '托管任务已创建');
  assert.equal(task.cycleRunning, false, task.logs.join('\n'));
  const tick = async (ms = 30000) => {
    const timer = timers.get([...timers.keys()].at(-1));
    assert.ok(timer, '存在下一次检查');
    timers.delete([...timers.keys()].at(-1));
    clock += ms;
    server.serverTime = clock;
    timer.callback();
    await settle();
  };
  const stop = async () => { task.stopRequested = true; task.wake?.(); await settle(); assert.equal(task.running, false); };
  return { server, context, task, actions, requests, tick, stop, timers };
}

test('造神目标排除升级、施工、停电和事故，并计入外出成人与挂载预留', () => {
  const state = view([person(1, { name: '亲本★', roomId: 1, stats: stats(10, { per: 9 }) })],
    [room(1, 'training', { trainStat: 'str' }), room(2, 'training', { trainStat: 'per' })]);
  for (const changed of [{ upgradeAt: now + 1 }, { builtAt: now + 1 }, { unpowered: true }, { incident: {} }]) {
    const copy = structuredClone(state); Object.assign(copy.state.rooms[1], changed);
    assert.ok(!load().planShelterGod(copy).assignments.some(item => item.roomId === 2));
  }
  state.state.residents.push(person(2, { roomId: 2, away: {} }), person(3, { roomId: 2, away: {} }));
  assert.ok(!load().planShelterGod(state).assignments.some(item => item.roomId === 2));
  state.state.residents[1].roomId = null;
  const context = load({ __fengbaoDormAssignment: { monitoring: true, entries: [{ residentId: 2, originalRoomId: 2, status: 'waiting' }] } });
  assert.ok(!context.planShelterGod(state).assignments.some(item => item.roomId === 2));
});

test('托管训练魅力幸运默认关闭，可分别开启；练满允许属性者让出训练位', () => {
  const state = view([person(1, { roomId: 1, stats: stats(10, { cha: 9, lck: 9 }) })],
    [room(1, 'training', { trainStat: 'str' }), room(2, 'training', { trainStat: 'cha' }), room(3, 'training', { trainStat: 'lck' })]);
  const context = load();
  assert.equal(context.planShelterGod(state).assignments[0].roomId, null);
  assert.equal(context.planShelterGod(state, new Set(), false, false, { trainCharisma: true }).assignments[0].roomId, 2);
  assert.equal(context.planShelterGod(state, new Set(), false, false, { trainLuck: true }).assignments[0].roomId, 3);
});

test('同产品迁向高级房间时保护周常队员、外出占位和原岗预留', () => {
  const state = view([person(1, { roomId: 1 }), person(2, { roomId: 2, away: {} }), person(3, { roomId: 2, away: {} })],
    [room(1, 'power'), room(2, 'power', { level: 3 })]);
  const context = load();
  assert.equal(context.planRoomUpgrade(state).length, 0);
  state.state.residents.pop();
  assert.equal(context.planRoomUpgrade(state)[0].roomId, 2);
  state.state.quests = [{ team: [1] }];
  assert.equal(context.planRoomUpgrade(state).length, 0);
});

test('资源补缺可从电台调人，不抽训练室，不让其他资源转负', () => {
  const state = view([person(1, { roomId: 1 }), person(2, { roomId: 3 })],
    [room(1, 'radio'), room(2, 'diner'), room(3, 'training', { trainStat: 'str' })]);
  const context = load();
  const plan = plain(context.planResourceBalance(state));
  assert.equal(plan[0].residentId, 1);
  assert.equal(plan[0].roomId, 2);
  assert.ok(!plan.some(item => item.residentId === 2));
});

test('日常服装分配保护周常队员和配对居民的装备', () => {
  const state = view([person(1, { roomId: 1 }), person(2, { outfitId: 1 })], [room(1, 'power')],
    { items: [{ id: 1, slot: 'outfit', name: '力量服', bonus: { str: 7 } }], quests: [{ team: [2] }] });
  assert.equal(load().planOutfits(state).changes.length, 0);
  state.state.quests = [];
  assert.equal(load().planOutfits(state).changes.length, 1);
});

test('日常服装全局分配允许在岗居民转交给更高等级岗位，儿童装备保持', () => {
  const state = view([person(1, { roomId: 1, outfitId: 1 }), person(2, { roomId: 2 }),
    person(3, { adultAt: now + 1000, outfitId: 2 })], [room(1, 'power'), room(2, 'power', { level: 3 })],
  { items: [{ id: 1, slot: 'outfit', name: '力量服', bonus: { str: 5 } }, { id: 2, slot: 'outfit', bonus: { str: 7 } }] });
  const changes = plain(load().planOutfits(state).changes);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].residentId, 2); assert.equal(changes[0].itemId, 1);
});

test('自动升级可独立运行，按自定顺序升级并保护挂载预留原岗', async () => {
  const state = view([], [room(1, 'power'), room(2, 'scrap')], { resources: { scrap: 10000, parts: 100 } });
  const result = await run(state, { upgrade: true, upgradeOrder: ['scrap', 'power'] });
  assert.deepEqual(result.actions.filter(action => action.type === 'upgrade').map(action => action.roomId), [2]);
  await result.tick();
  assert.deepEqual(result.actions.filter(action => action.type === 'upgrade').map(action => action.roomId), [2, 1]);
  await result.tick();
  assert.equal(result.actions.filter(action => action.type === 'upgrade').length, 2);
  await result.stop();
  state.state.residents.push(person(1));
  const guarded = await run(state, { upgrade: true, upgradeOrder: ['power', 'scrap'] }, { globals: {
    __fengbaoDormAssignment: { monitoring: true, entries: [{ residentId: 1, originalRoomId: 1, status: 'waiting' }] }
  } });
  assert.deepEqual(guarded.actions.filter(action => action.type === 'upgrade').map(action => action.roomId), [2]);
  await guarded.stop();
});

test('自动升级保留施工位限制，挖层与造服装可独立于房间施工推进', async () => {
  const state = view([person(1, { roomId: 3 })], [room(1, 'power', { upgradeAt: now + 10000 }),
    room(2, 'scrap', { builtAt: now + 10000 }), room(3, 'tailor', { level: 3 })],
  { depth: 2, resources: { scrap: 10000, parts: 100 } });
  const result = await run(state, { upgrade: true, dig: true, craft: true });
  assert.deepEqual(result.actions.filter(action => ['dig', 'craft', 'upgrade', 'rush'].includes(action.type)),
    [{ type: 'dig' }, { type: 'craft', roomId: 3, tier: 6 }]);
  await result.stop();
});

test('服装图鉴高档集齐后制作下一档，资源不足及停电工坊等待', async () => {
  for (const blocked of ['none', 'resource', 'unpowered']) {
    const state = view([person(1, { roomId: 1 })], [room(1, 'tailor', { level: 3, unpowered: blocked === 'unpowered' })],
    { resources: { scrap: blocked === 'resource' ? 0 : 10000, parts: 100 },
      codex: { items: ['工装', '侦察斗篷', '白大褂', '演出服', '护甲', '幸运夹克'].map(base => `星核${base}/6`) } });
    const result = await run(state, { upgrade: true, craft: true });
    assert.deepEqual(result.actions.filter(action => action.type === 'craft'), blocked === 'none' ? [{ type: 'craft', roomId: 1, tier: 5 }] : []);
    await result.stop();
  }
});

test('午夜大门冻结不阻塞自动升级，白天或普通事故暂停升级', async () => {
  for (const [hour, kind, allowed] of [[1, 'raiders', true], [9, 'raiders', false], [1, 'fire', false]]) {
    const state = view([], [room(1, 'door', { incident: { kind, since: 1 } }), room(2, 'power')],
      { resources: { scrap: 10000, parts: 100 } });
    state.serverTime = at(hour);
    const result = await run(state, { upgrade: true });
    assert.equal(result.actions.some(action => action.type === 'upgrade'), allowed);
    await result.stop();
  }
});

test('专人救援可超过房间定员，使用第一间废料站且不重复救援同一事件', async () => {
  const state = view([person(1, { roomId: 1 }), person(2, { roomId: 1 }), person(3, { roomId: 2 }),
    person(4, { roomId: 3 }), person(5, { roomId: 4 }), person(6, { roomId: 4 })],
  [room(1, 'diner'), room(2, 'scrap'), room(3, 'scrap'), room(4, 'water', { incident: { kind: 'fire', since: 1 } })]);
  const result = await run(state, { rescue: true, mode: 'workers' });
  assert.deepEqual(result.actions.filter(action => action.type === 'assign').map(action => action.residentId), [1, 2, 3]);
  assert.equal(result.server.state.residents.filter(item => item.roomId === 4).length, 5);
  await result.tick(600000);
  assert.equal(result.actions.filter(action => action.type === 'assign').length, 3);
  result.server.state.rooms[3].incident = null;
  await result.tick(600000);
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [1, 1, 2, 3, 4, 4]);
  await result.stop();
});

test('一键救援记录实际调入居民，跨午夜回岗、08:00由本人重救且不追加原生呼叫', async () => {
  const state = view([person(1, { roomId: 1 })], [room(1, 'power'), room(2, 'door', { incident: { kind: 'raiders', since: 1 } })]);
  state.serverTime = at(23, 59);
  const result = await run(state, { rescue: true }, { before: ({ action, server }) => {
    if (action?.type !== 'rescue_incident') return;
    server.state.residents[0].roomId = 2;
    return { ok: true, status: 200, redirected: false, json: async () => ({ view: structuredClone(server) }) };
  } });
  assert.equal(result.task.incidentSnapshot[0].originalRoomId, 1);
  await result.tick(60000);
  assert.equal(result.server.state.residents[0].roomId, 1);
  assert.equal(result.task.incidentSnapshot[0].status, 'deferred');
  await result.tick(8 * 3600000);
  assert.equal(result.server.state.residents[0].roomId, 2);
  assert.equal(result.actions.filter(action => action.type === 'rescue_incident').length, 1);
  await result.stop();
});

test('同房同种新事件按发生时间重新支援，旧记录不重救新事件', async () => {
  const state = view([], [room(1, 'water', { incident: { kind: 'fire', since: 1 } })]);
  const result = await run(state, { rescue: true }, { before: ({ action, server }) => {
    if (action?.type !== 'rescue_incident') return;
    return { ok: true, status: 200, redirected: false, json: async () => ({ view: structuredClone(server) }) };
  } });
  await result.tick(600000);
  assert.equal(result.actions.filter(action => action.type === 'rescue_incident').length, 1);
  result.server.state.rooms[0].incident.since = 2;
  await result.tick(600000);
  assert.equal(result.actions.filter(action => action.type === 'rescue_incident').length, 2);
  await result.stop();
});

test('自动周常可从废料站补齐队伍，保护其他生产岗位和挂载居民', async () => {
  const state = view([person(1), person(2), person(3, { roomId: 1 }), person(4, { roomId: 2 })],
    [room(1, 'scrap'), room(2, 'power')]);
  state.env.quests = [{ id: 'q1', title: '任务一' }];
  const result = await run(state, { quest: true });
  assert.deepEqual(result.actions.filter(action => action.type === 'quest_start').map(action => action.team), [[1, 2, 3]]);
  await result.stop();
  const guarded = await run(state, { quest: true }, { globals: {
    __fengbaoDormAssignment: { monitoring: true, entries: [{ residentId: 3, originalRoomId: 1, status: 'waiting' }] }
  } });
  assert.ok(!guarded.actions.some(action => action.type === 'quest_start'));
  await guarded.stop();
});

test('自动升级脚本可随重复开启托管多次注入', () => {
  const context = load();
  assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(__dirname, 'upgrade-plan.js'), 'utf8'), context));
});

test('自动生育保留原生产与训练岗，确认家庭后回原岗，升级原岗等待恢复', async () => {
  const state = view([person(1, { roomId: 1, stats: stats(10) }), person(2, { roomId: 2, stats: stats(10) })],
    [room(1, 'power'), room(2, 'training', { trainStat: 'str' }), room(3, 'quarters')]);
  const result = await run(state, { birth: true });
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 3], result.task.logs.join('\n'));
  assert.deepEqual(Array.from(result.task.parentReturns, entry => entry.originalRoomId), [1, 2]);
  result.server.state.residents.forEach(item => { item.familyCooldownUntil = now + 10000000; });
  result.server.state.rooms[0].upgradeAt = now + 1000000;
  await result.tick();
  assert.equal(result.server.state.residents[0].roomId, 3);
  assert.equal(result.server.state.residents[1].roomId, 2);
  assert.equal(result.task.parentReturns.length, 1);
  assert.match(result.task.parentReturns[0].note, /升级/);
  result.server.state.rooms[0].upgradeAt = null;
  await result.tick();
  assert.equal(result.server.state.residents[0].roomId, 1);
  assert.equal(result.task.parentReturns.length, 0);
  await result.stop();
});

test('自动生育不使用停电宿舍，人口无出生名额时不再配对', async () => {
  for (const changed of [{ unpowered: true }, { level: 1 }]) {
    const state = view([person(1, { stats: stats(10) }), person(2, { stats: stats(10) }), person(3), person(4)],
      [room(1, 'quarters', changed)]);
    const result = await run(state, { birth: true });
    assert.ok(!result.actions.some(action => action.type === 'assign' && action.roomId === 1));
    await result.stop();
  }
});

test('自动生育按每项基础属性合计至少19配对，接受全9配全10及互补属性', async () => {
  for (const [left, right] of [
    [stats(9), stats(10)],
    [stats(10, { str: 9, int: 9 }), stats(10, { per: 9, lck: 9 })]
  ]) {
    const state = view([person(1, { roomId: 1, stats: left }), person(2, { roomId: 2, stats: right })],
      [room(1, 'power'), room(2, 'training', { trainStat: 'str' }), room(3, 'quarters')]);
    const result = await run(state, { birth: true });
    assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 3], result.task.logs.join('\n'));
    await result.tick(90000);
    assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 3], '合格配对不会因某项只有9被撤出');
    result.server.state.residents.forEach(item => { item.familyCooldownUntil = now + 10000000; });
    await result.tick();
    assert.deepEqual(result.server.state.residents.map(item => item.roomId), [1, 2], '家庭确认后仍恢复原岗');
    await result.stop();
  }
});

test('任一项9加9或8加10均不能自动配对，装备不补足基础属性门槛', async () => {
  for (const key of keys) {
    for (const [leftValue, rightValue] of [[9, 9], [8, 10]]) {
      const state = view([person(1, { stats: stats(10, { [key]: leftValue }), outfitId: 1 }),
        person(2, { stats: stats(10, { [key]: rightValue }) })], [room(3, 'quarters')],
      { items: [{ id: 1, slot: 'outfit', bonus: { [key]: 7 } }] });
      const result = await run(state, { birth: true });
      assert.ok(!result.actions.some(action => action.type === 'assign' && action.roomId === 3), key);
      assert.equal(result.task.autoPairs.length, 0);
      await result.stop();
    }
  }
});

test('满足19的亲子、共同父母、未成年、外出、冷却和低心情居民仍不参与新配对', async () => {
  for (const extra of [{ parents: [2] }, { parents: [90] }, { adultAt: now + 1 },
    { away: {} }, { familyCooldownUntil: now + 1 }, { happiness: 49 }]) {
    const state = view([person(1, { stats: stats(9), ...extra }),
      person(2, { stats: stats(10), parents: [90] })], [room(3, 'quarters')]);
    const result = await run(state, { birth: true });
    assert.ok(!result.actions.some(action => action.type === 'assign' && action.roomId === 3));
    await result.stop();
  }
});

test('已同房的9加10会被接管，已有感情保持同房，不再调出训练', async () => {
  for (const romance of [false, true]) {
    const state = view([person(1, { roomId: 3, stats: stats(9),
      romance: romance ? { partnerId: 2, progress: 0.5 } : null }),
    person(2, { roomId: 3, stats: stats(10), romance: romance ? { partnerId: 1, progress: 0.5 } : null })],
    [room(1, 'training', { trainStat: 'str' }), room(3, 'quarters')]);
    const result = await run(state, { birth: true });
    await result.tick(90000);
    assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 3], result.task.logs.join('\n'));
    assert.equal(result.actions.filter(action => action.type === 'assign').length, 0);
    await result.stop();
  }
});

test('9加10分居伴侣可重聚，9加9即使感情满也不继续占宿舍', async () => {
  for (const qualify of [true, false]) {
    const state = view([person(1, { roomId: 3, stats: stats(9), romance: { partnerId: 2, progress: 1 } }),
      person(2, { roomId: qualify ? null : 3, stats: stats(qualify ? 10 : 9), romance: { partnerId: 1, progress: 1 } })],
    [room(3, 'quarters')]);
    const result = await run(state, { birth: true });
    assert.deepEqual(result.server.state.residents.map(item => item.roomId), qualify ? [3, 3] : [null, null],
      result.task.logs.join('\n'));
    await result.stop();
  }
});

test('门卫调度为9加10单身和已有伴侣保留生育机会', async () => {
  for (const romance of [false, true]) {
    const state = view([person(1, { stats: stats(9), romance: romance ? { partnerId: 2, progress: 0.5 } : null }),
      person(2, { stats: stats(10), romance: romance ? { partnerId: 1, progress: 0.5 } : null }), person(3)],
    [room(1, 'door'), room(3, 'quarters', { level: 2 })]);
    const result = await run(state, { birth: true });
    assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 3, 1], result.task.logs.join('\n'));
    await result.stop();
  }
});

test('优先匹配伴侣较少者，两个全10和两个全9组成两组合格配对', async () => {
  const state = view([person(1, { stats: stats(10) }), person(2, { stats: stats(10) }),
    person(3, { stats: stats(9) }), person(4, { stats: stats(9) })], [room(3, 'quarters'), room(4, 'quarters')]);
  const result = await run(state, { birth: true });
  assert.equal(result.task.autoPairs.length, 2, result.task.logs.join('\n'));
  for (const pair of result.task.autoPairs) {
    const members = Array.from(pair.ids, id => result.server.state.residents.find(item => item.id === id));
    assert.deepEqual(members.map(item => item.stats.str).sort((a, b) => a - b), [9, 10]);
  }
  assert.equal(new Set(result.task.autoPairs.map(pair => pair.roomId)).size, 2);
  await result.stop();
});

test('合并宿舍按跨组亲属关系规避互配，非亲属9加9不能混住', async () => {
  for (const relatives of [false, true]) {
    const state = view([person(1, { stats: stats(10) }), person(2, { stats: stats(10) }),
      person(3, { stats: stats(9), parents: relatives ? [90, 91] : [] }),
      person(4, { stats: stats(9), parents: relatives ? [90, 91] : [] })], [room(3, 'quarters', { width: 3 })]);
    const result = await run(state, { birth: true });
    assert.equal(result.task.autoPairs.length, relatives ? 2 : 1, result.task.logs.join('\n'));
    assert.equal(result.server.state.residents.filter(item => item.roomId === 3).length, relatives ? 4 : 2);
    await result.stop();
  }
});

test('四名全10仍可在合并宿舍同时安排两组', async () => {
  const state = view([1, 2, 3, 4].map(id => person(id, { stats: stats(10) })), [room(3, 'quarters', { width: 3 })]);
  const result = await run(state, { birth: true });
  assert.equal(result.task.autoPairs.length, 2, result.task.logs.join('\n'));
  await result.stop();
});

test('已同房两组9加10中低属性成员为亲属时都保留，否则只保留安全的一组', async () => {
  for (const relatives of [false, true]) {
    const state = view([person(1, { roomId: 3, stats: stats(10) }), person(2, { roomId: 3, stats: stats(10) }),
      person(3, { roomId: 3, stats: stats(9), parents: relatives ? [90, 91] : [] }),
      person(4, { roomId: 3, stats: stats(9), parents: relatives ? [90, 91] : [] })],
    [room(3, 'quarters', { width: 3 })]);
    const result = await run(state, { birth: true });
    await result.tick(90000);
    assert.equal(result.server.state.residents.filter(item => item.roomId === 3).length, relatives ? 4 : 2,
      result.task.logs.join('\n'));
    await result.stop();
  }
});

test('重复接管合并宿舍时，已有未建立感情的配对仍计入两组上限', async () => {
  const state = view([1, 2, 3, 4, 5, 6].map(id => person(id, { roomId: 3, stats: stats(10), happiness: id > 4 ? 40 : 100 })),
    [room(3, 'quarters', { width: 3 })]);
  const result = await run(state, { birth: true });
  assert.equal(result.task.autoPairs.length, 2);
  for (const resident of result.server.state.residents.slice(4)) {
    resident.happiness = 100;
    resident.roomId = 3;
    delete result.task.dormWorkHold[resident.id];
    delete result.task.recentMoves[resident.id];
  }
  await result.tick(90000);
  assert.equal(result.task.autoPairs.length, 2, result.task.logs.join('\n'));
  assert.equal(result.server.state.residents.filter(item => item.roomId === 3).length, 4);
  await result.stop();
});

test('提交前重新核对双方基础属性，一方降为9加9时不再调入并可归岗', async () => {
  for (const changeAfterFirst of [false, true]) {
    const state = view([person(1, { roomId: 1, stats: stats(9) }), person(2, { roomId: 2, stats: stats(10) })],
      [room(1, 'power'), room(2, 'training', { trainStat: 'str' }), room(3, 'quarters')]);
    let changed = false;
    const result = await run(state, { birth: true }, { before({ server, action, context, actions }) {
      if (!action && !changed && context.__fengbaoShelterAuto?.parentReturns.length === 2 &&
          (!changeAfterFirst || actions.some(item => item.type === 'assign' && item.roomId === 3))) {
        changed = true;
        server.state.residents[1].stats.lck = 9;
      }
    } });
    assert.ok(changed);
    assert.equal(result.actions.filter(action => action.type === 'assign' && action.roomId === 3).length, changeAfterFirst ? 1 : 0);
    result.task.birthEnabled = false;
    result.task.returnRequested = true;
    await result.tick();
    assert.deepEqual(result.server.state.residents.map(item => item.roomId), [1, 2]);
    await result.stop();
  }
});

test('自动周常只从休息区选三人，装备后派出最多两队，不抽工作居民', async () => {
  const residents = Array.from({ length: 8 }, (_, index) => person(index + 1, { xp: index * 30, parents: [90, 91] }));
  residents[7].roomId = 1;
  const state = view(residents, [room(1, 'power')], { items: [
    { id: 1, name: '强武器', slot: 'weapon', tier: 3, damage: [8, 12] },
    { id: 2, name: '任务服', slot: 'outfit', tier: 3, bonus: { str: 3, end: 3 } }
  ] });
  state.env.quests = [{ id: 'q1', title: '任务1' }, { id: 'q2', title: '任务2' }, { id: 'q3', title: '任务3' }];
  const result = await run(state, { quest: true });
  const starts = result.actions.filter(action => action.type === 'quest_start');
  assert.equal(starts.length, 2, result.task.logs.join('\n'));
  assert.equal(new Set(starts.flatMap(action => action.team)).size, 6);
  assert.ok(!starts.flatMap(action => action.team).includes(8));
  assert.ok(result.actions.some(action => action.type === 'equip'));
  await result.tick();
  assert.equal(result.actions.filter(action => action.type === 'quest_start').length, 2);
  await result.stop();
});

test('已完成周常只领取一次不重复派，失败优先原班人马重试', async () => {
  const state = view([person(1), person(2), person(3)], [], { quests: [
    { id: 1, questId: 'done', team: [1, 2, 3], status: 'complete', returnAt: now }
  ] });
  state.env.quests = [{ id: 'done' }];
  const result = await run(state, { quest: true });
  assert.equal(result.actions.filter(item => item.type === 'quest_claim').length, 1);
  assert.ok(!result.actions.some(item => item.type === 'quest_start'));
  await result.stop();
  state.state.quests[0].status = 'failed';
  const failed = await run(state, { quest: true });
  assert.deepEqual(failed.actions.find(item => item.type === 'quest_start')?.team, [1, 2, 3]);
  await failed.stop();
});

test('多处事件分别救援，结束后按原岗归位，升级中的原岗保留等待', async () => {
  const state = view([person(1, { roomId: 1 }), person(2, { roomId: 2 })], [room(1, 'diner'), room(2, 'power'),
    room(3, 'storage', { incident: { kind: 'fire' } }), room(4, 'storage', { incident: { kind: 'rats' } })]);
  const result = await run(state, { rescue: true, mode: 'workers' });
  assert.deepEqual(result.actions.filter(item => item.type === 'assign').map(item => item.roomId), [3, 4], result.task.logs.join('\n'));
  result.server.state.rooms[2].incident = result.server.state.rooms[3].incident = null;
  result.server.state.rooms[0].upgradeAt = now + 10000000;
  await result.tick(600000);
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 2]);
  assert.equal(result.task.incidentSnapshot.length, 1);
  result.server.state.rooms[0].upgradeAt = null;
  await result.tick(600000);
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [1, 2]);
  assert.equal(result.task.incidentSnapshot, null);
  await result.stop();
});

test('原生救援每次复查，事件结束不重复调用，制作工坊不参与专人救援', async () => {
  const state = view([person(1, { roomId: 1 })], [room(1, 'armory', { craft: {} }), room(2, 'storage', { incident: { kind: 'rats' } })]);
  const result = await run(state, { rescue: true, rescues: 3 });
  assert.equal(result.actions.filter(item => item.type === 'rescue_incident').length, 1);
  await result.stop();
  const workers = await run(state, { rescue: true, mode: 'workers' });
  assert.equal(workers.actions.filter(item => item.type === 'assign').length, 0);
  await workers.stop();
});

test('23:50 派出的夜门救援午夜回原岗，08:00 由同一居民重救并在结束后归岗', async () => {
  const state = view([person(1, { roomId: 1 })], [room(1, 'power'),
    room(2, 'door', { incident: { kind: 'raiders' } })]);
  state.serverTime = at(23, 50);
  const result = await run(state, { rescue: true, mode: 'workers' });
  assert.deepEqual(result.actions.filter(item => item.type === 'assign').map(item => item.roomId), [2], result.task.logs.join('\n'));
  assert.equal(result.task.incidentSnapshot[0].status, 'waiting');

  await result.tick(10 * 60000);
  assert.equal(result.server.state.residents[0].roomId, 1);
  assert.equal(result.task.incidentSnapshot[0].status, 'deferred');
  assert.deepEqual(result.actions.filter(item => item.type === 'assign').map(item => item.roomId), [2, 1]);

  await result.tick(30000);
  assert.deepEqual(result.actions.filter(item => item.type === 'assign').map(item => item.roomId), [2, 1]);

  await result.tick(8 * 60 * 60000 - 30000);
  assert.equal(result.server.state.residents[0].roomId, 2);
  assert.equal(result.task.incidentSnapshot[0].status, 'waiting');
  assert.deepEqual(result.actions.filter(item => item.type === 'assign').map(item => item.roomId), [2, 1, 2]);

  result.server.state.rooms[1].incident = null;
  await result.tick(10 * 60000);
  assert.equal(result.server.state.residents[0].roomId, 1);
  assert.equal(result.task.incidentSnapshot, null);
  await result.stop();
});

test('午夜回岗时大门事件已结束会直接取消重救且不读取空事件', async () => {
  const state = view([person(1, { roomId: 1 })], [room(1, 'power'),
    room(2, 'door', { incident: { kind: 'raiders' } })]);
  state.serverTime = at(23, 50);
  const result = await run(state, { rescue: true, mode: 'workers' });
  result.server.state.rooms[1].incident = null;
  await result.tick(10 * 60000);
  assert.equal(result.server.state.residents[0].roomId, 1);
  assert.equal(result.task.incidentSnapshot, null);
  assert.deepEqual(result.actions.filter(item => item.type === 'assign').map(item => item.roomId), [2, 1]);
  await result.stop();
});

test('夜间大门回岗后手动改到第三岗位，08:00 不会拉去大门重救', async () => {
  const state = view([person(1, { roomId: 1 })], [room(1, 'power'),
    room(2, 'door', { incident: { kind: 'raiders' } }), room(3, 'water')]);
  state.serverTime = at(23, 50);
  const result = await run(state, { rescue: true, mode: 'workers' });
  await result.tick(10 * 60000);
  assert.equal(result.task.incidentSnapshot[0].status, 'deferred');
  result.server.state.residents[0].roomId = 3;
  await result.tick(8 * 60 * 60000);
  assert.equal(result.server.state.residents[0].roomId, 3);
  assert.equal(result.task.incidentSnapshot, null);
  assert.equal(result.actions.filter(item => item.type === 'assign' && item.roomId === 2).length, 1);
  await result.stop();
});

test('普通夜间事故仍由专人处理', async () => {
  const state = view([person(1, { roomId: 1 })], [room(1, 'diner'), room(2, 'storage', { incident: { kind: 'fire' } })]);
  state.serverTime = at(23, 50);
  const result = await run(state, { rescue: true, mode: 'workers' });
  assert.deepEqual(result.actions.filter(item => item.type === 'assign').map(item => item.roomId), [2]);
  await result.tick(10 * 60000);
  assert.equal(result.server.state.residents[0].roomId, 2);
  assert.equal(result.task.incidentSnapshot[0].status, 'waiting');
  await result.stop();
});

test('归岗期间手动调动居民后取消记录，不强行拉回', async () => {
  const state = view([person(1, { roomId: 1 })], [room(1, 'diner'), room(2, 'storage', { incident: { kind: 'fire' } }), room(3, 'power')]);
  const result = await run(state, { rescue: true, mode: 'workers' });
  result.server.state.residents[0].roomId = 3;
  result.server.state.rooms[1].incident = null;
  await result.tick(600000);
  assert.equal(result.server.state.residents[0].roomId, 3);
  assert.equal(result.task.incidentSnapshot, null);
  await result.stop();
});

test('提交前目标突然升级时不发送调动，快照和原岗预留保留', async () => {
  const state = view([person(1, { roomId: 1, name: '亲本★', stats: stats(10, { per: 9 }) })],
    [room(1, 'training', { trainStat: 'str' }), room(2, 'training', { trainStat: 'per' })]);
  let changed = false;
  const result = await run(state, { god: true }, { before({ action, gets, server }) {
    if (!action && gets >= 2 && !changed) { server.state.rooms[1].upgradeAt = now + 100000; changed = true; }
  } });
  assert.ok(!result.actions.some(item => item.type === 'assign' && item.roomId === 2));
  await result.stop();
});

test('网络重试复用幂等键，成功后继续托管，停止后不再提交', async () => {
  let attempts = 0;
  const result = await run(view(), {}, { globals: {
    setTimeout(callback, ms) { if (ms === 2000 || ms === 4000) queueMicrotask(callback); return 1; }, clearTimeout() {}
  }, before({ action }) {
    if (action?.type === 'collect_all' && ++attempts === 1) return { ok: false, status: 503, redirected: false, json: async () => ({}) };
  } });
  assert.equal(result.requests[0].idempotencyKey, result.requests[1]?.idempotencyKey);
  await result.stop();
});

test('门卫只补门外闲置成人，保护岗位、任务、挂载，被移出后不立即放回', async () => {
  const residents = [person(1, { stats: stats(10, { cha: 9, lck: 9 }) }), person(2, { stats: stats(10, { cha: 9, lck: 9 }) }),
    person(3, { roomId: 2 }), person(4, { roomId: 3 }), person(5), person(6)];
  const result = await run(view(residents, [room(1, 'door'), room(2, 'power'), room(3, 'training', { trainStat: 'str' })],
    { quests: [{ id: 1, questId: 'q', team: [5], status: 'active', returnAt: null }] }), { god: true }, { globals: {
      __fengbaoDormAssignment: { entries: [{ residentId: 6, status: 'waiting', originalRoomId: null }] }
    } });
  assert.deepEqual(result.actions.filter(item => item.type === 'assign' && item.roomId === 1).map(item => item.residentId), [1, 2], result.task.logs.join('\n'));
  result.server.state.residents[0].roomId = result.server.state.residents[1].roomId = null;
  await result.tick();
  assert.equal(result.actions.filter(item => item.type === 'assign' && item.roomId === 1).length, 2);
  await result.stop();
});

test('新人保留星标姓名并安排空位，单属性仅遣散本次新增且严格低于阈值者', async () => {
  const result = await run(view([person(1, { name: '亲本★', stats: stats(3, { str: 9 }) })],
    [room(1, 'radio'), room(2, 'power', { width: 3 })]), { dismissStat: true });
  assert.equal(result.server.state.residents[0].name, '亲本★');
  assert.equal(result.server.state.residents[0].roomId, 2);
  assert.ok(!result.actions.some(item => item.type === 'dismiss' || item.type === 'rename_resident'));
  result.server.state.residents.push(person(2, { name: '新居民甲', stats: stats(5, { end: 3 }) }),
    person(3, { name: '新居民乙', stats: stats(5, { end: 4, str: 9 }) }));
  await result.tick(600000);
  assert.deepEqual(result.actions.filter(item => item.type === 'dismiss').map(item => item.residentId), [2]);
  assert.equal(result.server.state.residents.find(item => item.id === 3).roomId, 2);
  assert.match(result.server.state.residents.find(item => item.id === 3).name, /^力-/);
  await result.stop();
});

test('归来先治疗一次再按原配置派出，治疗针不足保留等待且不参与周常', async () => {
  for (const needles of [0, 10]) {
    const state = view([person(1, { hp: 20, away: {} }), person(2), person(3)], [], {
      resources: { stimpak: needles }, explorers: [{ id: 5, residentId: 1, tier: 2,
        stimpaks: 0, startedAt: now - 10, abyss: false, returnAt: now, recalledAt: now - 1, events: 6,
        log: [{ at: now - 10, text: '带着 2 支治疗针出发' }] }]
    });
    state.env.quests = [{ id: 'q1' }];
    const result = await run(state, { quest: true }, { after({ server, action }) {
      if (action?.type === 'explore_claim') { server.state.explorers = []; server.state.residents[0].away = null; }
      if (action?.type === 'stimpak') { server.state.residents[0].hp = 80; server.state.resources.stimpak--; }
      if (action?.type === 'explore_start') {
        server.state.explorers = [{ id: 6, residentId: 1 }]; server.state.residents[0].away = {};
      }
    } });
    assert.equal(result.actions.filter(item => item.type === 'stimpak').length, needles ? 1 : 0, result.task.logs.join('\n'));
    assert.equal(result.actions.filter(item => item.type === 'explore_start').length, needles ? 1 : 0, result.task.logs.join('\n'));
    assert.ok(!result.actions.some(item => item.type === 'quest_start'));
    if (!needles) assert.ok(result.task.pendingDispatch[1], result.task.logs.join('\n'));
    else assert.deepEqual(result.actions.find(item => item.type === 'explore_start'), { type: 'explore_start', residentId: 1, tier: 2, abyss: false, stimpaks: 2 });
    await result.stop();
  }
});

test('结束自动配对后造神仍开启时继续归岗，并保护手动挂载居民', async () => {
  const state = view([person(1, { roomId: 1, stats: stats(10) }), person(2, { roomId: 2, stats: stats(10) }), person(3, { roomId: 3 })],
    [room(1, 'power'), room(2, 'water'), room(3, 'quarters'), room(4, 'quarters')]);
  const result = await run(state, { god: true, birth: true }, { globals: {
    __fengbaoDormAssignment: { entries: [{ residentId: 3, status: 'waiting', originalRoomId: null }] }
  } });
  assert.equal(result.task.parentReturns.length, 2, result.task.logs.join('\n'));
  result.task.birthEnabled = false;
  result.task.returnRequested = true;
  await result.tick();
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [1, 2, 3]);
  assert.equal(result.task.parentReturns.length, 0);
  await result.stop();
});

test('周常提交前队数或完成状态变化时不再派出', async () => {
  for (const change of ['cap', 'done']) {
    let changed = false;
    const state = view([person(1), person(2), person(3)]);
    state.env.quests = [{ id: 'q' }];
    const result = await run(state, { quest: true }, { before({ server, action, gets }) {
      if (!action && gets >= 2 && !changed) {
        changed = true;
        if (change === 'done') server.state.weekly.completed = ['q'];
        else server.state.quests = [1, 2].map(id => ({ id, questId: 'busy' + id, status: 'active', team: [], returnAt: null }));
      }
    } });
    assert.ok(changed);
    assert.ok(!result.actions.some(item => item.type === 'quest_start'));
    await result.stop();
  }
});

test('停止托管后待归岗记录仍阻止整理房间，不提交拆分移动', async () => {
  for (const field of ['parentReturns', 'incidentSnapshot']) {
    let requests = 0;
    const context = vm.createContext({ __fengbaoShelterAuto: { running: false, [field]: [{ residentId: 1, status: 'waiting' }] },
      fetch() { requests++; throw new Error('不应发请求'); } });
    vm.runInContext(fs.readFileSync(path.join(root, 'workforce/room-runner.js'), 'utf8'), context);
    await settle();
    assert.equal(requests, 0);
    assert.match(context.__fengbaoWorkAssignment.message, /托管仍有待归岗/);
    assert.equal(context.__fengbaoWorkAssignment.running, false);
  }
});

test('夜间已回原岗的 deferred 记录不阻塞自动整理房间', async () => {
  let requests = 0;
  const context = vm.createContext({ AbortSignal, __fengbaoShelterAuto: { running: false,
    incidentSnapshot: [{ residentId: 1, status: 'deferred', incidentRoomType: 'door', incidentKind: 'raiders' }] },
  location: { origin: 'https://game.arkengine.me', pathname: '/shelter' },
  fetch() { requests++; throw new Error('已进入读取阶段'); } });
  vm.runInContext(fs.readFileSync(path.join(root, 'workforce/room-runner.js'), 'utf8'), context);
  await settle();
  assert.equal(requests, 1);
  assert.doesNotMatch(context.__fengbaoWorkAssignment.message, /托管仍有待归岗/);
  assert.equal(context.__fengbaoWorkAssignment.running, false);
});

test('日志最多2000条，清空丢弃在途旧批次，结束日志仍写入', async () => {
  const store = { shelterLogs: Array.from({ length: 2100 }, (_, i) => '历史' + i) };
  let block, release;
  const local = { async get(key) { if (block) await block; return { [key]: structuredClone(store[key]) }; },
    async set(values) { Object.assign(store, structuredClone(values)); }, async remove(key) { delete store[key]; } };
  const result = await run(view(), {}, { globals: { chrome: { storage: { local } } } });
  const flush = () => { const timer = [...result.timers.values()].find(item => item.ms === 400); assert.ok(timer); timer.callback(); };
  flush(); await settle();
  assert.equal(store.shelterLogs.length, 2000);
  // 先产生一批新日志，并让其读取停在清空操作之前。
  await result.tick(600000);
  block = new Promise(resolve => { release = resolve; });
  flush(); await settle();
  const clearing = result.task.clearLogs();
  release(); await clearing; block = null;
  assert.equal(store.shelterLogs, undefined);
  assert.equal(result.task.logs.length, 0);
  await result.stop();
  await settle();
  assert.equal(store.shelterLogs.length, 1);
  assert.match(store.shelterLogs[0], /托管已关闭/);
});

test('自动配对只入住一方就遇升级，结束按钮仍可恢复双方原岗', async () => {
  const state = view([person(1, { roomId: 1, stats: stats(10) }), person(2, { roomId: 2, stats: stats(10) })],
    [room(1, 'power'), room(2, 'water'), room(3, 'quarters')]);
  let changed = false;
  const result = await run(state, { birth: true }, { after({ action, server }) {
    if (!changed && action?.type === 'assign' && action.roomId === 3) {
      changed = true; server.state.rooms[2].upgradeAt = now + 1000000;
    }
  } });
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 2]);
  assert.equal(result.task.parentReturns.length, 2);
  result.task.birthEnabled = false; result.task.returnRequested = true;
  await result.tick();
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [1, 2]);
  assert.equal(result.task.parentReturns.length, 0);
  await result.stop();
});

test('分居伴侣自动同房也记录原岗，家庭确认后恢复', async () => {
  const state = view([person(1, { roomId: 3, stats: stats(10), romance: { partnerId: 2, progress: 0.5 } }),
    person(2, { roomId: 2, stats: stats(10), romance: { partnerId: 1, progress: 0.5 } })],
    [room(1, 'power'), room(2, 'water'), room(3, 'quarters')]);
  const result = await run(state, { birth: true });
  assert.equal(result.task.parentReturns.length, 2, result.task.logs.join('\n'));
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 3]);
  result.server.state.residents.forEach(item => { item.familyCooldownUntil = now + 10000000; });
  await result.tick();
  assert.deepEqual(result.server.state.residents.map(item => item.roomId), [3, 2]);
  await result.stop();
});

test('日常服装不给训练和电台专配，也不取儿童装备，优先供生产使用', () => {
  const state = view([person(1, { roomId: 1 }), person(2, { roomId: 2 }), person(3, { roomId: 3 }),
    person(4, { adultAt: now + 1, outfitId: 2 })],
    [room(1, 'training', { trainStat: 'str' }), room(2, 'radio'), room(3, 'power')], {
      items: [{ id: 1, name: '力量服', slot: 'outfit', bonus: { str: 5, cha: 5 } },
        { id: 2, name: '儿童服', slot: 'outfit', bonus: { str: 7 } }]
    });
  assert.deepEqual(plain(load().planOutfits(state).changes).map(item => [item.residentId, item.itemId]), [[3, 1]]);
});
