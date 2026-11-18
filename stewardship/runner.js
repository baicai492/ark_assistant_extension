function startShelterAuto(intervalSeconds, recallEvents, dismissEnabled, dismissTotal, dismissStatEnabled, dismissStatKey, dismissStat, rescueCount, rescueEnabled, rescueMode, godEnabled, birthEnabled) {
  const previous = globalThis.__fengbaoShelterAuto;
  if (previous?.running) return;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || !Number.isInteger(recallEvents) || recallEvents < 1) throw new Error('间隔和事件次数必须为正整数');
  if (rescueEnabled && !['auto', 'workers'].includes(rescueMode)) throw new Error('请选择事件救援方式');
  if (rescueEnabled && rescueMode === 'auto' && (!Number.isInteger(rescueCount) || rescueCount < 1)) throw new Error('救援次数必须为正整数');
  if (dismissEnabled && (!Number.isInteger(dismissTotal) || dismissTotal < 1 || dismissTotal > 70)) throw new Error('遣散阈值必须为 1–70 的整数');
  const statLabels = { str: '力量', per: '感知', end: '耐力', cha: '魅力', int: '智力', agi: '敏捷', lck: '幸运' };
  const roomLabels = { power: '发电站', diner: '餐厅', water: '净水站', scrap: '废料回收站', workshop: '零件工坊', medbay: '医务室', radio: '电台', training: '训练室' };
  const keys = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'];
  if (dismissStatEnabled && !Object.hasOwn(statLabels, dismissStatKey)) throw new Error('请选择单项遣散的指定属性');
  if (dismissStatEnabled && (!Number.isInteger(dismissStat) || dismissStat < 1 || dismissStat > 10)) throw new Error('单项属性遣散阈值必须为 1–10 的整数');
  const task = { running: true, stopRequested: false, intervalSeconds, rescueEnabled, rescueMode, rescueCount, recallEvents, dismissEnabled, dismissTotal, dismissStatEnabled, dismissStatKey, dismissStat, godEnabled, birthEnabled: Boolean(birthEnabled), logs: previous?.logs ?? [], message: '正在开启托管…', nextAt: null, pendingDispatch: previous?.pendingDispatch ?? {}, newcomers: previous?.newcomers ?? [], knownIds: previous?.knownIds ?? null, deployments: previous?.deployments ?? {}, autoParents: previous?.autoParents ?? [], autoAssigned: previous?.autoAssigned ?? [], autoPairs: previous?.autoPairs ?? [], questRetries: previous?.questRetries ?? {} };
  task.incidentSnapshot = previous?.incidentSnapshot ?? null;
  globalThis.__fengbaoShelterAuto = task;
  const log = message => { task.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`); if (task.logs.length > 2000) task.logs.shift(); task.message = message; };
  const stopped = () => task.stopRequested;
  const fatal = message => Object.assign(new Error(message), { fatal: true });
  const stopError = () => Object.assign(new Error('托管已停止'), { stopped: true });
  const wait = ms => new Promise(resolve => { task.wake = resolve; task.timer = setTimeout(resolve, ms); });
  let view;
  function assertView(data) {
    if (!Array.isArray(data?.state?.residents) || !Array.isArray(data.state.rooms) ||
        !Array.isArray(data.state.births) || !Array.isArray(data.state.explorers) || !Number.isFinite(data.serverTime)) {
      throw fatal('避难所数据格式已变化');
    }
  }
  // 网络超时、服务端 5xx 和未确认结果都只算本轮失败：同一批操作复用同一个幂等键重试，
  // 三次仍失败就跳过本轮，托管继续运行，不再因为一次 signal timed out 整体停止。
  async function read() {
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (stopped()) throw stopError();
      try {
        const response = await fetch('/api/shelter', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000) });
        if (response.redirected || response.status === 401 || response.status === 403) throw fatal('登录已失效');
        if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
        const data = await response.json().catch(() => { throw new Error('读取失败（返回内容无法解析）'); });
        assertView(data);
        if (data.switches?.frozen) throw new Error('避难所正在维护，稍后重试');
        view = data;
        return;
      } catch (error) {
        if (error.fatal) throw error;
        last = error;
        if (attempt < 3) await wait(2000 * attempt);
      }
    }
    throw last;
  }
  async function act(action) {
    if (stopped()) return false;
    // 与游戏页面的重试逻辑一致：同一次操作始终复用同一个幂等键，超时后重试不会重复执行。
    const idempotencyKey = crypto.randomUUID();
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (stopped()) return false;
      try {
        const response = await fetch('/api/shelter/action', {
          method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(20000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, idempotencyKey })
        });
        if (response.redirected || response.status === 401 || response.status === 403) throw fatal('登录已失效');
        if (response.status >= 500) throw new Error(`操作未确认（HTTP ${response.status}）`);
        const data = await response.json().catch(() => ({}));
        // 未攒满产出是正常等待状态，只跳过本次收取，不中断托管。
        if (action.type === 'collect_all' && response.status < 500 && data.code !== 'retry' &&
            /(?:没有|暂无|尚无).{0,12}可收取|(?:还没|尚未|未|没有).{0,6}攒满/.test(data.error || '')) {
          log(`全部收取已跳过：${data.error}`);
          await read();
          return false;
        }
        if (!response.ok || data.code === 'retry') {
          const error = new Error(data.error || '操作结果未确认');
          // 明确的 4xx 业务错误重试也不会成功；其余（5xx、retry）按未知结果重试。
          error.permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 && data.code !== 'retry';
          throw error;
        }
        assertView(data.view);
        view = data.view;
        return true;
      } catch (error) {
        if (error.fatal || error.permanent) throw error;
        last = error;
        if (attempt < 3) await wait(2000 * attempt);
      }
    }
    throw new Error(`${last?.message ?? '操作失败'}（已重试 3 次，跳过本轮）`);
  }
  // 出发日志记录原始携带数量，不能使用途中消耗后的 stimpaks 值冒充原配置。
  function deployment(explorer) {
    if (!task.deployments[explorer.id]) {
      const departure = explorer.log.find(entry => entry.at === explorer.startedAt);
      const count = departure?.text.match(/带着\s*(\d+)\s*支治疗针/);
      if (!count) throw new Error(`探险 ${explorer.id} 缺少出发治疗针记录，无法原样再次派出`);
      task.deployments[explorer.id] = { residentId: explorer.residentId, tier: explorer.tier, abyss: explorer.abyss, stimpaks: Number(count[1]) };
    }
    return task.deployments[explorer.id];
  }
  function adultsIn(roomId) {
    return view.state.residents.filter(resident => resident.roomId === roomId && resident.deadAt === null &&
      resident.away === null && resident.adultAt <= view.serverTime);
  }
  // 本周任务小队成员（进行中、返程中、失败待领取）：领取前留在任务里，不参与其他居民调度。
  function questTeamIds() {
    const runs = Array.isArray(view.state.quests) ? view.state.quests : [];
    return new Set(runs.flatMap(run => Array.isArray(run.team) ? run.team : []));
  }
  function hasPartner(resident, list) {
    return Boolean(resident.romance) && list.some(item => item.id === resident.romance.partnerId);
  }
  function pairsInRoom(roomId) {
    const list = adultsIn(roomId);
    return list.filter(resident => hasPartner(resident, list)).length / 2;
  }
  function related(left, right) {
    return left.parents.includes(right.id) || right.parents.includes(left.id) ||
      left.parents.some(id => right.parents.includes(id));
  }
  // 与配对面板一致：6 人宿舍可以同时容纳两组生育，1 格宿舍只能一组。
  function pairCapacity(room) { return Math.min(2, room.width); }
  function freePairSlots(room) {
    const list = adultsIn(room.id);
    // 房内还有未配对的成人时不再安排，避免服务端把新居民和房里的人凑成一对。
    if (list.some(resident => !hasPartner(resident, list))) return 0;
    const freeAdults = room.width * 2 - list.length;
    return Math.max(0, Math.min(pairCapacity(room) - pairsInRoom(room.id), Math.floor(freeAdults / 2)));
  }
  // 自动生育：只从全 10 属性、可配对（成年、在家、心情≥50、不在冷却、无亲属关系）的居民中配对，
  // 放进有空位的宿舍等待服务端每 10 分钟结算感情，感情满后自动待产、出生。
  // 自动生育的子代按造神计划处理：属性总和未满 70 的优先训练，按总和从高到低排队。
  async function autoBirth(quiet = false) {
    const now = view.serverTime;
    // 与游戏一致：人口 = 存活居民 + 待产，人口上限 = 已建成宿舍的宽度 ×(2+2×等级)，最高 200。
    const living = view.state.residents.filter(resident => resident.deadAt === null).length + view.state.births.length;
    const capacity = Math.min(200, view.state.rooms.filter(room => room.type === 'quarters' && room.builtAt <= now)
      .reduce((sum, room) => sum + room.width * (2 + 2 * room.level), 0));
    if (living >= capacity) { if (!quiet) log(`自动生育：人口已满（${living}/${capacity}），本轮不安排新配对。`); return; }
    const pendingParents = new Set(view.state.births.flatMap(birth => birth.parents));
    const byId = new Map(view.state.residents.map(resident => [resident.id, resident]));
    // 已经建立感情、尚未待产的配对每对会占 1 个出生名额；不预留的话，
    // 感情 100% 时会撞上人口上限，只能显示“人口已满，等待空位”。
    const reserved = new Set();
    for (const resident of view.state.residents) {
      if (resident.deadAt !== null || resident.away !== null || resident.adultAt > now || !resident.romance) continue;
      const partner = byId.get(resident.romance.partnerId);
      if (!partner || partner.romance?.partnerId !== resident.id || resident.id > partner.id) continue;
      if (pendingParents.has(resident.id) || pendingParents.has(partner.id)) continue;
      if (resident.familyCooldownUntil > now || partner.familyCooldownUntil > now) continue;
      const room = view.state.rooms.find(item => item.id === resident.roomId);
      if (!room || room.type !== 'quarters' || partner.roomId !== room.id || room.builtAt > now || room.incident) continue;
      if (resident.happiness < 50 || partner.happiness < 50) continue;
      reserved.add(`${Math.min(resident.id, partner.id)}-${Math.max(resident.id, partner.id)}`);
    }
    // 刚安排进宿舍、服务端感情还没建立的配对同样要预留名额。
    for (const pair of task.autoPairs) {
      const [left, right] = pair.ids.map(id => byId.get(id));
      if (!left || !right || left.deadAt !== null || right.deadAt !== null) continue;
      if (pendingParents.has(left.id) || pendingParents.has(right.id)) continue;
      if (left.familyCooldownUntil > now || right.familyCooldownUntil > now) continue;
      if (left.romance || right.romance) continue;
      reserved.add(`${Math.min(left.id, right.id)}-${Math.max(left.id, right.id)}`);
    }
    const freeBirths = capacity - living - reserved.size;
    if (freeBirths <= 0) {
      if (!quiet) log(`自动生育：人口上限已全部预留给现有配对（${living + reserved.size}/${capacity}），暂不安排新配对。`);
      return;
    }
    const rooms = view.state.rooms.filter(room => room.type === 'quarters' && room.builtAt <= now &&
      room.upgradeAt === null && !room.incident && ['id', 'level', 'width', 'floor'].every(key => Number.isFinite(room[key])))
      .sort((left, right) => right.level - left.level || right.width - left.width || left.floor - right.floor || left.id - right.id);
    const slots = rooms.reduce((sum, room) => sum + freePairSlots(room), 0);
    if (!slots) { if (!quiet) log('自动生育：没有可用宿舍空位。'); return; }
    const autoParents = new Set(task.autoParents);
    const questTeams = questTeamIds();
    const candidates = view.state.residents.filter(resident => {
      const room = view.state.rooms.find(item => item.id === resident.roomId);
      return resident.deadAt === null && resident.away === null && resident.adultAt <= now && room?.type !== 'quarters' &&
        // 等待再次派出的探险归来者留在门外休息区，不参与配对。
        !task.pendingDispatch[resident.id] &&
        // 本周任务小队成员在领取前不参与配对。
        !questTeams.has(resident.id) &&
        !resident.romance && !(resident.familyCooldownUntil > now) && resident.happiness >= 50 &&
        !pendingParents.has(resident.id) && keys.every(key => resident.stats[key] === 10) &&
        // 自动生育的子代成年后去训练/工作岗位，不再次拉回宿舍生育。
        !(resident.parents.length === 2 && resident.parents.every(id => autoParents.has(id)));
    }).sort((left, right) => left.id - right.id);
    const limit = Math.min(slots, freeBirths, Math.floor(candidates.length / 2));
    const used = new Set();
    const pairs = [];
    for (const left of candidates) {
      if (pairs.length >= limit) break;
      if (used.has(left.id)) continue;
      const right = candidates.find(candidate => !used.has(candidate.id) && candidate.id !== left.id && !related(left, candidate));
      if (!right) continue;
      used.add(left.id);
      used.add(right.id);
      pairs.push([left, right]);
    }
    if (!pairs.length) { if (!quiet) log('自动生育：没有可用的全属性 10 配对。'); return; }
    for (const room of rooms) {
      let free = freePairSlots(room);
      while (free > 0 && pairs.length) {
        if (stopped()) return;
        const [left, right] = pairs.shift();
        for (const member of [left, right]) {
          const resident = view.state.residents.find(item => item.id === member.id);
          if (!resident || resident.deadAt !== null || resident.away !== null || resident.adultAt > view.serverTime ||
              resident.romance || resident.familyCooldownUntil > view.serverTime || resident.happiness < 50) {
            throw new Error('自动配对的居民状态已变化，跳过本轮');
          }
          if (resident.roomId === room.id) continue;
          if (!await act({ type: 'assign', residentId: resident.id, roomId: room.id })) return;
          if (view.state.residents.find(item => item.id === resident.id)?.roomId !== room.id) throw new Error('自动配对入住结果未确认');
        }
        for (const id of [left.id, right.id]) if (!task.autoParents.includes(id)) task.autoParents.push(id);
        // 配对后两人已离开生产岗位，生育结束回岗或配对失效后需要重新安排，不再沿用旧记录。
        task.autoAssigned = task.autoAssigned.filter(id => id !== left.id && id !== right.id);
        // 记录配对宿舍，待产记录出现后由 returnParents 释放父母回岗。
        if (!task.autoPairs.some(pair => pair.ids.includes(left.id) && pair.ids.includes(right.id))) {
          task.autoPairs.push({ roomId: room.id, ids: [left.id, right.id] });
        }
        free--;
        log(`自动生育：${left.name} ＋ ${right.name} → ${room.floor} 层 ${room.level} 级宿舍（房间 ${room.id}）。`);
      }
    }
  }
  // 生产岗位：先补电力、食物、净水缺口，正收益时优先零件工坊（不能把废料吃成负数），
  // 再废料回收站、医务室，最后电台。
  function chooseProductionRoom(resident) {
    const model = workforceModel(view);
    // 与游戏调动校验一致：房间内未倒下的成人占位（外出居民的岗位也保留）。
    const occupied = roomId => view.state.residents.filter(item => item.roomId === roomId && item.deadAt === null &&
      item.adultAt <= view.serverTime).length;
    const rooms = model.rooms.filter(room => room.type !== 'training' && occupied(room.id) < room.width * 2);
    const net = model.net();
    const deficits = ['power', 'food', 'water'].filter(key => net[key] < 0).sort((left, right) => net[left] - net[right]);
    const order = [...deficits, 'parts', 'scrap', 'stimpak'];
    for (const resource of order) {
      const options = rooms.filter(room => model.types[room.type]?.resource === resource)
        .map(room => ({ room, net: model.net([{ residentId: resident.id, roomId: room.id }]) }))
        .filter(item => resource !== 'parts' || item.net.scrap >= 0)
        .sort((left, right) => right.room.level - left.room.level || right.room.width - left.room.width ||
          left.room.floor - right.room.floor || left.room.id - right.room.id);
      if (options.length) return options[0].room;
    }
    return rooms.filter(room => room.type === 'radio')
      .sort((left, right) => right.level - left.level || left.floor - right.floor || left.id - right.id)[0] ?? null;
  }
  // 资源补缺：电力、食物、净水为负时，从废料回收站、零件工坊等非缺口岗位调人补进空位。
  async function balanceResources() {
    const assignments = planResourceBalance(view);
    if (assignments.length) {
      log(`资源补缺：本轮 ${assignments.length} 步调动。`);
      for (const { residentId, roomId, message } of assignments) {
        if (stopped()) return;
        if (!await act({ type: 'assign', residentId, roomId })) return;
        if (view.state.residents.find(item => item.id === residentId)?.roomId !== roomId) throw new Error('资源补缺调动结果未确认');
        log(message);
      }
    }
    const net = workforceModel(view).net();
    const deficits = ['power', 'food', 'water'].filter(key => net[key] < 0);
    if (!deficits.length) task.deficitNotice = null;
    else {
      const labels = { power: '电力', food: '食物', water: '净水' };
      const notice = deficits.map(key => `${labels[key]} ${net[key].toFixed(1)}/时`).join('、');
      // 缺口没有变化时不重复写日志。
      if (task.deficitNotice !== notice) {
        log(`资源补缺：${notice} 仍为负，非缺口岗位暂无可调居民，请手动安排。`);
        task.deficitNotice = notice;
      }
    }
  }
  // 等级调整：同种资源有更高等级的空位时，把低等级房间的居民迁上去。
  async function upgradeRooms() {
    const assignments = planRoomUpgrade(view);
    for (const { residentId, roomId, message } of assignments) {
      if (stopped()) return;
      if (!await act({ type: 'assign', residentId, roomId })) return;
      if (view.state.residents.find(item => item.id === residentId)?.roomId !== roomId) throw new Error('等级调整结果未确认');
      log(message);
    }
  }
  // 自动穿装备：按居民房间需要的属性分配服装，仓库和无岗位需求居民身上的服装可以重新分配。
  async function applyOutfits() {
    const plan = planOutfits(view);
    for (const change of plan.changes) {
      if (stopped()) return;
      try {
        if (!await act({ type: 'equip', residentId: change.residentId, itemId: change.itemId, slot: 'outfit' })) return;
        const resident = view.state.residents.find(item => item.id === change.residentId);
        if (resident?.outfitId !== change.itemId) throw new Error('穿戴结果未确认');
        log(`装备分配：${change.residentName} 穿上${change.itemName}（${statLabels[change.stat]} +${change.bonus}）。`);
      } catch (error) {
        if (error.fatal || error.stopped) throw error;
        log(`装备分配：${change.residentName} 换装失败：${error.message}。`);
        await read();
      }
    }
  }
  // 生育完成（进入待产或已经出生）后，父母立即回到生产岗位并穿戴对应装备；
  // 还在宿舍培养感情的配对继续保留。待产记录和家庭冷却都在服务端状态里，刷新面板后同样有效。
  async function returnParents() {
    const pending = new Set(view.state.births.flatMap(birth => birth.parents));
    task.autoPairs = task.autoPairs.filter(pair => {
      const [left, right] = pair.ids.map(id => view.state.residents.find(item => item.id === id));
      const room = view.state.rooms.find(item => item.id === pair.roomId);
      if (!left || !right || left.deadAt !== null || right.deadAt !== null) return false;
      // 配对人员被调离宿舍或房间变化时作废，下一轮重新配对。
      if (!room || room.type !== 'quarters' || left.roomId !== pair.roomId || right.roomId !== pair.roomId) return false;
      // 任一人已待产或已进入家庭冷却，说明配对完成，父母可以离开宿舍。
      const done = resident => pending.has(resident.id) || resident.familyCooldownUntil > view.serverTime;
      return !(done(left) || done(right));
    });
    const pairing = new Set(task.autoPairs.flatMap(pair => pair.ids));
    const questTeams = questTeamIds();
    const candidates = view.state.residents.filter(resident => {
      if (pairing.has(resident.id)) return false;
      if (task.pendingDispatch[resident.id]) return false;
      if (questTeams.has(resident.id)) return false;
      if (resident.deadAt !== null || resident.away !== null || resident.adultAt > view.serverTime) return false;
      const room = view.state.rooms.find(item => item.id === resident.roomId);
      if (room && room.type !== 'quarters') return false;
      // 待产父母，或孩子已出生、正处于家庭冷却的父母。
      return pending.has(resident.id) || resident.familyCooldownUntil > view.serverTime;
    }).sort((left, right) => left.id - right.id);
    for (const member of candidates) {
      if (stopped()) return;
      const resident = view.state.residents.find(item => item.id === member.id);
      if (!resident || resident.deadAt !== null || resident.away !== null) continue;
      const room = chooseProductionRoom(resident);
      if (!room) { log(`自动生育：${resident.name} 生育完成，暂无生产空位，留在原处等待。`); continue; }
      if (!await act({ type: 'assign', residentId: resident.id, roomId: room.id })) return;
      if (view.state.residents.find(item => item.id === resident.id)?.roomId !== room.id) throw new Error('生育父母回岗结果未确认');
      log(`自动生育：${resident.name} 生育完成，回到${room.floor} 层 ${room.level} 级${roomLabels[room.type] ?? room.type}（房间 ${room.id}）。`);
    }
  }
  // 宿舍只留给正在配对、已有感情、待产或家庭冷却中的居民。非全 10 的成人
  // （包括非全 10 的感情配对）不能留在宿舍，避免游戏自动配生出资质不够的孩子；
  // 全 10 但没配上对的成人也先安排生产岗位，等下一轮有配对对象时再从岗位拉回宿舍。
  async function evictNonGodAdults() {
    const now = view.serverTime;
    const pending = new Set(view.state.births.flatMap(birth => birth.parents));
    const pairing = new Set(task.autoPairs.flatMap(pair => pair.ids));
    const questTeams = questTeamIds();
    const candidates = view.state.residents.filter(resident => {
      if (resident.deadAt !== null || resident.away !== null || resident.adultAt > now) return false;
      if (task.pendingDispatch[resident.id] || questTeams.has(resident.id)) return false;
      const room = view.state.rooms.find(item => item.id === resident.roomId);
      if (room?.type !== 'quarters') return false;
      // 正在配对或待产/冷却中的居民由自动生育流程处理，避免重复调动。
      if (pairing.has(resident.id) || pending.has(resident.id) || resident.familyCooldownUntil > now) return false;
      // 全 10 且已有感情的居民继续留在宿舍培养感情。
      if (keys.every(key => resident.stats[key] === 10) && resident.romance) return false;
      return true;
    }).sort((left, right) => left.id - right.id);
    for (const member of candidates) {
      if (stopped()) return;
      const resident = view.state.residents.find(item => item.id === member.id);
      if (!resident || resident.deadAt !== null || resident.away !== null) continue;
      const room = view.state.rooms.find(item => item.id === resident.roomId);
      if (room?.type !== 'quarters') continue;
      const god = keys.every(key => resident.stats[key] === 10);
      const choice = chooseProductionRoom(resident);
      if (!choice) { log(`自动生育：${resident.name} ${god ? '尚未配对' : '不是全 10'}，暂无生产空位，留在宿舍等待。`); continue; }
      if (!await act({ type: 'assign', residentId: resident.id, roomId: choice.id })) return;
      if (view.state.residents.find(item => item.id === resident.id)?.roomId !== choice.id) throw new Error('居民调离宿舍结果未确认');
      log(god
        ? `自动生育：${resident.name} 尚未配对，先安排到 ${choice.floor} 层${roomLabels[choice.type] ?? choice.type}（房间 ${choice.id}）。`
        : `自动生育：${resident.name} 不是全 10，不能留在宿舍生育，安排到 ${choice.floor} 层${roomLabels[choice.type] ?? choice.type}（房间 ${choice.id}）。`);
    }
  }
  // 已经建立感情关系但被调到不同宿舍的两人，重新安排到同一间宿舍继续积累感情；
  // 待产或家庭冷却中的不处理。优先使用成员当前所在的宿舍。
  async function reuniteCouples() {
    const now = view.serverTime;
    const byId = new Map(view.state.residents.map(resident => [resident.id, resident]));
    const pending = new Set(view.state.births.flatMap(birth => birth.parents));
    const pairing = new Set(task.autoPairs.flatMap(pair => pair.ids));
    const seen = new Set();
    for (const resident of view.state.residents) {
      if (stopped()) return;
      if (seen.has(resident.id) || !resident.romance) continue;
      const partner = byId.get(resident.romance.partnerId);
      if (!partner || partner.romance?.partnerId !== resident.id) continue;
      seen.add(resident.id);
      seen.add(partner.id);
      const members = [resident, partner];
      if (members.some(item => item.deadAt !== null || item.away !== null || item.adultAt > now)) continue;
      // 等待再次派出的探险归来者留在门外，不拉回宿舍。
      if (members.some(item => task.pendingDispatch[item.id])) continue;
      // 本周任务小队成员在领取前不拉回宿舍。
      const questTeams = questTeamIds();
      if (members.some(item => questTeams.has(item.id))) continue;
      // 只为七项基础属性全 10 的配对恢复同房；非全 10 的感情关系不主动拉回宿舍。
      if (members.some(item => !keys.every(key => item.stats[key] === 10))) continue;
      if (members.some(item => pending.has(item.id) || item.familyCooldownUntil > now)) continue;
      const current = view.state.rooms.find(room => room.id === resident.roomId);
      if (current?.type === 'quarters' && resident.roomId === partner.roomId) continue;
      const fits = room => {
        const list = adultsIn(room.id);
        if (room.width * 2 - list.length < 2) return false;
        if (pairsInRoom(room.id) >= pairCapacity(room)) return false;
        // 房内不能有其他未配对的成人，避免服务端把新来的人和别人凑成一对。
        return !list.some(item => !members.some(member => member.id === item.id) && !hasPartner(item, list));
      };
      const rooms = view.state.rooms.filter(room => room.type === 'quarters' && room.builtAt <= now &&
          room.upgradeAt === null && !room.incident && fits(room))
        .sort((left, right) => right.level - left.level || right.width - left.width || left.floor - right.floor || left.id - right.id);
      const room = rooms.find(item => item.id === resident.roomId) ?? rooms.find(item => item.id === partner.roomId) ?? rooms[0];
      if (!room) { log(`自动生育：${resident.name} ＋ ${partner.name} 感情已建立但暂无可用宿舍，等待空位。`); continue; }
      for (const member of members) {
        if (member.roomId === room.id) continue;
        if (!await act({ type: 'assign', residentId: member.id, roomId: room.id })) return;
        if (view.state.residents.find(item => item.id === member.id)?.roomId !== room.id) throw new Error('感情配对恢复结果未确认');
      }
      if (!pairing.has(resident.id) || !pairing.has(partner.id)) {
        task.autoPairs.push({ roomId: room.id, ids: [resident.id, partner.id] });
        pairing.add(resident.id);
        pairing.add(partner.id);
      }
      const progress = Math.min(100, Math.floor(resident.romance.progress ?? 0));
      log(`自动生育：${resident.name} ＋ ${partner.name}（感情 ${progress}%）重新安排到同一间宿舍（房间 ${room.id}）。`);
    }
  }
  // 造神计划：成年子代（有父母且父母仍在避难所，含手动生育）属性总和未到 70 的优先训练，
  // 按总和从高到低排队，先练最高的未满属性；没有训练空位或已满 70 时按资源缺口和零件、
  // 废料等顺序安排生产岗位，不留在宿舍等待。
  async function assignGrownChildren() {
    const assigned = new Set(task.autoAssigned);
    const total = resident => keys.reduce((sum, key) => sum + resident.stats[key], 0);
    const occupied = roomId => view.state.residents.filter(item => item.roomId === roomId && item.deadAt === null &&
      item.adultAt <= view.serverTime).length;
    function trainingRoom(resident) {
      return view.state.rooms.filter(room => room.type === 'training' && room.builtAt <= view.serverTime &&
          room.upgradeAt === null && !room.incident && !room.unpowered && keys.includes(room.trainStat) &&
          occupied(room.id) < room.width * 2 && resident.stats[room.trainStat] < 10)
        .sort((left, right) => resident.stats[right.trainStat] - resident.stats[left.trainStat] ||
          right.level - left.level || right.width - left.width || left.floor - right.floor || left.id - right.id)[0] ?? null;
    }
    // 刷新面板后 autoParents 会丢失，因此按“父母仍在避难所”识别成年子代；
    // 无父母的新人、已在生产或训练岗位的居民不在其中。
    const living = new Set(view.state.residents.filter(resident => resident.deadAt === null).map(resident => resident.id));
    const pendingParents = new Set(view.state.births.flatMap(birth => birth.parents));
    const pairing = new Set(task.autoPairs.flatMap(pair => pair.ids));
    const questTeams = questTeamIds();
    const children = view.state.residents.filter(resident =>
      !assigned.has(resident.id) && resident.deadAt === null && resident.away === null && resident.adultAt <= view.serverTime &&
      resident.parents.length === 2 && resident.parents.every(id => living.has(id)) &&
      // 等待再次派出的探险归来者留在门外，不安排岗位。
      !task.pendingDispatch[resident.id] &&
      // 本周任务小队成员在领取前不安排岗位。
      !questTeams.has(resident.id) &&
      // 正在培养感情、待产或家庭冷却中的居民属于自动生育流程，不能当成成年子代调去工作。
      !resident.romance && !(resident.familyCooldownUntil > view.serverTime) &&
      !pendingParents.has(resident.id) && !pairing.has(resident.id))
      .sort((left, right) => total(right) - total(left) || left.id - right.id);
    for (const member of children) {
      if (stopped()) return;
      const resident = view.state.residents.find(item => item.id === member.id);
      if (!resident || assigned.has(resident.id) || resident.deadAt !== null || resident.away !== null ||
          resident.adultAt > view.serverTime) continue;
      const sum = total(resident);
      const currentRoom = view.state.rooms.find(item => item.id === resident.roomId);
      if (currentRoom?.type === 'training' && sum < 70 && resident.stats[currentRoom.trainStat] < 10) continue;
      if (currentRoom && currentRoom.type !== 'training' && !['quarters', 'storage', 'door', 'elevator'].includes(currentRoom.type)) {
        // 已在生产岗位且未满 70 的成年子代，有空训练位时转去训练；否则保持岗位。
        const training = sum < 70 ? trainingRoom(resident) : null;
        if (training) {
          if (!await act({ type: 'assign', residentId: resident.id, roomId: training.id })) return;
          if (view.state.residents.find(item => item.id === resident.id)?.roomId !== training.id) throw new Error('训练安排结果未确认');
          log(`造神计划：${resident.name}（属性 ${sum}/70）训练空位已出现，转练 ${statLabels[training.trainStat]} → ${training.floor} 层训练室（房间 ${training.id}）。`);
          continue;
        }
        task.autoAssigned.push(resident.id);
        assigned.add(resident.id);
        continue;
      }
      if (sum < 70) {
        const room = trainingRoom(resident);
        if (room) {
          if (!await act({ type: 'assign', residentId: resident.id, roomId: room.id })) return;
          if (view.state.residents.find(item => item.id === resident.id)?.roomId !== room.id) throw new Error('训练安排结果未确认');
          log(`造神计划：${resident.name} 已成年（属性 ${sum}/70），优先训练 ${statLabels[room.trainStat]} → ${room.floor} 层训练室（房间 ${room.id}）。`);
          continue;
        }
      }
      // 没有训练空位时直接去生产岗位，不留在宿舍等待。
      const choice = chooseProductionRoom(resident);
      if (!choice) { log(`造神计划：${resident.name} 已成年，暂无训练或生产空位，下轮继续。`); continue; }
      if (!await act({ type: 'assign', residentId: resident.id, roomId: choice.id })) return;
      if (view.state.residents.find(item => item.id === resident.id)?.roomId !== choice.id) throw new Error('成年居民安排结果未确认');
      task.autoAssigned.push(resident.id);
      assigned.add(resident.id);
      log(sum < 70
        ? `造神计划：${resident.name} 已成年（属性 ${sum}/70），暂无训练空位，先安排到 ${choice.floor} 层${roomLabels[choice.type] ?? choice.type}（房间 ${choice.id}）。`
        : `造神计划：${resident.name} 已成年且属性满 70，安排到 ${choice.floor} 层${roomLabels[choice.type] ?? choice.type}（房间 ${choice.id}）。`);
    }
  }
  // 门外待命区的归来居民：探险或本周任务结束回到门外、又不在“等待再次派出”名单时，
  // 安排到生产岗位。电台新居民保持门外；仍在任务中的成员、正在配对/待产/冷却的居民不处理。
  async function assignReturnedResidents() {
    const now = view.serverTime;
    const pendingParents = new Set(view.state.births.flatMap(birth => birth.parents));
    const pairing = new Set(task.autoPairs.flatMap(pair => pair.ids));
    // 本周任务进行中的小队成员仍在门外，任务领取后才算归来。
    const questMembers = new Set((view.state.quests ?? []).flatMap(quest =>
      Array.isArray(quest.team) ? quest.team : quest.team?.members ?? []));
    const outside = view.state.residents.filter(resident =>
      resident.deadAt === null && resident.away === null && resident.adultAt <= now && resident.roomId === null &&
      !task.pendingDispatch[resident.id] && !task.newcomers.includes(resident.id) && !questMembers.has(resident.id) &&
      !resident.romance && !(resident.familyCooldownUntil > now) &&
      !pendingParents.has(resident.id) && !pairing.has(resident.id))
      .sort((left, right) => left.id - right.id);
    for (const member of outside) {
      if (stopped()) return;
      const resident = view.state.residents.find(item => item.id === member.id);
      if (!resident || resident.deadAt !== null || resident.away !== null || resident.roomId !== null) continue;
      const choice = chooseProductionRoom(resident);
      if (!choice) { log(`门外归来：${resident.name} 暂无生产空位，留在门外等待。`); continue; }
      if (!await act({ type: 'assign', residentId: resident.id, roomId: choice.id })) return;
      if (view.state.residents.find(item => item.id === resident.id)?.roomId !== choice.id) throw new Error('门外居民安排结果未确认');
      log(`门外归来：${resident.name} 安排到 ${choice.floor} 层${roomLabels[choice.type] ?? choice.type}（房间 ${choice.id}）。`);
    }
  }
  // 本周废土任务：小队到家后领取。完成的任务不再重试，队员回到训练、生育、工作等正常调度；
  // 失败的任务记录原班人马，随后按同样的队伍重新派出。任务领取前，小队成员在其他调度中全部排除。
  async function handleWeeklyQuests() {
    const titleOf = questId => (view.env?.quests ?? []).find(quest => quest.id === questId)?.title ?? questId;
    const runs = Array.isArray(view.state.quests) ? view.state.quests : [];
    for (const run of [...runs]) {
      if (stopped()) return;
      if (run.returnAt === null || run.returnAt > view.serverTime) continue;
      const team = Array.isArray(run.team) ? [...run.team] : [];
      const failed = run.status === 'failed';
      const title = titleOf(run.questId);
      try {
        if (!await act({ type: 'quest_claim', runId: run.id })) return;
      } catch (error) {
        if (error.fatal || error.stopped) throw error;
        log(`本周任务：${title} 领取失败：${error.message}`);
        continue;
      }
      log(failed ? `本周任务：${title} 失败，小队已回家，准备原班人马重试。` : `本周任务：${title} 完成，小队已回家。`);
      if (failed && team.length) task.questRetries[run.questId] = team;
    }
    for (const [questId, team] of Object.entries(task.questRetries)) {
      if (stopped()) return;
      // 同任务已有进行中或待领取的小队时，等结算后再决定是否重试。
      if (view.state.quests.some(run => run.questId === questId)) continue;
      if ((view.state.weekly?.completed ?? []).includes(questId)) { delete task.questRetries[questId]; continue; }
      const members = team.map(id => view.state.residents.find(resident => resident.id === id));
      if (members.some(resident => !resident || resident.deadAt !== null || resident.away !== null ||
          resident.adultAt > view.serverTime)) {
        log(`本周任务：${titleOf(questId)} 原班人马不全，暂不重试。`);
        continue;
      }
      try {
        if (!await act({ type: 'quest_start', questId, team })) return;
        delete task.questRetries[questId];
        log(`本周任务：${titleOf(questId)} 已按原班人马重新派出。`);
      } catch (error) {
        if (error.fatal || error.stopped) throw error;
        log(`本周任务：${titleOf(questId)} 重试失败：${error.message}`);
      }
    }
  }
  // 快速检查：成年子代安排训练或工作、待产父母回岗、配对后补资源缺口、穿上装备，
  // 不必等完整检查间隔。
  async function quickCheck() {
    await read();
    if (stopped()) return;
    if (task.incidentSnapshot || view.state.rooms.some(room => room.incident)) return;
    // 本周任务到家的领取和失败重试也要及时处理，不必等完整检查间隔。
    await handleWeeklyQuests();
    if (stopped()) return;
    await returnParents();
    if (stopped()) return;
    await evictNonGodAdults();
    if (stopped()) return;
    await reuniteCouples();
    if (stopped()) return;
    await autoBirth(true);
    if (stopped()) return;
    // 配对把人调去宿舍后可能立刻出现电力、食物、净水缺口，马上从废料回收站等岗位补人。
    await balanceResources();
    if (stopped()) return;
    await assignGrownChildren();
    if (stopped()) return;
    await assignReturnedResidents();
    if (stopped()) return;
    await upgradeRooms();
    if (stopped()) return;
    await applyOutfits();
  }
  (async () => {
    try {
      if (location.origin !== 'https://game.arkengine.me' || !/^\/shelter\/?$/.test(location.pathname)) throw new Error('请在自己的避难所页面开启');
      if (globalThis.__fengbaoWorkAssignment?.running || globalThis.__fengbaoDormAssignment?.running || globalThis.__fengbaoResidentRename?.running) throw new Error('其他居民任务正在运行，请等待完成');
      let greeted = false, roundError = false;
      while (!stopped()) {
        try {
          // 与页面右上角刷新、全部收取按钮使用相同接口，不刷新整张网页。
          await read();
          if (stopped()) break;
          if (!greeted) {
            // 首次开启纳入门外无父母的成人；之后以新增 ID 识别电台新居民，不碰原岗位。
            if (!task.knownIds) {
              task.knownIds = view.state.residents.map(resident => resident.id);
              if (view.state.rooms.some(room => room.type === 'radio')) task.newcomers = view.state.residents.filter(resident => resident.roomId === null && resident.away === null && resident.deadAt === null && resident.adultAt <= view.serverTime && resident.parents.length === 0).map(resident => resident.id);
            }
            // 每次开启重新记录已有名单，停用期间到来的居民也不参与自动遣散。
            task.knownIds = view.state.residents.map(resident => resident.id);
            greeted = true;
            log(`托管开启：每 ${intervalSeconds} 秒检查，废土 ${recallEvents} 次事件召回${task.birthEnabled ? '，自动生育已开启' : ''}。`);
          }
          await act({ type: 'collect_all' });
          if (stopped()) break;
          const incident = view.state.rooms.find(room => room.incident);
          if (rescueEnabled && !incident && task.incidentSnapshot) {
            log('事件已结束，正在按快照恢复居民站位。');
            const pending = task.incidentSnapshot.filter(({ residentId, roomId }) => {
              const resident = view.state.residents.find(item => item.id === residentId);
              return resident && resident.away === null && resident.deadAt === null && resident.adultAt <= view.serverTime && resident.roomId !== roomId;
            });
            // 先腾出被调动者的现岗位，再恢复原位，避免满房间之间互相占位。
            for (const { residentId, roomId } of pending) {
              if (stopped()) break;
              const resident = view.state.residents.find(item => item.id === residentId);
              if (resident.roomId === null || resident.roomId === roomId) continue;
              if (!await act({ type: 'assign', residentId, roomId: null })) break;
              if (view.state.residents.find(item => item.id === residentId)?.roomId !== null) throw new Error('事件恢复腾位结果未确认');
            }
            for (const { residentId, roomId } of pending) {
              if (stopped()) break;
              if (view.state.residents.find(item => item.id === residentId).roomId === roomId) continue;
              if (!await act({ type: 'assign', residentId, roomId })) break;
              if (view.state.residents.find(item => item.id === residentId)?.roomId !== roomId) throw new Error('事件站位恢复结果未确认');
            }
            if (stopped()) break;
            task.incidentSnapshot = null;
            log('已按快照恢复可调动居民站位，快照已清除。');
          } else if (rescueEnabled && incident && !task.incidentSnapshot) {
            // 事件首次出现时保存全部站位，同一事件周期内不覆盖快照。
            task.incidentSnapshot = view.state.residents.map(resident => ({ residentId: resident.id, roomId: resident.roomId }));
            log('发现避难所事件，已保存居民站位快照。');
            if (rescueMode === 'auto') {
              for (let count = 0; count < rescueCount; count++) {
                if (!await act({ type: 'rescue_incident', roomId: incident.id })) break;
                log(`事件救援：已执行 ${count + 1}/${rescueCount} 次一键救援（房间 ${incident.id}）。`);
              }
            } else {
              // 灭火、堵漏由餐厅支援，其余战斗事件由发电站和武器工坊支援。
              const useDiner = ['fire', 'leak'].includes(incident.incident.kind);
              const sourceTypes = useDiner ? ['diner'] : ['power', 'armory'];
              const sourceRooms = new Set(view.state.rooms.filter(room => sourceTypes.includes(room.type) && !room.incident).map(room => room.id));
              const candidates = view.state.residents.filter(resident => sourceRooms.has(resident.roomId) && resident.away === null && resident.deadAt === null && resident.adultAt <= view.serverTime);
              const occupied = view.state.residents.filter(resident => resident.roomId === incident.id && resident.deadAt === null && resident.adultAt <= view.serverTime).length;
              const slots = Math.max(0, incident.width * 2 - occupied);
              const rescuers = candidates.slice(0, slots);
              log(`专人专救：${useDiner ? '餐厅' : '发电站和武器工坊'}可调动 ${candidates.length} 人，事件房间空位 ${slots} 个，本次派出 ${rescuers.length} 人。`);
              for (const resident of rescuers) {
                if (stopped() || !view.state.rooms.find(room => room.id === incident.id).incident) break;
                if (!await act({ type: 'assign', residentId: resident.id, roomId: incident.id })) break;
                if (view.state.residents.find(item => item.id === resident.id)?.roomId !== incident.id) throw new Error('专人专救调动结果未确认');
                log(`专人专救：${resident.name} → 事件房间 ${incident.id}。`);
              }
            }
          } else if (rescueEnabled && incident && task.incidentSnapshot) {
            log('事件正在处理中，保留站位快照，继续本轮后续步骤。');
          }
          if (stopped()) break;
          // 本周任务到家后领取；完成的任务放回正常调度，失败的任务按原班人马重试。
          await handleWeeklyQuests();
          if (stopped()) break;
          const hasRadio = view.state.rooms.some(room => room.type === 'radio' && room.builtAt <= view.serverTime);
          if (hasRadio) {
            for (const resident of view.state.residents) if (!task.knownIds.includes(resident.id) && resident.parents.length === 0 && resident.adultAt <= view.serverTime && resident.roomId === null && resident.away === null && resident.deadAt === null) {
              if (stopped()) break;
              // 只在首次发现门外新成人时判断，已有居民和旧待改名队列不参与遣散。
              if (dismissEnabled || dismissStatEnabled) {
                const values = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'].map(key => resident.stats[key]);
                if (!values.every(Number.isFinite)) throw new Error('新居民属性数据不完整，无法判断遣散');
                const total = values.reduce((sum, value) => sum + value, 0);
                // 单项条件只判断用户指定的基础属性。
                const statValue = resident.stats[dismissStatKey];
                // 面板单选总属性或指定属性，对选中的条件判断遣散。
                const totalTooLow = dismissEnabled && total < dismissTotal;
                const statTooLow = dismissStatEnabled && statValue < dismissStat;
                if (totalTooLow || statTooLow) {
                  if (!await act({ type: 'dismiss', residentId: resident.id })) break;
                  if (view.state.residents.some(item => item.id === resident.id)) throw new Error('新人遣散结果未确认');
                  log(`新人遣散：${resident.name}（ID ${resident.id}），${totalTooLow ? `总属性 ${total} < ${dismissTotal}` : `${statLabels[dismissStatKey]} ${statValue} < ${dismissStat}`}。`);
                  continue;
                }
              }
              task.newcomers.push(resident.id);
            }
          }
          task.knownIds = view.state.residents.map(resident => resident.id);
          log(hasRadio ? `新人检查：待改名 ${task.newcomers.length} 人。` : '没有电台，跳过新人检查。');
          if (hasRadio) for (const id of [...task.newcomers]) {
            if (stopped()) break;
            let resident = view.state.residents.find(item => item.id === id);
            if (!resident || resident.roomId !== null || resident.away !== null || resident.deadAt !== null) { task.newcomers = task.newcomers.filter(item => item !== id); continue; }
            const attributes = [['str', '力'], ['per', '感'], ['end', '耐'], ['cha', '魅'], ['int', '智'], ['agi', '敏'], ['lck', '幸']];
            const highest = Math.max(...attributes.map(([key]) => resident.stats[key]));
            const label = attributes.filter(([key]) => resident.stats[key] === highest).map(([,label]) => label).join('');
            const numbers = view.state.residents.map(item => item.name.match(/^(\d+)(?:\([\d,]+\))?([A-Z]*)$/) || item.name.match(/^[^-]+-(\d+)([A-Z]*)$/));
            const own = resident.name.match(/^(\d+)(?:\([\d,]+\))?([A-Z]*)$/) || resident.name.match(/^[^-]+-(\d+)([A-Z]*)$/);
            const number = own ? Number(own[1]) : Math.max(0, ...numbers.filter(Boolean).map(match => Number(match[1]))) + 1;
            const name = `${label}-${String(number).padStart(3, '0')}${own?.[2] ?? ''}`;
            if (name.length > 12) throw new Error(`新名字 ${name} 超过 12 字`);
            if (resident.name !== name) {
              if (!await act({ type: 'rename_resident', residentId: id, name })) break;
              resident = view.state.residents.find(item => item.id === id);
              if (resident.name !== name) throw new Error('新人改名结果未确认');
              log(`新人改名：${name}（ID ${id}）。`);
            }
            // 新人改名完成后出队，保持门外位置。
            task.newcomers = task.newcomers.filter(item => item !== id);
          }
          if (stopped()) break;
          const paused = () => Boolean(task.incidentSnapshot) || view.state.rooms.some(room => room.incident);
          // 先补电力、食物、净水缺口，再考虑训练和造神转岗，保证资源不因训练抽人转负。
          if ((godEnabled || task.birthEnabled) && paused()) log('资源补缺：事件处理中，暂停居民调动。');
          else if (godEnabled || task.birthEnabled) await balanceResources();
          if (stopped()) break;
          if (godEnabled) {
            // 救援快照归位完成后再调整训练岗位，避免新安排被快照覆盖。
            if (paused()) log('造神计划：事件处理中，暂停居民调动。');
            else {
              const plan = planShelterGod(view);
              log(`造神计划：检查完成，本轮 ${plan.assignments.length} 步调动。`);
              for (const { residentId, roomId, message } of plan.assignments) {
                if (!await act({ type: 'assign', residentId, roomId })) break;
                if (view.state.residents.find(resident => resident.id === residentId).roomId !== roomId) throw new Error('造神计划调动结果未确认');
                log(message);
              }
            }
          }
          if (stopped()) break;
          if (task.birthEnabled) {
            if (stopped()) break;
            // 与造神计划一致，事件处理或救援站位未归位时暂停居民调动。
            if (paused()) log('自动生育：事件处理中，暂停居民调动。');
            else {
              await returnParents();
              if (stopped()) break;
              await evictNonGodAdults();
              if (stopped()) break;
              await reuniteCouples();
              if (stopped()) break;
              await autoBirth();
              if (stopped()) break;
              await assignGrownChildren();
              if (stopped()) break;
              await assignReturnedResidents();
            }
          }
          if (stopped()) break;
          // 造神计划和自动生育调动结束后再补一次缺口：配对把居民拉去宿舍后可能出现负收益。
          if ((godEnabled || task.birthEnabled) && !paused()) await balanceResources();
          if (stopped()) break;
          // 同种资源有空位时，把低等级房间的居民迁到高等级房间。
          if ((godEnabled || task.birthEnabled) && !paused()) await upgradeRooms();
          if (stopped()) break;
          // 岗位调整完成后统一穿戴装备：按房间需要的属性重新分配服装。
          if ((godEnabled || task.birthEnabled) && paused()) log('装备分配：事件处理中，暂停换装。');
          else if (godEnabled || task.birthEnabled) await applyOutfits();
          log(view.state.explorers.length ? `废土检查：${view.state.explorers.length} 名探险者。` : '没有外出探险人员，跳过废土检查。');
          for (const original of [...view.state.explorers]) {
            if (stopped()) break;
            const explorer = view.state.explorers.find(item => item.id === original.id);
            const config = deployment(explorer);
            const resident = view.state.residents.find(item => item.id === explorer.residentId);
            if (resident.deadAt !== null) { log(`废土：${resident.name} 已倒下，请手动救回。`); continue; }
            if (explorer.returnAt !== null && explorer.returnAt <= view.serverTime) {
              if (!await act({ type: 'explore_claim', explorerId: explorer.id })) break;
              if (view.state.explorers.some(item => item.id === explorer.id)) throw new Error('探险领取结果未确认');
              task.pendingDispatch[resident.id] = { ...config, healed: false };
              delete task.deployments[explorer.id];
              log(`废土：${resident.name} 已到家并领取，准备原样再次派出。`);
            } else if (explorer.recalledAt !== null) log(`废土：${resident.name} 正在返程。`);
            else {
              // events 是服务端实际事件次数，不包含 startedAt 对应的初始出发日志。
              if (!Number.isInteger(explorer.events)) throw new Error('废土事件计数格式已变化');
              log(`废土：${resident.name} 已触发 ${explorer.events}/${recallEvents} 次事件（不含出发日志）。`);
              if (explorer.events >= recallEvents) {
                if (!await act({ type: 'explore_recall', explorerId: explorer.id })) break;
                if (view.state.explorers.find(item => item.id === explorer.id)?.recalledAt == null) throw new Error('召回结果未确认');
                log(`废土：已召回 ${resident.name}。`);
              }
            }
          }
          for (const [id,{ healed, ...config }] of Object.entries(task.pendingDispatch)) {
            if (stopped()) break;
            const resident = view.state.residents.find(item => item.id === Number(id));
            if (resident.away !== null) { log(`废土：${resident.name} 已外出，停止本条重复派出。`); delete task.pendingDispatch[id]; continue; }
            // 按游戏规则计算血量上限，每次归来只用一针，等待再次出发时不重复治疗。
            const level = Math.min(50, 1 + Math.floor(Math.sqrt(Math.max(0, resident.xp) / 3)));
            const maxHp = Math.round(100 + (level - 1) * (2 + 0.5 * resident.stats.end));
            if (!healed && resident.hp < maxHp * 0.6) {
              if (view.state.resources.stimpak < 1) { log(`废土：${resident.name} 血量低于 60%，治疗针不足，等待下轮治疗。`); continue; }
              if (!await act({ type: 'stimpak', residentId: resident.id })) break;
              task.pendingDispatch[id].healed = true;
              log(`废土：${resident.name} 血量低于 60%，已使用 1 支治疗针。`);
            }
            if (view.state.resources.stimpak < config.stimpaks) { log(`废土：${resident.name} 原配置需 ${config.stimpaks} 支治疗针，库存不足，保留配置等待下轮。`); continue; }
            if (!await act({ type: 'explore_start', ...config })) break;
            const expedition = view.state.explorers.find(item => item.residentId === Number(id));
            if (!expedition) throw new Error('再次派出结果未确认');
            task.deployments[expedition.id] = config;
            delete task.pendingDispatch[id];
            log(`废土：${resident.name} 已按原区域、${config.stimpaks} 支治疗针、${config.abyss ? '深渊' : '普通'}模式再次出发。`);
          }
        } catch (error) {
          if (error.fatal) throw error;
          if (error.stopped || stopped()) break;
          log(`本轮遇到临时错误：${error.message}；已保留现有状态，稍后继续。`);
          roundError = true;
        }
        if (stopped()) break;
        const nextAt = Date.now() + intervalSeconds * 1000;
        task.nextAt = nextAt;
        log(`本轮${roundError ? '因临时错误跳过剩余步骤' : '完成'}，${intervalSeconds} 秒后开始下一轮。`);
        roundError = false;
        // 成年子代、待产父母和装备不必等完整间隔：等待期间每 30 秒快速检查一次。
        while (!stopped() && Date.now() < nextAt) {
          await wait(Math.min(30000, nextAt - Date.now()));
          if (stopped()) break;
          if (!task.birthEnabled) continue;
          try {
            await quickCheck();
          } catch (error) {
            if (error.fatal) throw error;
            if (error.stopped || stopped()) break;
          }
        }
        task.nextAt = null;
      }
      log('托管已关闭；已执行操作保留。');
    } catch (error) {
      log(`托管已停止：${error.message}。已执行操作保留，请检查游戏页面。`);
    } finally {
      clearTimeout(task.timer);
      task.running = false;
      task.nextAt = null;
      task.wake = null;
    }
  })();
}
