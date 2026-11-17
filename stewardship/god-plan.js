function planShelterGod(view) {
  if (!Array.isArray(view.state?.rooms) || !Array.isArray(view.state.residents)) throw new Error('造神计划数据格式已变化');
  const { rooms, residents } = view.state;
  const now = view.serverTime;
  const keys = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'];
  const labels = { str: '力量', per: '感知', end: '耐力', cha: '魅力', int: '智力', agi: '敏捷', lck: '幸运' };
  const production = { str: ['power'], per: ['water'], agi: ['diner'], int: ['workshop', 'medbay'], end: ['scrap'], cha: ['radio'], lck: [] };
  const names = { power: '发电站', water: '净水站', diner: '餐厅', workshop: '工坊', medbay: '医务室', scrap: '废料回收站', radio: '电台' };
  const total = resident => keys.reduce((sum, key) => sum + resident.stats[key], 0);
  const workers = residents.filter(resident => resident.away === null && resident.deadAt === null && resident.adultAt <= now);
  const positions = new Map(workers.map(resident => [resident.id, resident.roomId]));
  const assignments = [], parents = [];
  const roomName = room => `${room.type === 'training' ? `${labels[room.trainStat]}训练室` : names[room.type]}（${room.floor} 层，房间 ${room.id}）`;
  const availableTraining = rooms.filter(room => room.type === 'training' && room.builtAt <= now &&
    room.upgradeAt === null && !room.incident && !room.unpowered);
  const pendingParents = new Set((view.state.births ?? []).flatMap(birth => birth.parents));
  const occupants = room => workers.filter(worker => positions.get(worker.id) === room.id);
  const freeSlots = room => room.width * 2 - occupants(room).length;
  function move(resident, room, message) {
    const roomId = room ? room.id : null;
    assignments.push({ residentId: resident.id, roomId, message: message ?? `造神计划：${resident.name} → ${room ? roomName(room) : '去休息'}。` });
    positions.set(resident.id, roomId);
  }
  // 优先练当前最高的未满属性；同一属性按房间等级、容量排序。
  function nextTraining(resident, current) {
    const stats = keys.filter(key => key !== current?.trainStat && resident.stats[key] < 10)
      .sort((left, right) => resident.stats[right] - resident.stats[left]);
    for (const key of stats) {
      const room = availableTraining.filter(room => room.trainStat === key && freeSlots(room) > 0)
        .sort((left, right) => right.level - left.level || right.width - left.width || left.floor - right.floor || left.id - right.id)[0];
      if (room) return room;
    }
    return null;
  }
  // 练满 70 后的岗位：先补电力、食物、净水缺口，三项都为正收益时优先废料、再零件（保证废料不为负）、治疗针，最后电台。
  function chooseJob(resident) {
    const free = room => room.width * 2 - workers.filter(worker => positions.get(worker.id) === room.id).length;
    const candidates = rooms.filter(room => names[room.type] && room.type !== 'training' && room.builtAt <= now &&
      room.upgradeAt === null && !room.incident && !room.unpowered && free(room) > 0);
    if (typeof workforceModel === 'function') {
      const model = workforceModel(view);
      const net = model.net(assignments);
      const deficits = ['power', 'food', 'water'].filter(key => net[key] < 0).sort((left, right) => net[left] - net[right]);
      const order = [...deficits, 'scrap', 'parts', 'stimpak'];
      for (const resource of order) {
        const options = candidates.filter(room => model.types[room.type]?.resource === resource)
          .map(room => ({ room, net: model.net([...assignments, { residentId: resident.id, roomId: room.id }]) }))
          .filter(item => resource !== 'parts' || item.net.scrap >= 0)
          .sort((left, right) => right.room.level - left.room.level || right.room.width - left.room.width ||
            left.room.floor - right.room.floor || left.room.id - right.room.id);
        if (options.length) return options[0].room;
      }
      return candidates.filter(room => room.type === 'radio')
        .sort((left, right) => right.level - left.level || left.floor - right.floor || left.id - right.id)[0] ?? null;
    }
    // 未注入产出模型时按最高属性对应岗位兜底。
    const highest = keys.filter(key => resident.stats[key] === Math.max(...keys.map(item => resident.stats[item])));
    const types = highest.flatMap(key => production[key]);
    return candidates.filter(room => types.includes(room.type))
      .sort((left, right) => right.level - left.level || left.floor - right.floor || left.id - right.id)[0] ?? null;
  }

  // 已在训练室的居民：未满 70 继续练下一个最高未满属性；满 70 转生产岗位。
  for (const resident of workers) {
    const room = rooms.find(item => item.id === resident.roomId);
    if (!room || room.type !== 'training') continue;
    const current = resident.stats[room.trainStat];
    if (resident.name.includes('★')) {
      const next = nextTraining(resident, room);
      parents.push({
        id: resident.id, name: resident.name, stat: labels[room.trainStat], current,
        progress: current >= 10 ? 1 : Math.max(0, Math.min(1, resident.training)),
        room: roomName(room), nextRoom: next ? roomName(next) : '去休息'
      });
      if (current >= 10) move(resident, next);
      continue;
    }
    if (current < 10) continue;
    const sum = total(resident);
    if (sum < 70) {
      // 当前属性练满但总和未到 70：优先转到下一个最高未满属性的训练室。
      const next = nextTraining(resident, room);
      if (next) move(resident, next, `造神计划：${resident.name}（属性 ${sum}/70）练满${labels[room.trainStat]}，转练${labels[next.trainStat]} → ${roomName(next)}。`);
    } else {
      // 总和已满 70：安排生产岗位；暂时没有空位就留在训练室等待。
      const job = chooseJob(resident);
      if (job) move(resident, job, `造神计划：${resident.name} 属性已满 70 → ${roomName(job)}。`);
    }
  }

  // 优先训练：把未满 70 的在岗居民按属性总和从高到低补进剩余训练空位。
  const candidates = workers.filter(resident => {
    const roomId = positions.get(resident.id);
    if (roomId === null) return false;
    const room = rooms.find(item => item.id === roomId);
    if (!room || room.type === 'quarters' || room.type === 'storage' || room.type === 'training') return false;
    if (room.incident || pendingParents.has(resident.id) || total(resident) >= 70) return false;
    return true;
  }).sort((left, right) => total(right) - total(left) || left.id - right.id);
  for (const resident of candidates) {
    const room = nextTraining(resident, null);
    // 高总分居民未必有对应的空训练室，继续找下一位，而不是提前停止。
    if (!room) continue;
    move(resident, room, `造神计划：${resident.name}（属性 ${total(resident)}/70）优先训练 → ${roomName(room)}。`);
  }
  return { assignments, parents };
}
