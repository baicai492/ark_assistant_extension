// 整个函数注入游戏页执行，关闭扩展面板后仍继续当前批次。
function startDormAssignment(pairs) {
  if (globalThis.__fengbaoShelterAuto?.running) return;
  if (globalThis.__fengbaoDormAssignment?.running) return;
  const task = { running: true, message: '正在读取宿舍和居民状态…', completed: [], moved: 0 };
  globalThis.__fengbaoDormAssignment = task;

  (async () => {
    let view;
    const keys = ['str', 'per', 'end', 'cha', 'int', 'agi', 'lck'];
    function updateView(data) {
      if (!Array.isArray(data?.state?.rooms) || !Array.isArray(data.state.residents) || !Array.isArray(data.state.births) ||
          !Number.isFinite(data.serverTime)) throw new Error('游戏返回的数据格式已变化');
      view = data;
    }
    function occupants(roomId) {
      // 儿童不能调动，也不占成人名额；清理和入住校验只统计成人。
      return view.state.residents.filter(resident => resident.roomId === roomId && resident.deadAt === null &&
        resident.adultAt <= view.serverTime);
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
            (resident.romance && view.state.rooms.some(room => room.id === resident.roomId && room.type === 'quarters')) || resident.familyCooldownUntil > view.serverTime) {
          throw new Error(`「${resident.name}」当前无法调动配对，请重新计算或等待其状态恢复`);
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
      // 合并的多人宿舍也只使用一次；升级中的宿舍按当前等级参与排序，与游戏下拉框一致。
      // 与游戏的宿舍待产标记一致，按待产记录的 roomId 判断，父母离开也仍然跳过。
      const available = dorms.filter(room => room.builtAt <= view.serverTime && !room.incident &&
        !view.state.births.some(birth => birth.roomId === room.id) &&
        !occupants(room.id).some(resident => resident.romance))
        .sort((left, right) => right.level - left.level || left.floor - right.floor || left.col - right.col || left.id - right.id);
      if (!available.length) throw new Error('没有可用宿舍（待产、培养感情中、未建好或发生事故的宿舍已跳过）');
      const ordered = pairs.map(pair => ({ ids: pair.map(resident => resident.id), total: pair[0].total + pair[1].total }))
        .sort((left, right) => right.total - left.total);
      const plan = ordered.slice(0, available.length).map((pair, index) => ({ ...pair, room: available[index] }));
      // 先校验本批所有配对，再开始调动；保留计算出来的组合，不临时换人。
      for (const item of plan) checkPair(item.ids);

      // 先移走全部目标宿舍的原有成人，保留儿童，避免成人之间临时混住。
      for (const { room } of plan) {
        for (const resident of occupants(room.id)) await moveResident(resident.id, null);
      }
      for (const { ids, room } of plan) {
        const members = checkPair(ids);
        const currentRoom = view.state.rooms.find(item => item.id === room.id);
        if (!currentRoom || currentRoom.type !== 'quarters' || currentRoom.incident ||
            currentRoom.builtAt > view.serverTime || occupants(room.id).length) {
          throw new Error(`${room.floor} 层宿舍状态已变化，停止安排`);
        }
        for (const id of ids) await moveResident(id, room.id);
        const actual = occupants(room.id);
        if (actual.length !== 2 || !ids.every(id => actual.some(resident => resident.id === id))) {
          throw new Error(`${room.floor} 层宿舍入住结果不符，请检查游戏页面`);
        }
        task.completed.push(`${members.map(resident => resident.name).join(' ＋ ')} → ${room.floor} 层 ${room.level} 级宿舍${room.width > 1 ? ` ×${room.width}` : ''}（房间 ${room.id}）`);
      }
      const remaining = pairs.length - plan.length;
      task.message = `已安排 ${plan.length} 对，每间宿舍仅一对成人，儿童保留原处。${remaining ? `\n可用宿舍不足，剩余 ${remaining} 对未安排。` : ''}\n游戏画面如未更新，请刷新查看。`;
    } catch (error) {
      // 保留已完成的真实结果，失败后不继续，也不自动重试未知结果的请求。
      task.message = `安排已停止：${error.message}\n已完成 ${task.completed.length} 对，已确认调动 ${task.moved} 人次。请检查游戏页面后重新计算。`;
    } finally {
      task.running = false;
    }
  })();
}
