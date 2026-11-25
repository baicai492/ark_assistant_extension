// 00:00–07:59 掠夺者不进大门，门卫可以参与生产；08:00 起恢复大门值守。
// 只把时段化结果放进核验快照，避免同一时段内服务器时间变化导致任务误停。
function workforceDoorGuardRequired(view) {
  const date = new Date(view?.serverTime);
  return !Number.isFinite(date.getTime()) || date.getHours() >= 8;
}
// 夜间大门掠夺者进度冻结。该事件保留在房间数据中，但不阻止生产与居民自动化。
function workforceIncidentBlocksAutomation(room, view) {
  if (!room?.incident) return false;
  return !(room.type === 'door' && room.incident.kind === 'raiders' && !workforceDoorGuardRequired(view));
}

function workforceResourceAmount(state, key) {
  const roots = [state?.resources, state?.resource, state?.inventory, state?.stock, state?.shelter?.resources];
  for (const root of roots) {
    const value = root?.[key];
    if (Number.isFinite(value)) return value;
    if (value && typeof value === 'object') {
      for (const field of ['amount', 'value', 'quantity', 'stock', 'current']) {
        if (Number.isFinite(value[field])) return value[field];
      }
    }
  }
  return null;
}
function workforceOptions(options = {}) {
  const result = { strategy: 'production', trainCharisma: false, trainLuck: false, reassignTraining: false, ...options };
  if (!['production', 'highest'].includes(result.strategy) ||
      !['trainCharisma', 'trainLuck', 'reassignTraining'].every(key => typeof result[key] === 'boolean')) {
    throw new Error('居民安排选项无效');
  }
  return result;
}

function workforceRoomReasons(room, now) {
  if (!room) return ['房间已拆除'];
  const reasons = [];
  if (room.upgradeAt !== null) reasons.push(Number.isFinite(room.upgradeAt) ? '升级中' : '升级状态不完整');
  if (room.builtAt > now) reasons.push('施工中');
  if (workforceIncidentBlocksAutomation(room, { serverTime: now })) reasons.push('事故处理中');
  if (room.unpowered) reasons.push('停电');
  return reasons;
}

// 手动挂载、托管配对和救援共用居民保护与原岗名额，外出成人也保留岗位。
function shelterCoordination(view) {
  const auto = globalThis.__fengbaoShelterAuto;
  const entries = [
    ...(globalThis.__fengbaoDormAssignment?.entries ?? []),
    ...(auto?.parentReturns ?? []),
    ...(Array.isArray(auto?.incidentSnapshot) ? auto.incidentSnapshot : [])
  ].filter(entry => entry.status === 'waiting');
  const quests = new Set((view.state.quests ?? []).flatMap(run => Array.isArray(run.team) ? run.team : []));
  return { entries, protectedIds: new Set([...quests, ...entries.map(entry => entry.residentId)]), quests };
}

function shelterRoomOccupancy(view, roomId, assignments = [], exceptId = null) {
  const positions = new Map(assignments.map(item => [item.residentId, item.roomId]));
  const adult = resident => resident.id !== exceptId && resident.deadAt === null && resident.adultAt <= view.serverTime;
  const actual = view.state.residents.filter(resident => adult(resident) &&
    (positions.has(resident.id) ? positions.get(resident.id) : resident.roomId) === roomId);
  const ids = new Set(actual.map(resident => resident.id));
  for (const entry of shelterCoordination(view).entries) {
    const resident = view.state.residents.find(item => item.id === entry.residentId);
    if (entry.originalRoomId === roomId && resident && adult(resident)) ids.add(resident.id);
  }
  return ids.size;
}

function workforceModel(view, options = {}) {
  options = workforceOptions(options);
  const types = {
    power: { name: '发电站', stat: 'str', resource: 'power', base: 12 },
    diner: { name: '餐厅', stat: 'agi', resource: 'food', base: 8 },
    water: { name: '净水站', stat: 'per', resource: 'water', base: 8 },
    scrap: { name: '废料回收站', stat: 'end', resource: 'scrap', base: 8 },
    medbay: { name: '医务室', stat: 'int', resource: 'stimpak', base: 0.5 },
    workshop: { name: '零件工坊', stat: 'int', resource: 'parts', base: 0.6 },
    radio: { name: '电台', stat: 'cha' },
    training: { name: '训练室' }
  };
  const keys = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'];
  const state = view?.state;
  const now = view?.serverTime;
  if (!state || !Array.isArray(state.rooms) || !Array.isArray(state.residents) ||
      !Array.isArray(state.items) || !state.legacy?.perks || !Number.isFinite(now) ||
      (view.env != null && !Array.isArray(view.env.events))) throw new Error('游戏数据不完整，无法计算产出');
  const roomIds = new Set(), residentIds = new Set();
  for (const room of state.rooms) {
    if (!['id', 'level', 'width', 'floor', 'col', 'builtAt'].every(key => Number.isFinite(room[key])) ||
        !Number.isInteger(room.id) || roomIds.has(room.id) || ![1, 2, 3].includes(room.width) ||
        !['door', 'elevator', 'power', 'diner', 'water', 'scrap', 'quarters', 'storage', 'medbay', 'training', 'workshop', 'armory', 'tailor', 'radio'].includes(room.type) ||
        ![1, 2, 3].includes(room.level) || (room.type === 'training' && !keys.includes(room.trainStat))) throw new Error('房间数据已变化，无法计算产出');
    roomIds.add(room.id);
  }
  for (const resident of state.residents) {
    if (!['id', 'adultAt', 'xp', 'happiness'].every(key => Number.isFinite(resident[key])) ||
        !Number.isInteger(resident.id) || residentIds.has(resident.id) ||
        (resident.roomId !== null && !roomIds.has(resident.roomId)) ||
        (resident.away !== null && (!resident.away || typeof resident.away !== 'object')) ||
        (resident.deadAt !== null && !Number.isFinite(resident.deadAt)) ||
        typeof resident.name !== 'string' || !keys.every(key => Number.isFinite(resident.stats?.[key]) && resident.stats[key] >= 0 && resident.stats[key] <= 10)) {
      throw new Error(`居民「${resident.name ?? resident.id}」的数据不完整`);
    }
    residentIds.add(resident.id);
  }
  if (view.switches?.frozen) throw new Error('避难所正在维护');
  const atHome = resident => resident.away === null && resident.deadAt === null;
  const roomOrder = (left, right) => right.level - left.level || right.width - left.width ||
    left.floor - right.floor || left.col - right.col || left.id - right.id;
  const operating = room => !workforceRoomReasons(room, now).length;
  const unavailableRooms = state.rooms.filter(room => types[room.type] && !operating(room)).map(room => ({ id: room.id,
    label: `${room.floor} 层${types[room.type].name}（房间 ${room.id}）`, reasons: workforceRoomReasons(room, now) }));
  const excluded = [];
  const guardRequired = workforceDoorGuardRequired(view);
  const coordination = shelterCoordination(view);
  const borrowed = coordination.entries;
  const borrowedIds = coordination.protectedIds;
  const workers = state.residents.filter(resident => {
    const room = state.rooms.find(item => item.id === resident.roomId);
    // 外出成人仍占原岗位名额；事件、大门防守和正在制作的工坊也保留人手。
    const reason = resident.adultAt > now ? '儿童' : !atHome(resident) ? '外出或已倒下' :
      borrowedIds.has(resident.id) ? coordination.quests.has(resident.id) ? '本周任务小队' : '临时配对或救援，保留归岗记录' :
      workforceIncidentBlocksAutomation(room, view) ? '所在房间正在处理事件' : room?.type === 'door' && guardRequired ? '大门守卫' :
      ['armory', 'tailor'].includes(room?.type) && room.craft ? '正在制作装备的工坊居民' :
      room?.type === 'training' && !options.reassignTraining ? '保留原训练安排' :
      room?.type === 'quarters' && !(resident.familyCooldownUntil > now) ? '宿舍居民（未处于家庭冷却）' : '';
    if (reason) excluded.push({ id: resident.id, name: resident.name, reason });
    return !reason;
  }).sort((left, right) => left.id - right.id);
  const workerIds = new Set(workers.map(resident => resident.id));
  const reserved = room => state.residents.filter(resident => resident.roomId === room.id && resident.deadAt === null &&
    resident.adultAt <= now && !workerIds.has(resident.id)).length + borrowed.filter(entry => entry.originalRoomId === room.id &&
      state.residents.some(resident => resident.id === entry.residentId && resident.roomId !== room.id)).length;
  const rooms = state.rooms.filter(room => types[room.type] && operating(room)).sort(roomOrder);
  // 与游戏资源栏一致：建成房间耗电，在家的成人和儿童分别消耗 1、0.5 份食物/水。
  const population = state.residents.reduce((sum, resident) => sum + (atHome(resident) ? resident.adultAt <= now ? 1 : 0.5 : 0), 0);
  const demand = {
    power: state.rooms.filter(room => room.builtAt <= now).reduce((sum, room) => sum +
      (['door', 'elevator', 'power'].includes(room.type) ? 0 :
        (types[room.type]?.resource ? 1 : 0.5) * room.width * room.level), 0),
    food: population, water: population, scrap: 0, parts: 0, stimpak: 0
  };
  const events = view.env?.events ?? [];
  const eventPercent = Math.min(150, Math.max(100, ...events.filter(event => event.kind === 'production' &&
    event.startsAt <= now && now < event.endsAt).map(event => event.percent)));
  const bonus = (1 + 0.03 * (state.legacy.perks.production ?? 0)) * eventPercent / 100;
  if (!Number.isFinite(bonus)) throw new Error('生产加成数据不完整');
  const happinessPerk = state.legacy.perks.happiness ?? state.legacy.perks.mood ?? 0;
  if (!Number.isFinite(happinessPerk) || happinessPerk < 0) throw new Error('心情加成数据不完整');
  const foodStock = workforceResourceAmount(state, 'food');
  const waterStock = workforceResourceAmount(state, 'water');
  function effectiveStat(resident, key) {
    const outfit = state.items.find(item => item.id === resident.outfitId);
    const value = Math.min(17, resident.stats[key] + (outfit?.bonus?.[key] ?? 0));
    if (!Number.isFinite(value) || value < 0) throw new Error('服装加成数据不完整');
    return value;
  }
  function stat(resident, type) {
    return effectiveStat(resident, types[type].stat);
  }
  function highestStats(resident) {
    const values = keys.map(key => effectiveStat(resident, key));
    const highest = Math.max(...values);
    return new Set(keys.filter((key, index) => values[index] === highest));
  }
  function factor(resident, type, happiness = resident.happiness) {
    const level = Math.min(50, 1 + Math.floor(Math.sqrt(Math.max(0, resident.xp) / 3)));
    return (0.5 + stat(resident, type) / 10) * (0.6 + 0.4 * Math.max(0, Math.min(100, happiness)) / 100) *
      (1 + (level - 1) * 0.01);
  }
  function rate(resident, room, happiness = resident?.happiness) {
    return resident && room && types[room.type]?.resource ? types[room.type].base * [0, 1, 1.5, 2.1][room.level] *
      factor(resident, room.type, happiness) * bonus : 0;
  }
  function happiness(assignments) {
    const destinations = assignments && new Map(assignments.map(item => [item.residentId, item.roomId]));
    const position = resident => destinations?.has(resident.id) ? destinations.get(resident.id) : resident.roomId;
    const radioRoom = rooms.find(room => room.type === 'radio');
    const radioActive = Boolean(radioRoom && radioRoom.builtAt <= now && !radioRoom.unpowered &&
      !workforceIncidentBlocksAutomation(radioRoom, view) && state.residents.some(resident => resident.away === null &&
        resident.deadAt === null &&
      resident.adultAt <= now && position(resident) === radioRoom.id));
    const foodShortage = foodStock !== null && foodStock <= 0;
    const waterShortage = waterStock !== null && waterStock <= 0;
    const projected = state.residents.filter(atHome).map(resident => {
      const roomId = position(resident);
      const room = state.rooms.find(item => item.id === roomId);
      const resting = roomId === null || room?.type === 'quarters';
      const highest = highestStats(resident);
      const affinityKey = room?.type === 'training' ? room.trainStat : types[room?.type]?.stat;
      const affinity = !resting && Boolean(affinityKey && highest.has(affinityKey));
      let target = 70 + happinessPerk + (resting ? 10 : 0) + (affinity ? 15 : 0) + (radioActive ? 10 : 0);
      const incidentBlocks = workforceIncidentBlocksAutomation(room, view);
      if (incidentBlocks) target -= 20;
      if (room?.unpowered) target -= 10;
      if (foodShortage) target -= 25;
      if (waterShortage) target -= 25;
      target = Math.max(5, Math.min(100, target));
      const current = Math.max(0, Math.min(100, resident.happiness));
      return {
        residentId: resident.id, current, target, oneHour: current + (target - current) / 2,
        affinity, resting, incident: incidentBlocks, unpowered: Boolean(room?.unpowered)
      };
    });
    const average = field => projected.length ? projected.reduce((sum, item) => sum + item[field], 0) / projected.length : 0;
    return {
      radioActive, foodShortage, waterShortage, perk: happinessPerk,
      stockBasis: { food: foodStock === null ? 'unknown' : 'stock', water: waterStock === null ? 'unknown' : 'stock' },
      averageCurrent: average('current'), averageOneHour: average('oneHour'), averageTarget: average('target'),
      residents: projected
    };
  }
  function netAt(assignments, mode = 'current') {
    const destinations = assignments && new Map(assignments.map(item => [item.residentId, item.roomId]));
    const projected = mode === 'target' ? new Map(happiness(assignments).residents.map(item => [item.residentId, item.target])) : null;
    const totals = { power: 0, food: 0, water: 0, scrap: 0, parts: 0, stimpak: 0 };
    for (const room of rooms.filter(room => types[room.type].resource)) {
      const residents = state.residents.filter(resident => atHome(resident) && resident.adultAt <= now &&
        (destinations?.has(resident.id) ? destinations.get(resident.id) : resident.roomId) === room.id).slice(0, room.width * 2);
      totals[types[room.type].resource] += residents.reduce((sum, resident) => sum + rate(resident, room, projected?.get(resident.id)), 0);
    }
    // 零件工坊每产出 1 零件消耗 6 废料，提示持续生产时的废料收支。
    totals.scrap -= totals.parts * 6;
    return Object.fromEntries(Object.keys(totals).map(resource => [resource, totals[resource] - demand[resource]]));
  }
  function net(assignments) { return netAt(assignments, 'current'); }
  function longTermNet(assignments) { return netAt(assignments, 'target'); }
  return { types, workers, excluded, rooms, unavailableRooms, demand, stat, factor, rate, happiness, net, longTermNet, reserved, options, doorGuardRequired: guardRequired, happinessPerk };
}

function workforceTrainingAllowed(resident, room, options) {
  const keys = ['str', 'per', 'end', 'int', 'agi', ...(options.trainCharisma ? ['cha'] : []), ...(options.trainLuck ? ['lck'] : [])];
  const highest = Math.max(...keys.map(key => resident.stats[key]));
  return keys.includes(room.trainStat) && resident.stats[room.trainStat] < 10 &&
    (highest >= 10 || resident.stats[room.trainStat] === highest);
}

function planWorkforceHighest(view, options = {}, model = workforceModel(view, options)) {
  const { types, workers, rooms } = model;
  // 岗位按六项基础属性选择，幸运和服装不参与最高属性比较。
  const keys = ['str', 'per', 'end', 'cha', 'int', 'agi'];
  const candidates = workers.map(worker => {
    const highest = Math.max(...keys.map(key => worker.stats[key]));
    return { worker, highest, stats: keys.filter(key => worker.stats[key] === highest) };
  });
  const order = (left, right) => right.highest - left.highest || left.worker.id - right.worker.id;
  const slots = rooms.filter(room => room.type !== 'training').flatMap(room =>
    Array.from({ length: Math.max(0, room.width * 2 - model.reserved(room)) }, () => ({ room, worker: null })));
  // 先放唯一最高者，再让并列最高者补位或替换属性更低的人；智力岗位工坊优先。
  for (const candidate of [...candidates.filter(item => item.stats.length === 1).sort(order),
    ...candidates.filter(item => item.stats.length > 1).sort(order)]) {
    let options = slots.filter(slot => candidate.stats.includes(types[slot.room.type].stat) &&
      (!slot.worker || slot.worker.stats[types[slot.room.type].stat] < candidate.highest));
    if (options.some(slot => slot.room.type === 'workshop')) options = options.filter(slot => slot.room.type !== 'medbay');
    options.sort((left, right) => {
      return Number(Boolean(left.worker)) - Number(Boolean(right.worker)) ||
        (left.worker ? left.worker.stats[types[left.room.type].stat] - right.worker.stats[types[right.room.type].stat] : 0) ||
        Number(candidate.worker.roomId !== left.room.id) - Number(candidate.worker.roomId !== right.room.id) ||
        slots.indexOf(left) - slots.indexOf(right);
    });
    if (options.length) options[0].worker = candidate.worker;
  }
  // 同类岗位内高属性者使用高等级房间；工坊和医务室按同一智力组重新排列。
  for (const key of keys) {
    const positions = slots.filter(slot => types[slot.room.type].stat === key);
    if (key === 'int') positions.sort((left, right) => Number(right.room.type === 'workshop') - Number(left.room.type === 'workshop'));
    const assigned = positions.map(slot => slot.worker).filter(Boolean)
      .sort((left, right) => right.stats[key] - left.stats[key] || left.id - right.id);
    for (const slot of positions) {
      if (!assigned.length) { slot.worker = null; continue; }
      const index = assigned.findIndex(worker => worker.stats[key] === assigned[0].stats[key] && worker.roomId === slot.room.id);
      slot.worker = assigned.splice(index < 0 ? 0 : index, 1)[0];
    }
  }
  const assignments = slots.filter(slot => slot.worker).map(slot => ({ residentId: slot.worker.id, roomId: slot.room.id }));
  const assignedIds = new Set(assignments.map(item => item.residentId));
  // 原训练室居民全部保留，只使用尚未占用的成人名额。
  const trainingSlots = rooms.filter(room => room.type === 'training').flatMap(room => {
    const occupied = model.reserved(room);
    return Array(Math.max(0, room.width * 2 - occupied)).fill(room);
  });
  let training = 0, resting = 0;
  for (const candidate of candidates.filter(item => !assignedIds.has(item.worker.id)).sort(order)) {
    const index = trainingSlots.findIndex(room => workforceTrainingAllowed(candidate.worker, room, model.options));
    const room = index < 0 ? null : trainingSlots.splice(index, 1)[0];
    assignments.push({ residentId: candidate.worker.id, roomId: room ? room.id : null });
    if (room) training++; else resting++;
  }
  // 训练无位者再补生产空位；所有待安排者已有目标，收支不再计入其原岗位。
  for (const assignment of assignments.filter(item => item.roomId === null)) {
    const worker = workers.find(item => item.id === assignment.residentId);
    const net = model.net(assignments);
    const options = slots.filter(slot => !slot.worker).map(slot => {
      const resource = types[slot.room.type].resource;
      const deficit = ['power', 'food', 'water', 'scrap'].includes(resource) && net[resource] < 0;
      // 会造成废料亏损的工坊最后补，仍遵循生产房全满才去门外。
      const scrapDeficit = slot.room.type === 'workshop' && net.scrap - model.rate(worker, slot.room) * 6 < 0;
      return { slot, priority: deficit ? 0 : scrapDeficit ? 2 : 1 };
    }).sort((a, b) => a.priority - b.priority ||
      worker.stats[types[b.slot.room.type].stat] - worker.stats[types[a.slot.room.type].stat] ||
      Number(worker.roomId !== a.slot.room.id) - Number(worker.roomId !== b.slot.room.id) ||
      slots.indexOf(a.slot) - slots.indexOf(b.slot));
    if (options.length) {
      const { slot } = options[0];
      slot.worker = worker;
      assignment.roomId = slot.room.id;
      assignedIds.add(worker.id);
      resting--;
    }
  }
  return { assignments, expected: model.net(assignments), excluded: model.excluded,
    available: workers.length, production: assignedIds.size, training, resting };
}

// 最大权重的一对一岗位匹配，空列表示暂不安排。不能只逐人贪心，通才可能占掉专才的唯一合适岗位。
function matchWorkforceSlots(scores) {
  const rows = scores.length;
  if (!rows) return [];
  const columns = scores[0].length;
  const u = new Float64Array(rows + 1), v = new Float64Array(columns + 1);
  const p = new Int32Array(columns + 1), way = new Int32Array(columns + 1);
  for (let row = 1; row <= rows; row++) {
    p[0] = row;
    let column = 0;
    const distance = new Float64Array(columns + 1).fill(Infinity), used = new Uint8Array(columns + 1);
    do {
      used[column] = 1;
      const current = p[column];
      let delta = Infinity, next = 0;
      for (let candidate = 1; candidate <= columns; candidate++) {
        if (used[candidate]) continue;
        const cost = -scores[current - 1][candidate - 1] - u[current] - v[candidate];
        if (cost < distance[candidate]) { distance[candidate] = cost; way[candidate] = column; }
        if (distance[candidate] < delta) { delta = distance[candidate]; next = candidate; }
      }
      for (let candidate = 0; candidate <= columns; candidate++) {
        if (used[candidate]) { u[p[candidate]] += delta; v[candidate] -= delta; }
        else distance[candidate] -= delta;
      }
      column = next;
    } while (p[column]);
    do {
      const previous = way[column];
      p[column] = p[previous];
      column = previous;
    } while (column);
  }
  const result = new Array(rows);
  for (let column = 1; column <= columns; column++) if (p[column]) result[p[column] - 1] = column - 1;
  return result;
}

function planWorkforceProduction(view, model) {
  const { workers, rooms, types, options } = model;
  if (!workers.length) return [];
  const targets = rooms.filter(room => room.type !== 'training' ||
    workers.some(resident => workforceTrainingAllowed(resident, room, options)));
  const capacities = targets.map(room => Math.max(0, room.width * 2 - model.reserved(room)));
  const empty = targets.length;
  const resources = ['power', 'food', 'water', 'scrap', 'parts', 'stimpak'];
  const base = model.net(workers.map(worker => ({ residentId: worker.id, roomId: null })));
  const trainingPerk = view.state.legacy.perks.training ?? 0;
  if (!Number.isFinite(trainingPerk) || trainingPerk < 0) throw new Error('训练加成数据不完整');
  // 不同产物按各自基础产量折算，避免把 1 废料直接当作 1 治疗针比较。
  const values = workers.map(worker => [...targets, null].map(room => {
    const vector = new Array(resources.length).fill(0);
    let production = 0, efficiency = 0, training = 0, speed = 0;
    if (room?.type === 'training') {
      if (!workforceTrainingAllowed(worker, room, options)) return null;
      training = 1;
      speed = room.level * (1 + trainingPerk * 0.05) / (worker.stats[room.trainStat] + 1);
    } else if (room) {
      production = 1;
      const definition = types[room.type];
      if (definition.resource) {
        const rate = model.rate(worker, room);
        vector[resources.indexOf(definition.resource)] = rate;
        if (room.type === 'workshop') vector[3] = -6 * rate;
        efficiency = rate / definition.base;
      } else {
        // 电台招募只用基础魅力，服装、等级和心情不计入。
        efficiency = worker.stats.cha / 10;
      }
    }
    return { vector, production, efficiency, training, speed, stay: Number(worker.roomId === (room?.id ?? null)) };
  }));
  const maxEfficiency = Math.max(1, ...values.map(row => Math.max(...row.map(value => value?.efficiency ?? 0))));
  const maxSpeed = Math.max(1, ...values.map(row => Math.max(...row.map(value => value?.speed ?? 0))));
  const columns = targets.flatMap((_, index) => Array(capacities[index]).fill(index)).concat(Array(workers.length).fill(empty));
  const scores = values.map(row => columns.map(column => {
    const value = row[column];
    return !value ? -1e12 : value.production * (maxEfficiency * workers.length + 2) + value.efficiency +
      (value.training + value.speed / (maxSpeed + 1) * 0.1) / (1000 * workers.length) + value.stay * 1e-9;
  }));
  const matched = matchWorkforceSlots(scores).map(column => columns[column]);
  function summarize(positions) {
    const result = { net: resources.map(key => base[key]), production: 0, efficiency: 0, training: 0, speed: 0, stay: 0 };
    positions.forEach((position, index) => {
      const value = values[index][position];
      resources.forEach((_, resource) => { result.net[resource] += value.vector[resource]; });
      for (const key of ['production', 'efficiency', 'training', 'speed', 'stay']) result[key] += value[key];
    });
    return result;
  }
  function rank(summary) {
    const shortage = summary.net.slice(0, 4).reduce((sum, amount, index) => sum + Math.max(0, -amount) / (index === 0 ? 12 : 8), 0);
    return [-shortage, summary.production, summary.efficiency, summary.training, summary.speed, summary.stay];
  }
  function better(left, right) {
    for (let index = 0; index < left.length; index++) {
      const difference = left[index] - right[index];
      if (difference > 1e-7) return true;
      if (difference < -1e-7) return false;
    }
    return false;
  }
  function fromAssignments(assignments) {
    const byId = new Map(assignments.map(item => [item.residentId, item.roomId]));
    return workers.map((worker, index) => {
      const target = targets.findIndex(room => room.id === byId.get(worker.id));
      return target >= 0 && values[index][target] ? target : empty;
    });
  }
  const current = fromAssignments(workers.map(worker => ({ residentId: worker.id, roomId: worker.roomId })));
  const previous = fromAssignments(planWorkforceHighest(view, options, model).assignments);
  function fits(positions) {
    return capacities.every((capacity, room) => positions.filter(position => position === room).length <= capacity);
  }
  function improve(seed) {
    const positions = [...seed];
    let summary = summarize(positions);
    const metrics = ['production', 'efficiency', 'training', 'speed', 'stay'];
    const zero = { vector: new Array(resources.length).fill(0), production: 0, efficiency: 0, training: 0, speed: 0, stay: 0 };
    const candidateRank = new Float64Array(6);
    // 单人改派和两人互换修补资源缺口；每一步只接受严格改善，达到预算后返回已找到的最好方案。
    // 这是带资源约束的启发式优化，不宣称所有资源目标下的数学全局最优。
    for (let iteration = 0; iteration < Math.max(20, workers.length * 2); iteration++) {
      const occupied = new Array(targets.length).fill(0);
      for (const position of positions) if (position !== empty) occupied[position]++;
      let improvement = null;
      const bestRank = rank(summary);
      function consider(index, destination, other = -1) {
        const before = values[index][positions[index]], after = values[index][destination];
        const otherBefore = other < 0 ? zero : values[other][positions[other]];
        const otherAfter = other < 0 ? zero : values[other][positions[index]];
        let shortage = 0;
        for (let resource = 0; resource < 4; resource++) {
          const amount = summary.net[resource] + after.vector[resource] - before.vector[resource] +
            otherAfter.vector[resource] - otherBefore.vector[resource];
          if (amount < 0) shortage -= amount / (resource === 0 ? 12 : 8);
        }
        candidateRank[0] = -shortage;
        for (let metric = 0; metric < metrics.length; metric++) {
          const key = metrics[metric];
          candidateRank[metric + 1] = summary[key] + after[key] - before[key] + otherAfter[key] - otherBefore[key];
        }
        if (better(candidateRank, bestRank)) {
          improvement = { index, destination, other };
          for (let metric = 0; metric < bestRank.length; metric++) bestRank[metric] = candidateRank[metric];
        }
      }
      for (let index = 0; index < workers.length; index++) {
        for (let destination = 0; destination <= empty; destination++) {
          if (destination !== positions[index] && values[index][destination] &&
              (destination === empty || occupied[destination] < capacities[destination])) consider(index, destination);
        }
        for (let other = index + 1; other < workers.length; other++) {
          if (positions[index] !== positions[other] && values[index][positions[other]] && values[other][positions[index]]) {
            consider(index, positions[other], other);
          }
        }
      }
      if (!improvement) break;
      const { index, destination, other } = improvement;
      if (other >= 0) positions[other] = positions[index];
      positions[index] = destination;
      summary = summarize(positions);
    }
    return { positions, summary };
  }
  // 每个起点都优化后再比较，避免起点尚有资源缺口时过早舍弃更好的匹配。
  let best = null;
  const seen = new Set();
  for (const seed of [matched, current, previous]) if (fits(seed) && !seen.has(seed.join(','))) {
    seen.add(seed.join(','));
    const candidate = improve(seed);
    if (!best || better(rank(candidate.summary), rank(best.summary))) best = candidate;
  }
  function assignmentsAt(positions) {
    return workers.map((worker, index) => ({ residentId: worker.id, roomId: targets[positions[index]]?.id ?? null }));
  }
  function longTermMetrics(positions) {
    const assignments = assignmentsAt(positions);
    const current = model.net(assignments);
    const projected = model.longTermNet(assignments);
    const mood = model.happiness(assignments);
    const deficit = net => ['power', 'food', 'water', 'scrap'].reduce((sum, resource, index) =>
      sum + Math.max(0, -net[resource]) / (index === 0 ? 12 : 8), 0);
    const currentShortage = deficit(current);
    const longTermShortage = deficit(projected);
    // 产物先按原基础产量归一化；长期目标心情已经反映在长线产量里，电台的机会成本随比较自然计入。
    // 资源缺口使用扣除工坊耗料后的净值；总产出则把耗料加回，避免同一废料既算产出又惩罚工坊。
    const grossScrap = projected.scrap + model.demand.scrap + projected.parts * 6;
    const output = ['power', 'food', 'water'].reduce((sum, resource) =>
      sum + Math.max(0, projected[resource] + model.demand[resource]) / (resource === 'power' ? 12 : 8), 0) +
      Math.max(0, grossScrap) / 8 + Math.max(0, projected.parts + model.demand.parts) / 0.6 +
      Math.max(0, projected.stimpak + model.demand.stimpak) / 0.5;
    const summary = summarize(positions);
    // 当前资源安全不能因长期心情收益而退化；长期资源安全之后才比较总产出。
    return [-currentShortage, -longTermShortage, output, summary.production, summary.efficiency,
      summary.training, summary.speed, mood.averageTarget, mood.averageOneHour, summary.stay];
  }
  // 在即时资源安全的起点上再做整套分配级的长线优化。每次只接受严格改善，
  // 这样电台全体心情增益会被所有消费者共享，而调去电台者的岗位损失也会一并计入。
  const positions = [...best.positions];
  let longTerm = longTermMetrics(positions);
  for (let iteration = 0; iteration < Math.max(20, workers.length * 2); iteration++) {
    const occupied = new Array(targets.length).fill(0);
    for (const position of positions) if (position !== empty) occupied[position]++;
    let improvement = null, bestMetrics = longTerm;
    const consider = candidate => {
      const metrics = longTermMetrics(candidate);
      if (better(metrics, bestMetrics)) { improvement = candidate; bestMetrics = metrics; }
    };
    for (let index = 0; index < workers.length; index++) {
      for (let destination = 0; destination <= empty; destination++) {
        if (destination === positions[index] || !values[index][destination] ||
            (destination !== empty && occupied[destination] >= capacities[destination])) continue;
        const candidate = [...positions];
        candidate[index] = destination;
        consider(candidate);
      }
      for (let other = index + 1; other < workers.length; other++) {
        if (positions[index] === positions[other] || !values[index][positions[other]] || !values[other][positions[index]]) continue;
        const candidate = [...positions];
        candidate[index] = positions[other];
        candidate[other] = positions[index];
        consider(candidate);
      }
    }
    if (!improvement) break;
    positions.splice(0, positions.length, ...improvement);
    longTerm = bestMetrics;
  }
  return assignmentsAt(positions);
}

function planWorkforce(view, options = {}) {
  const model = workforceModel(view, options);
  const assignments = model.options.strategy === 'highest' ? planWorkforceHighest(view, model.options, model).assignments :
    planWorkforceProduction(view, model);
  const ids = new Set();
  for (const assignment of assignments) {
    if (ids.has(assignment.residentId) || !model.workers.some(worker => worker.id === assignment.residentId) ||
        (assignment.roomId !== null && !model.rooms.some(room => room.id === assignment.roomId))) throw new Error('居民安排方案无效');
    ids.add(assignment.residentId);
  }
  if (ids.size !== model.workers.length || model.rooms.some(room => assignments.filter(item => item.roomId === room.id).length + model.reserved(room) > room.width * 2)) {
    throw new Error('居民安排方案超过房间容量');
  }
  const training = assignments.filter(item => model.rooms.find(room => room.id === item.roomId)?.type === 'training').length;
  const resting = assignments.filter(item => item.roomId === null).length;
  const mood = model.happiness(assignments);
  return { assignments, expected: model.net(assignments), longTermExpected: model.longTermNet(assignments), happiness: mood,
    excluded: model.excluded, unavailableRooms: model.unavailableRooms, options: model.options, doorGuardRequired: model.doorGuardRequired,
    available: model.workers.length, production: assignments.length - training - resting, training, resting,
    changed: assignments.filter(item => view.state.residents.find(worker => worker.id === item.residentId).roomId !== item.roomId).length };
}

function workforceContext(view, options) {
  workforceModel(view, options);
  const keys = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'];
  return JSON.stringify({
    residents: [...view.state.residents].sort((a, b) => a.id - b.id).map(resident => [resident.id,
      resident.adultAt <= view.serverTime, Boolean(resident.away), resident.deadAt, resident.familyCooldownUntil > view.serverTime,
      resident.outfitId, resident.happiness, keys.map(key => resident.stats[key])]),
    rooms: [...view.state.rooms].sort((a, b) => a.id - b.id).map(room => [room.id, room.type, room.width, room.level, room.floor, room.col,
      room.builtAt <= view.serverTime, room.upgradeAt, workforceIncidentBlocksAutomation(room, view), Boolean(room.unpowered), room.trainStat, Boolean(room.craft)]),
    outfits: view.state.items.filter(item => item.slot === 'outfit').sort((a, b) => a.id - b.id)
      .map(item => [item.id, keys.map(key => item.bonus?.[key] ?? 0)]),
    resources: [workforceResourceAmount(view.state, 'food'), workforceResourceAmount(view.state, 'water')],
    perks: [view.state.legacy?.perks?.production ?? 0, view.state.legacy?.perks?.training ?? 0,
      view.state.legacy?.perks?.happiness ?? view.state.legacy?.perks?.mood ?? 0],
    doorGuardRequired: workforceDoorGuardRequired(view)
  });
}

// 同种资源的房间出现空位时，把已经在该资源更低等级房间里工作的居民迁到高等级房间：
// 高等级房间产能更高，迁入后这种资源的总产出上升，不会造成新的缺口。
// 外出居民的岗位仍占容量，与游戏调动校验一致；正在升级、停电的房间暂时没有产出，不作为迁入目标。
function planRoomUpgrade(view, excludedIds = new Set()) {
  const model = workforceModel(view);
  const now = view.serverTime;
  const resourceOf = room => model.types[room.type]?.resource ?? null;
  const questTeams = new Set((Array.isArray(view.state.quests) ? view.state.quests : [])
    .flatMap(run => Array.isArray(run.team) ? run.team : []));
  const positions = new Map(view.state.residents.map(resident => [resident.id, resident.roomId]));
  const occupants = roomId => shelterRoomOccupancy(view, roomId, [...positions].map(([residentId, roomId]) => ({ residentId, roomId })));
  const assignments = [];
  excludedIds = new Set([...excludedIds, ...shelterCoordination(view).protectedIds]);
  for (let step = 0; step < 12; step++) {
    let best = null;
    for (const target of model.rooms) {
      const resource = resourceOf(target);
      if (!resource || occupants(target.id) >= target.width * 2) continue;
      for (const worker of view.state.residents) {
        if (worker.away !== null || worker.deadAt !== null || worker.adultAt > now || questTeams.has(worker.id) ||
            excludedIds.has(worker.id)) continue;
        const origin = view.state.rooms.find(room => room.id === positions.get(worker.id));
        if (!origin || workforceIncidentBlocksAutomation(origin, view) || origin.craft || origin.id === target.id || resourceOf(origin) !== resource || origin.level >= target.level) continue;
        // 零件工坊迁入会增加废料消耗，废料会转负时不迁。
        if (resource === 'parts' && model.net([...assignments, { residentId: worker.id, roomId: target.id }]).scrap < 0) continue;
        const gain = model.rate(worker, target) - model.rate(worker, origin);
        if (gain <= 0) continue;
        // 优先等级差大的迁移，其次选产出提升最大的人，最后按 ID 稳定排序。
        const score = [target.level - origin.level, gain, -worker.id];
        if (!best || score[0] > best.score[0] || score[0] === best.score[0] &&
            (score[1] > best.score[1] || score[1] === best.score[1] && score[2] > best.score[2])) {
          best = { worker, origin, target, score };
        }
      }
    }
    if (!best) break;
    positions.set(best.worker.id, best.target.id);
    assignments.push({
      residentId: best.worker.id, roomId: best.target.id,
      message: `等级调整：${best.worker.name}#${best.worker.id} 从 ${best.origin.floor} 层 ${best.origin.level} 级${model.types[best.origin.type].name}调到 ` +
        `${best.target.floor} 层 ${best.target.level} 级${model.types[best.target.type].name}（房间 ${best.target.id}）。`
    });
  }
  return assignments;
}

// 资源补缺：电力、食物、净水出现负收益时，从废料回收站、零件工坊、医务室、电台等
// 非缺口岗位调出居民补进缺口房间的空位。训练室居民不参与，避免中断训练；
// 原岗位的资源调出后不能转负。一次最多规划 12 步，由托管逐条执行。
function planResourceBalance(view, excludedIds = new Set()) {
  const model = workforceModel(view);
  if (!Array.isArray(view?.state?.births)) throw new Error('避难所数据格式已变化');
  const deficitsKeys = ['power', 'food', 'water'];
  const now = view.serverTime;
  const types = model.types;
  const rooms = model.rooms;
  const roomById = new Map(view.state.rooms.map(room => [room.id, room]));
  const atHome = resident => resident.away === null && resident.deadAt === null && resident.adultAt <= now;
  const positions = new Map(view.state.residents.filter(atHome).map(resident => [resident.id, resident.roomId]));
  const resourceOf = room => types[room.type]?.resource ?? null;
  const questTeams = new Set((Array.isArray(view.state.quests) ? view.state.quests : [])
    .flatMap(run => Array.isArray(run.team) ? run.team : []));
  const occupants = room => shelterRoomOccupancy(view, room.id, [...positions].map(([residentId, roomId]) => ({ residentId, roomId })));
  // 调出优先废料回收站（废料通常富余），其次医务室、电台，最后才是零件工坊。
  const originOrder = { scrap: 0, medbay: 1, radio: 2, workshop: 3 };
  const assignments = [];
  excludedIds = new Set([...excludedIds, ...shelterCoordination(view).protectedIds]);
  for (let step = 0; step < 12; step++) {
    const net = model.net(assignments);
    const deficits = deficitsKeys.filter(key => net[key] < 0).sort((left, right) => net[left] - net[right]);
    if (!deficits.length) break;
    let best = null;
    // 逐项比较：缺口大的资源优先，同一资源优先等级高的工作地点，再比较产出增益。
    const better = (left, right) => {
      for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) return left[index] > right[index];
      }
      return false;
    };
    const same = (left, right) => left.every((value, index) => value === right[index]);
    for (const resident of view.state.residents) {
      if (!atHome(resident) || questTeams.has(resident.id) || excludedIds.has(resident.id)) continue;
      const origin = roomById.get(positions.get(resident.id));
      if (!origin || workforceIncidentBlocksAutomation(origin, view) || origin.craft) continue;
      const originResource = resourceOf(origin);
      // 只从非缺口资源岗位调人，训练室、宿舍等没有资源产出的岗位不动。
      if ((!originResource && origin.type !== 'radio') || deficitsKeys.includes(originResource)) continue;
      const loss = model.rate(resident, origin);
      // 调出后原岗位的资源仍不能为负。
      if (originResource && net[originResource] - loss < 0) continue;
      for (const [resourceIndex, resource] of deficits.entries()) {
        for (const room of rooms.filter(room => resourceOf(room) === resource && occupants(room) < room.width * 2)) {
          const gain = model.rate(resident, room);
          if (gain <= 0) continue;
          // 同产品优先等级高的房间；缺口相同时优先从废料回收站调人，再比较产出增益。
          const score = [deficits.length - resourceIndex, room.level, -(originOrder[origin.type] ?? 9), gain, -loss];
          if (!best || better(score, best.score) || same(score, best.score) && resident.id < best.resident.id) {
            best = { resident, origin, room, score };
          }
        }
      }
    }
    if (!best) break;
    positions.set(best.resident.id, best.room.id);
    assignments.push({
      residentId: best.resident.id, roomId: best.room.id,
      message: `资源补缺：${best.resident.name}#${best.resident.id} 从${types[best.origin.type]?.name ?? best.origin.type}调到${types[best.room.type]?.name}（房间 ${best.room.id}）。`
    });
  }
  return assignments;
}
