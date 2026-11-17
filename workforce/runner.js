(() => {
  if (globalThis.__fengbaoShelterAuto?.running) return;
  if (globalThis.__fengbaoWorkAssignment?.running) return;
  const task = { running: true, message: '正在读取居民和生产数据…', moved: 0, rooms: [], excluded: [], rates: null };
  globalThis.__fengbaoWorkAssignment = task;
  (async () => {
    let view;
    try {
      if (location.origin !== 'https://game.arkengine.me' || !/^\/shelter\/?$/.test(location.pathname)) throw new Error('请在自己的避难所页面使用');
      if (globalThis.__fengbaoDormAssignment?.running) throw new Error('宿舍安排正在执行，请等待完成');
      const response = await fetch('/api/shelter', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (response.redirected || response.status === 401 || response.status === 403) throw new Error('登录状态已失效');
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
      view = await response.json();
      if (view.switches?.frozen) throw new Error('避难所正在维护，暂时不能安排');
      task.message = '正在按最高基础属性安排生产岗位与训练室…';
      const plan = planWorkforce(view);
      task.excluded = plan.excluded;
      task.rates = workforceModel(view).net();
      const protectedIds = new Set(plan.excluded.map(resident => resident.id));
      const originalLocations = new Map(plan.excluded.map(resident => [resident.id, view.state.residents.find(item => item.id === resident.id).roomId]));
      const assignments = new Map(plan.assignments.map(item => [item.residentId, item.roomId]));
      async function move(residentId, roomId) {
        const resident = view.state.residents.find(item => item.id === residentId);
        const currentRoom = view.state.rooms.find(room => room.id === resident?.roomId);
        // 执行时同样允许调走宿舍中仍处于家庭冷却的成人。
        if (!resident || protectedIds.has(residentId) || resident.adultAt > view.serverTime || resident.away !== null || resident.deadAt !== null ||
            currentRoom?.type === 'training' ||
            (currentRoom?.type === 'quarters' && !(resident.familyCooldownUntil > view.serverTime))) throw new Error('居民状态已变化，停止后续调动');
        const target = view.state.rooms.find(room => room.id === roomId);
        if (roomId !== null && (!target || target.builtAt > view.serverTime || target.upgradeAt !== null || target.incident || target.unpowered)) {
          throw new Error('目标房间状态已变化，停止后续调动');
        }
        task.message = `正在安排「${resident.name}」${target ? ` → ${target.floor} 层${workforceModel(view).types[target.type].name}` : ' → 门外休息'}…`;
        const response = await fetch('/api/shelter/action', {
          method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: { type: 'assign', residentId, roomId }, idempotencyKey: crypto.randomUUID() })
        });
        if (response.redirected || response.status === 401 || response.status === 403) throw new Error('登录状态已失效');
        const data = await response.json();
        if (!response.ok || data.code === 'retry') throw new Error(data.error || `调动结果未确认（HTTP ${response.status}）`);
        const updatedModel = workforceModel(data.view);
        view = data.view;
        task.rates = updatedModel.net();
        if (view.state.residents.find(item => item.id === residentId)?.roomId !== roomId) throw new Error('调动结果与目标房间不一致');
        task.moved++;
      }
      const pending = plan.assignments.filter(item => view.state.residents.find(resident => resident.id === item.residentId).roomId !== item.roomId);
      // 有空位直接调入；只有满房间互换形成循环时，才先移出一人腾位。
      while (pending.length) {
        let index = pending.findIndex(item => item.roomId === null || view.state.residents.filter(resident =>
          resident.roomId === item.roomId && resident.deadAt === null && resident.adultAt <= view.serverTime).length <
          view.state.rooms.find(room => room.id === item.roomId).width * 2);
        if (index < 0) {
          const item = pending.find(item => view.state.residents.find(resident => resident.id === item.residentId).roomId !== null);
          if (!item) throw new Error('目标房间已满，无法继续安排');
          await move(item.residentId, null);
        } else {
          const [item] = pending.splice(index, 1);
          await move(item.residentId, item.roomId);
        }
      }
      // 最终读取服务器状态，同时核实岗位、保护名单和资源栏的真实净产出。
      const finalResponse = await fetch('/api/shelter', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!finalResponse.ok || finalResponse.redirected) throw new Error('安排已执行，最终状态读取失败，请查看游戏页面');
      view = await finalResponse.json();
      const finalModel = workforceModel(view);
      task.rates = finalModel.net();
      for (const [id, roomId] of [...assignments, ...originalLocations]) {
        if (view.state.residents.find(resident => resident.id === id)?.roomId !== roomId) throw new Error('最终居民位置已变化，请查看游戏页面');
      }
      for (const roomId of new Set(assignments.values())) {
        if (roomId !== null && !finalModel.rooms.some(room => room.id === roomId)) {
          throw new Error('目标房间已进入升级、施工或停产状态，请重新安排');
        }
      }
      for (const room of finalModel.rooms) {
        const residents = view.state.residents.filter(resident => assignments.get(resident.id) === room.id);
        if (residents.length) task.rooms.push(`${room.floor} 层 ${room.level} 级${finalModel.types[room.type].name} ×${room.width}（${residents.length}/${room.width * 2}）：${residents.map(resident => resident.name).join('、')}`);
      }
      const deficits = [['power', '电力'], ['food', '食物'], ['water', '净水'], ['scrap', '废料']]
        .filter(([key]) => task.rates[key] < 0).map(([, label]) => label);
      task.message = `已安排生产 ${plan.production} 人、训练 ${plan.training} 人。${plan.resting ? `无合适空位，${plan.resting} 人已移到门外，请手动安排。` : ''}\n${deficits.length ? `资源亏损：${deficits.join('、')}，请手动调整岗位；不会自动改派。` : '电力、食物、净水及废料预计收支无亏损。'}\n已保护 ${plan.excluded.length} 人；游戏画面未更新时，请刷新查看。`;
    } catch (error) {
      task.message = `安排已停止：${error.message}\n已确认调动 ${task.moved} 人次，已执行的调动保留，请检查游戏页面。`;
    } finally {
      task.running = false;
    }
  })();
})();
