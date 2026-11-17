function workforceModel(view) {
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
  for (const room of state.rooms) {
    if (!['id', 'level', 'width', 'floor', 'col', 'builtAt'].every(key => Number.isFinite(room[key])) ||
        !['door', 'elevator', 'power', 'diner', 'water', 'scrap', 'quarters', 'storage', 'medbay', 'training', 'workshop', 'armory', 'tailor', 'radio'].includes(room.type) ||
        ![1, 2, 3].includes(room.level)) throw new Error('房间数据已变化，无法计算产出');
  }
  for (const resident of state.residents) {
    if (!['id', 'adultAt', 'xp', 'happiness'].every(key => Number.isFinite(resident[key])) ||
        typeof resident.name !== 'string' || !keys.every(key => Number.isFinite(resident.stats?.[key]))) {
      throw new Error(`居民「${resident.name ?? resident.id}」的数据不完整`);
    }
  }
  const atHome = resident => resident.away === null && resident.deadAt === null;
  const roomOrder = (left, right) => right.level - left.level || right.width - left.width ||
    left.floor - right.floor || left.col - right.col || left.id - right.id;
  const operating = room => room.builtAt <= now && room.upgradeAt === null && !room.incident && !room.unpowered;
  // 本周任务小队成员（进行中、返程中、失败待领取）不参与岗位安排，领取后才回到正常调度。
  const questTeams = new Set((Array.isArray(state.quests) ? state.quests : [])
    .flatMap(run => Array.isArray(run.team) ? run.team : []));
  const excluded = [];
  const workers = state.residents.filter(resident => {
    const room = state.rooms.find(item => item.id === resident.roomId);
    // 宿舍中家庭冷却尚未结束的成人参与生产安排，训练室居民仍全部保留。
    const reason = questTeams.has(resident.id) ? '本周任务小队' :
      resident.adultAt > now ? '儿童' : !atHome(resident) ? '外出或已倒下' :
      room?.type === 'training' ? '训练室居民（含暂停、练满）' :
      room?.type === 'quarters' && !(resident.familyCooldownUntil > now) ? '宿舍居民（未处于家庭冷却）' : '';
    if (reason) excluded.push({ id: resident.id, name: resident.name, reason });
    return !reason;
  }).sort((left, right) => left.id - right.id);
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
  function stat(resident, type) {
    const outfit = state.items.find(item => item.id === resident.outfitId);
    return Math.min(17, resident.stats[types[type].stat] + (outfit?.bonus?.[types[type].stat] ?? 0));
  }
  function factor(resident, type) {
    const level = Math.min(50, 1 + Math.floor(Math.sqrt(Math.max(0, resident.xp) / 3)));
    return (0.5 + stat(resident, type) / 10) * (0.6 + 0.4 * Math.max(0, Math.min(100, resident.happiness)) / 100) *
      (1 + (level - 1) * 0.01);
  }
  function rate(resident, room) {
    return resident && room ? types[room.type].base * [0, 1, 1.5, 2.1][room.level] * factor(resident, room.type) * bonus : 0;
  }
  function net(assignments) {
    const destinations = assignments && new Map(assignments.map(item => [item.residentId, item.roomId]));
    const totals = { power: 0, food: 0, water: 0, scrap: 0, parts: 0, stimpak: 0 };
    for (const room of rooms.filter(room => types[room.type].resource)) {
      const residents = state.residents.filter(resident => atHome(resident) && resident.adultAt <= now &&
        (destinations?.has(resident.id) ? destinations.get(resident.id) : resident.roomId) === room.id).slice(0, room.width * 2);
      totals[types[room.type].resource] += residents.reduce((sum, resident) => sum + rate(resident, room), 0);
    }
    // 零件工坊每产出 1 零件消耗 6 废料，提示持续生产时的废料收支。
    totals.scrap -= totals.parts * 6;
    return Object.fromEntries(Object.keys(totals).map(resource => [resource, totals[resource] - demand[resource]]));
  }
  return { types, workers, excluded, rooms, demand, stat, factor, rate, net };
}

function planWorkforce(view) {
  const model = workforceModel(view);
  const { types, workers, rooms } = model;
  // 岗位按六项基础属性选择，幸运和服装不参与最高属性比较。
  const keys = ['str', 'per', 'end', 'cha', 'int', 'agi'];
  const candidates = workers.map(worker => {
    const highest = Math.max(...keys.map(key => worker.stats[key]));
    return { worker, highest, stats: keys.filter(key => worker.stats[key] === highest) };
  });
  const order = (left, right) => right.highest - left.highest || left.worker.id - right.worker.id;
  const slots = rooms.filter(room => room.type !== 'training').flatMap(room =>
    Array.from({ length: room.width * 2 }, () => ({ room, worker: null })));
  // 先放唯一最高者，再让并列最高者补位或替换属性更低的人；智力岗位工坊优先。
  for (const candidate of [...candidates.filter(item => item.stats.length === 1).sort(order),
    ...candidates.filter(item => item.stats.length > 1).sort(order)]) {
    let options = slots.filter(slot => candidate.stats.includes(types[slot.room.type].stat) &&
      (!slot.worker || slot.worker.stats[types[slot.room.type].stat] < candidate.highest));
    if (options.some(slot => slot.room.type === 'workshop')) options = options.filter(slot => slot.room.type !== 'medbay');
    options.sort((left, right) => {
      return Number(Boolean(left.worker)) - Number(Boolean(right.worker)) ||
        (left.worker ? left.worker.stats[types[left.room.type].stat] - right.worker.stats[types[right.room.type].stat] : 0) ||
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
    positions.forEach((slot, index) => { slot.worker = assigned[index] ?? null; });
  }
  const assignments = slots.filter(slot => slot.worker).map(slot => ({ residentId: slot.worker.id, roomId: slot.room.id }));
  const assignedIds = new Set(assignments.map(item => item.residentId));
  // 原训练室居民全部保留，只使用尚未占用的成人名额。
  const trainingSlots = rooms.filter(room => room.type === 'training').flatMap(room => {
    const occupied = view.state.residents.filter(resident => resident.roomId === room.id &&
      resident.deadAt === null && resident.adultAt <= view.serverTime).length;
    return Array(Math.max(0, room.width * 2 - occupied)).fill(room);
  });
  let training = 0, resting = 0;
  for (const candidate of candidates.filter(item => !assignedIds.has(item.worker.id)).sort(order)) {
    const index = trainingSlots.findIndex(room => [...keys, 'lck'].includes(room.trainStat) &&
      candidate.worker.stats[room.trainStat] < 10 && (candidate.highest >= 10 || candidate.stats.includes(room.trainStat)));
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
      // 训练无位者优先补生产缺口，其次优先零件工坊；会造成废料亏损的工坊最后补。
      const scrapLoss = slot.room.type === 'workshop' && net.scrap - model.rate(worker, slot.room) * 6 < 0;
      const partsFirst = slot.room.type === 'workshop' && !scrapLoss;
      return { slot, priority: deficit ? 0 : partsFirst ? 1 : scrapLoss ? 3 : 2 };
    }).sort((a, b) => a.priority - b.priority ||
      worker.stats[types[b.slot.room.type].stat] - worker.stats[types[a.slot.room.type].stat] ||
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

// 同种资源的房间出现空位时，把已经在该资源更低等级房间里工作的居民迁到高等级房间：
// 高等级房间产能更高，迁入后这种资源的总产出上升，不会造成新的缺口。
// 外出居民的岗位仍占容量，与游戏调动校验一致；正在升级、停电的房间暂时没有产出，不作为迁入目标。
function planRoomUpgrade(view) {
  const model = workforceModel(view);
  const now = view.serverTime;
  const resourceOf = room => model.types[room.type]?.resource ?? null;
  const questTeams = new Set((Array.isArray(view.state.quests) ? view.state.quests : [])
    .flatMap(run => Array.isArray(run.team) ? run.team : []));
  const positions = new Map(view.state.residents.map(resident => [resident.id, resident.roomId]));
  const occupants = roomId => view.state.residents.filter(resident => positions.get(resident.id) === roomId &&
    resident.deadAt === null && resident.adultAt <= now).length;
  const assignments = [];
  for (let step = 0; step < 12; step++) {
    let best = null;
    for (const target of model.rooms) {
      const resource = resourceOf(target);
      if (!resource || occupants(target.id) >= target.width * 2) continue;
      for (const worker of view.state.residents) {
        if (worker.away !== null || worker.deadAt !== null || worker.adultAt > now || questTeams.has(worker.id)) continue;
        const origin = view.state.rooms.find(room => room.id === positions.get(worker.id));
        if (!origin || origin.id === target.id || resourceOf(origin) !== resource || origin.level >= target.level) continue;
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
      message: `等级调整：${best.worker.name} 从 ${best.origin.floor} 层 ${best.origin.level} 级${model.types[best.origin.type].name}调到 ` +
        `${best.target.floor} 层 ${best.target.level} 级${model.types[best.target.type].name}（房间 ${best.target.id}）。`
    });
  }
  return assignments;
}

// 资源补缺：电力、食物、净水出现负收益时，从废料回收站、零件工坊、医务室、电台等
// 非缺口岗位调出居民补进缺口房间的空位。训练室居民不参与，避免中断训练；
// 原岗位的资源调出后不能转负。一次最多规划 12 步，由托管逐条执行。
function planResourceBalance(view) {
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
  const occupants = room => view.state.residents.filter(resident => resident.deadAt === null && resident.adultAt <= now &&
    (positions.get(resident.id) ?? resident.roomId) === room.id).length;
  // 调出优先废料回收站（废料通常富余），其次医务室、电台，最后才是零件工坊。
  const originOrder = { scrap: 0, medbay: 1, radio: 2, workshop: 3 };
  const assignments = [];
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
      if (!atHome(resident) || questTeams.has(resident.id)) continue;
      const origin = roomById.get(positions.get(resident.id));
      if (!origin) continue;
      const originResource = resourceOf(origin);
      // 只从非缺口资源岗位调人，训练室、宿舍等没有资源产出的岗位不动。
      if (!originResource || deficitsKeys.includes(originResource)) continue;
      const loss = model.rate(resident, origin);
      // 调出后原岗位的资源仍不能为负。
      if (net[originResource] - loss < 0) continue;
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
      message: `资源补缺：${best.resident.name} 从${types[best.origin.type]?.name ?? best.origin.type}调到${types[best.room.type]?.name}（房间 ${best.room.id}）。`
    });
  }
  return assignments;
}
