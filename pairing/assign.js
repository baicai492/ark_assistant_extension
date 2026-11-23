// 整个函数注入游戏页执行，关闭扩展面板后仍继续当前批次。
function startDormAssignment(pairs) {
  if (globalThis.__fengbaoShelterAuto?.running) return;
  if (globalThis.__fengbaoDormAssignment?.running) return;
  const task = { running: true, message: '正在读取宿舍和居民状态…', completed: [], moved: 0 };
  globalThis.__fengbaoDormAssignment = task;

  (async () => {
    let view;
    const skipping = globalThis.__fengbaoDormPairSkip(checkPair, () => view.state.residents);
    const keys = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'];
    // 游戏规则：6 人宿舍可同时安排两组生育，1 格宿舍只能一组。
    const MAX_PAIRS_PER_ROOM = 2;
    function updateView(data) {
      if (!Array.isArray(data?.state?.rooms) || !Array.isArray(data.state.residents) || !Array.isArray(data.state.births) ||
          !Number.isFinite(data.serverTime)) throw new Error('游戏返回的数据格式已变化');
      view = data;
    }
    function occupants(roomId) {
      // 儿童不能调动，也不占成人名额；清理和入住校验只统计成人。
      return view.state.residents.filter(resident => resident.roomId === roomId && resident.deadAt === null &&
        resident.away === null && resident.adultAt <= view.serverTime);
    }
    function hasPartner(resident, list) {
      return Boolean(resident.romance) && list.some(item => item.id === resident.romance.partnerId);
    }
    function pairsInRoom(roomId) {
      const list = occupants(roomId);
      return list.filter(resident => hasPartner(resident, list)).length / 2;
    }
    function checkPair(ids) {
      const members = ids.map(id => view.state.residents.find(resident => resident.id === id));
      for (const resident of members) {
        if (!resident) throw new Error('配对居民已不存在，请重新计算');
        if (typeof resident.name !== 'string' || !Number.isFinite(resident.adultAt) ||
            !Array.isArray(resident.parents) || !keys.every(key => Number.isFinite(resident.stats?.[key]))) {
          throw new Error(`居民「${resident.name ?? resident.id}」的数据不完整`);
        }
        if (resident.adultAt > view.serverTime || resident.away !== null || resident.deadAt !== null ||
            (resident.romance && view.state.rooms.some(room => room.id === resident.roomId && room.type === 'quarters')) ||
            resident.familyCooldownUntil > view.serverTime) {
          throw skipping.unavailable(`「${resident.name}」当前无法调动配对，请重新计算或等待其状态恢复`);
        }
        if (view.state.births.some(birth => birth.parents.includes(resident.id))) {
          throw new Error(`「${resident.name}」有孩子待出生，暂不能调动`);
        }
      }
      const [left, right] = members;
      if (left.parents.includes(right.id) || right.parents.includes(left.id) ||
          left.parents.some(id => right.parents.includes(id))) throw new Error('配对居民存在亲属关系，请重新计算');
      return members;
    }
    async function moveResident(residentId, roomId) {
      const resident = view.state.residents.find(item => item.id === residentId);
      // 保护宿舍内的感情关系，已离开宿舍的居民允许重新配对。
      if (!resident || (resident.romance && view.state.rooms.some(room => room.id === resident.roomId && room.type === 'quarters'))) throw new Error('居民状态已变化，停止后续调动');
      task.message = roomId === null ? `正在将「${resident.name}」移到门外休息…` : `正在安排「${resident.name}」入住宿舍…`;
      const response = await fetch('/api/shelter/action', {
        method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json' },
        // 与游戏“选择房间”和“休息”按钮使用相同的请求结构。
        body: JSON.stringify({ action: { type: 'assign', residentId, roomId }, idempotencyKey: crypto.randomUUID() })
      });
      if (response.redirected || response.status === 401 || response.status === 403) throw new Error('登录已失效，请重新登录');
      const data = await response.json();
      if (!response.ok || data.code === 'retry') throw new Error(data.error || `调动结果未确认（HTTP ${response.status}），请检查游戏页面`);
      updateView(data.view);
      if (view.state.residents.find(item => item.id === residentId)?.roomId !== roomId) {
        throw new Error(`「${resident.name}」的调动结果未确认，请检查游戏页面`);
      }
      task.moved++;
    }

    try {
      if (globalThis.__fengbaoWorkAssignment?.running) throw new Error('居民生产安排正在执行，请等待完成');
      if (location.origin !== 'https://game.arkengine.me' || !/^\/shelter\/?$/.test(location.pathname)) {
        throw new Error('请在自己的避难所页面安排');
      }
      const response = await fetch('/api/shelter', {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000)
      });
      if (response.redirected || response.status === 401 || response.status === 403) throw new Error('登录已失效，请重新登录');
      if (!response.ok) throw new Error(`读取宿舍失败（HTTP ${response.status}）`);
      updateView(await response.json());
      const dorms = view.state.rooms.filter(room => room.type === 'quarters');
      if (dorms.some(room => !['id', 'level', 'floor', 'col', 'width', 'builtAt'].every(key => Number.isFinite(room[key])))) {
        throw new Error('宿舍数据不完整，无法按等级安排');
      }
      // 合并的多人宿舍也只使用一次；升级中的宿舍暂不能入住，与游戏选择房间的校验一致。
      const available = dorms.filter(room => room.builtAt <= view.serverTime && room.upgradeAt === null && !room.incident)
        .sort((left, right) => right.level - left.level || left.floor - right.floor || left.col - right.col || left.id - right.id);
      if (!available.length) throw new Error('没有可用宿舍（施工、升级或发生事故的宿舍已跳过）');
      const ordered = pairs.map(pair => ({ ids: pair.map(resident => resident.id), total: pair[0].total + pair[1].total }))
        .sort((left, right) => right.total - left.total);
      // 待产父母不能移动，保留在房间内并计入成人容量；其他未配对成人可以移到门外腾位。
      const pendingParents = new Set(view.state.births.flatMap(birth => birth.parents));
      function protectedAdults(roomId) {
        const list = occupants(roomId);
        return list.filter(resident => hasPartner(resident, list) || pendingParents.has(resident.id)).length;
      }
      // 一个 6 人宿舍最多同时放两组；已有感情或待产的宿舍按剩余组数安排，成人容量另算。
      const plan = [];
      for (const pair of ordered) {
        const room = available.find(candidate => {
          const placed = plan.filter(item => item.room.id === candidate.id).length;
          return pairsInRoom(candidate.id) + placed < Math.min(MAX_PAIRS_PER_ROOM, candidate.width) &&
            protectedAdults(candidate.id) + (placed + 1) * 2 <= candidate.width * 2;
        });
        if (!room) break;
        plan.push({ ...pair, room });
      }
      // 先校验本批配对并跳过无法调动的组；保留原组合，不临时换人。
      const activePlan = skipping.filter(plan);

      // 只移走本批要使用的宿舍里的未配对成人；已有伴侣和待产父母原地保留。
      for (const room of [...new Set(activePlan.map(item => item.room.id))].map(id => view.state.rooms.find(item => item.id === id))) {
        for (const resident of occupants(room.id)) {
          if (hasPartner(resident, occupants(room.id)) || pendingParents.has(resident.id)) continue;
          await moveResident(resident.id, null);
        }
      }
      await skipping.run(activePlan, async ({ ids, room }, members) => {
        const currentRoom = view.state.rooms.find(item => item.id === room.id);
        if (!currentRoom || currentRoom.type !== 'quarters' || currentRoom.incident || currentRoom.upgradeAt !== null ||
            currentRoom.builtAt > view.serverTime ||
            pairsInRoom(room.id) >= Math.min(MAX_PAIRS_PER_ROOM, room.width) ||
            occupants(room.id).length + 2 > room.width * 2) {
          throw new Error(`${room.floor} 层宿舍状态已变化，停止安排`);
        }
        for (const id of ids) await moveResident(id, room.id);
        const actual = occupants(room.id);
        if (!ids.every(id => actual.some(resident => resident.id === id))) {
          throw new Error(`${room.floor} 层宿舍入住结果不符，请检查游戏页面`);
        }
        const group = plan.filter(item => item.room.id === room.id).findIndex(item => item.ids === ids) + 1;
        task.completed.push(`${members.map(resident => resident.name).join(' ＋ ')} → ${room.floor} 层 ${room.level} 级宿舍（房间 ${room.id}）第 ${group} 组`);
      });
      const remaining = pairs.length - plan.length;
      task.message = `已安排 ${task.completed.length} 对；6 人宿舍最多同时两组，已有感情或待产的宿舍按剩余组数安排。${remaining ? `\n可用组数不足，剩余 ${remaining} 对未安排。` : ''}\n儿童保留原处，未配对成人已移到门外。游戏画面如未更新，请刷新查看。${skipping.summary()}`;
    } catch (error) {
      // 保留已完成的真实结果，失败后不继续，也不自动重试未知结果的请求。
      task.message = `安排已停止：${error.message}\n已完成 ${task.completed.length} 对，已确认调动 ${task.moved} 人次。请检查游戏页面后重新计算。${skipping.summary()}`;
    } finally {
      task.running = false;
    }
  })();
}
