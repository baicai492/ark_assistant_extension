// 自动穿戴服装：按居民当前房间所需的属性，给每人分配加成最高的服装。
// 仓库里和穿着在“无岗位需求居民（宿舍、门外、儿童）”身上的服装可以重新分配；
// 外出或倒下居民身上的服装无法转交，有岗位居民身上对岗位有用的服装也不抢，
// 避免为了换装让正在工作的人光着。每轮只返回与现状不同的操作。
function planOutfits(view) {
  const state = view?.state;
  const now = view?.serverTime;
  if (!Array.isArray(state?.residents) || !Array.isArray(state?.rooms) || !Array.isArray(state?.items) || !Number.isFinite(now)) {
    throw new Error('装备数据格式已变化');
  }
  const keys = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'];
  const statByRoom = { power: 'str', diner: 'agi', water: 'per', scrap: 'end', workshop: 'int', medbay: 'int', radio: 'cha' };
  const rooms = new Map(state.rooms.map(room => [room.id, room]));
  const items = state.items.filter(item => item?.slot === 'outfit' && item.bonus && typeof item.bonus === 'object' &&
    keys.every(key => item.bonus[key] == null || Number.isFinite(item.bonus[key])));
  const wornBy = new Map();
  for (const resident of state.residents) if (resident.outfitId != null) wornBy.set(resident.outfitId, resident);
  // 训练室按 trainStat 选装备；生产房间按岗位属性；宿舍、门外和外出居民没有目标属性。
  function target(resident) {
    if (resident.deadAt !== null || resident.away !== null || resident.adultAt > now) return null;
    const room = rooms.get(resident.roomId);
    if (!room) return null;
    if (room.type === 'training') return keys.includes(room.trainStat) ? room.trainStat : null;
    return statByRoom[room.type] ?? null;
  }
  const totalBonus = item => keys.reduce((sum, key) => sum + (Number(item.bonus[key]) || 0), 0);
  const value = (item, stat) => (Number(item.bonus[stat]) || 0) * 10 + totalBonus(item);
  // 可重新分配的服装：仓库里的，或穿在无岗位需求居民身上且本人在家未倒下的。
  const available = items.filter(item => {
    const owner = wornBy.get(item.id);
    if (!owner) return true;
    return owner.away === null && owner.deadAt === null && !target(owner);
  });
  const candidates = [];
  for (const resident of state.residents) {
    const stat = target(resident);
    if (!stat) continue;
    const current = resident.outfitId != null ? items.find(item => item.id === resident.outfitId) : null;
    // 当前服装对岗位属性没有加成时不保护，直接视为可替换。
    const currentValue = current && (Number(current.bonus[stat]) || 0) > 0 ? value(current, stat) : 0;
    for (const item of available) {
      const owner = wornBy.get(item.id);
      if (owner?.id === resident.id) continue;
      const bonus = Number(item.bonus[stat]) || 0;
      if (bonus <= 0) continue;
      const score = value(item, stat);
      if (score <= currentValue) continue;
      candidates.push({ resident, item, stat, bonus, score, gain: score - currentValue });
    }
  }
  candidates.sort((left, right) => right.gain - left.gain || right.score - left.score ||
    left.resident.id - right.resident.id || left.item.id - right.item.id);
  const takenItems = new Set(), takenResidents = new Set(), changes = [];
  for (const candidate of candidates) {
    if (takenItems.has(candidate.item.id) || takenResidents.has(candidate.resident.id)) continue;
    takenItems.add(candidate.item.id);
    takenResidents.add(candidate.resident.id);
    changes.push({
      residentId: candidate.resident.id, residentName: candidate.resident.name,
      itemId: candidate.item.id, itemName: candidate.item.name,
      stat: candidate.stat, bonus: candidate.bonus
    });
  }
  return { changes, assigned: takenResidents.size };
}
