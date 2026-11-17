function planShelterGod(view) {
  if (!Array.isArray(view.state?.rooms) || !Array.isArray(view.state.residents)) throw new Error('造神计划数据格式已变化');
  const { rooms, residents } = view.state;
  const labels = { str: '力量', per: '感知', end: '耐力', cha: '魅力', int: '智力', agi: '敏捷', lck: '幸运' };
  const production = { str: ['power'], per: ['water'], agi: ['diner'], int: ['workshop', 'medbay'], end: ['scrap'], cha: ['radio'], lck: [] };
  const names = { power: '发电站', water: '净水站', diner: '餐厅', workshop: '工坊', medbay: '医务室', scrap: '废料回收站', radio: '电台' };
  const trainingRooms = rooms.filter(room => room.type === 'training');
  const workers = residents.filter(resident => resident.away === null && resident.deadAt === null && resident.adultAt <= view.serverTime);
  const positions = new Map(workers.map(resident => [resident.id, resident.roomId]));
  const assignments = [], parents = [];
  const roomName = room => `${room.type === 'training' ? `${labels[room.trainStat]}训练室` : names[room.type]}（${room.floor} 层，房间 ${room.id}）`;

  // 预览与执行共用同一选择规则，并按前序调动后的占位判断空位。
  function nextTraining(resident, current) {
    const keys = Object.keys(labels).filter(key => key !== current.trainStat && resident.stats[key] < 10)
      .sort((left, right) => resident.stats[right] - resident.stats[left]);
    for (const key of keys) {
      const room = trainingRooms.find(room => room.trainStat === key && room.builtAt <= view.serverTime &&
        workers.filter(worker => positions.get(worker.id) === room.id).length < room.width * 2);
      if (room) return room;
    }
    return null;
  }
  function move(resident, room) {
    const roomId = room ? room.id : null;
    assignments.push({ residentId: resident.id, roomId, message: `造神计划：${resident.name} → ${room ? roomName(room) : '去休息'}。` });
    positions.set(resident.id, roomId);
  }

  // 仅由本轮开始时训练室内的居民触发调动，不扫描其他岗位主动换人。
  for (const resident of workers) {
    const room = trainingRooms.find(room => room.id === resident.roomId);
    if (!room) continue;
    const current = resident.stats[room.trainStat];
    if (resident.name.includes('★')) {
      const next = nextTraining(resident, room);
      parents.push({
        id: resident.id, name: resident.name, stat: labels[room.trainStat], current,
        progress: current >= 10 ? 1 : Math.max(0, Math.min(1, resident.training)),
        room: roomName(room), nextRoom: next ? roomName(next) : '去休息'
      });
      if (current >= 10) move(resident, next);
    } else if (current >= 10) {
      const productionRooms = rooms.filter(item => production[room.trainStat].includes(item.type) && item.builtAt <= view.serverTime);
      // 遍历全部对应生产房间，排除该属性已满 10 的员工后统一选最高者；智力包含所有工坊和医务室。
      const replacement = workers.filter(worker => worker.stats[room.trainStat] < 10 &&
        productionRooms.some(item => item.id === positions.get(worker.id)))
        .sort((left, right) => right.stats[room.trainStat] - left.stats[room.trainStat] || left.id - right.id)[0];
      const destination = replacement ? productionRooms.find(item => item.id === positions.get(replacement.id)) : null;
      move(resident, null);
      if (replacement) {
        // 满训者先去休息腾位，生产员工进训练室后，再将满训者放回空出的岗位。
        move(replacement, room);
        move(resident, destination);
      }
    }
  }
  return { assignments, parents };
}
