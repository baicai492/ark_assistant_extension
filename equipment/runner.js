function startShelterEquipment(options) {
  if (globalThis.__fengbaoEquipmentAssignment?.running) return;
  const task = { running: true, stopRequested: false, message: '正在读取装备和居民…', completed: [], excluded: [], total: 0 };
  globalThis.__fengbaoEquipmentAssignment = task;
  (async () => {
    let view;
    try {
      if (location.origin !== 'https://game.arkengine.me' || !/^\/shelter\/?$/.test(location.pathname)) throw new Error('请在自己的避难所页面使用');
      if (globalThis.__fengbaoShelterAuto?.running || globalThis.__fengbaoWorkAssignment?.running ||
          globalThis.__fengbaoDormAssignment?.running || globalThis.__fengbaoResidentRename?.running) {
        throw new Error('其他避难所任务正在运行，请等待完成或先关闭托管');
      }
      async function request(action) {
        const response = await fetch(action ? '/api/shelter/action' : '/api/shelter', {
          method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
          ...(action ? { headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, idempotencyKey: crypto.randomUUID() }) } : {})
        });
        if (response.redirected || response.status === 401 || response.status === 403) throw new Error('登录状态已失效');
        const data = await response.json();
        if (!response.ok || data.code === 'retry') throw new Error(data.error || `操作结果未确认（HTTP ${response.status}）`);
        const updated = action ? data.view : data;
        shelterEquipmentModel(updated);
        return updated;
      }
      view = await request();
      const plan = planShelterEquipment(view, options);
      task.total = plan.changes.length;
      task.excluded = plan.excluded;
      const context = shelterEquipmentContext(view);
      const expected = new Map(view.state.residents.map(resident => [resident.id, { weaponId: resident.weaponId, outfitId: resident.outfitId }]));
      function verify(updated) {
        if (shelterEquipmentContext(updated) !== context) throw new Error('居民岗位、状态或装备池已变化，请重新分配');
        for (const resident of updated.state.residents) {
          const target = expected.get(resident.id);
          if (resident.weaponId !== target.weaponId || resident.outfitId !== target.outfitId) throw new Error('装备归属与预期不符');
        }
      }
      const changes = plan.changes.filter(change => change.itemId !== null).concat(plan.changes.filter(change => change.itemId === null));
      for (const change of changes) {
        if (task.stopRequested) break;
        // 每次提交前刷新并核对，防止旧面板计划覆盖玩家刚做的手动穿戴。
        view = await request();
        verify(view);
        if (task.stopRequested) break;
        const model = shelterEquipmentModel(view);
        const resident = model.residents.get(change.residentId);
        const field = model.fields[change.slot];
        if (resident[field] === change.itemId) continue;
        const item = model.items.get(change.itemId);
        const previous = model.items.get(resident[field]);
        const label = change.slot === 'weapon' ? '武器' : '服装';
        task.message = `正在分配${label}：${resident.name} → ${item?.name ?? '不装备'}…\n已确认 ${task.completed.length} 次穿戴操作。`;
        const updated = await request({ type: 'equip', residentId: resident.id, itemId: change.itemId, slot: change.slot });
        // 游戏原生穿戴会直接转移其他在家居民的装备，无需先批量卸下。
        if (change.itemId !== null) {
          const owner = model.owners.get(change.itemId);
          if (owner !== undefined) expected.get(owner)[field] = null;
        }
        expected.get(resident.id)[field] = change.itemId;
        verify(updated);
        view = updated;
        task.completed.push(`${resident.name} · ${label}：${previous?.name ?? '未装备'} → ${item?.name ?? '未装备'}`);
      }
      if (task.stopRequested) {
        task.message = `已停止分配，已确认 ${task.completed.length} 次穿戴操作，已完成的穿戴保留。`;
      } else {
        view = await request();
        verify(view);
        for (const target of plan.targets) {
          const resident = view.state.residents.find(item => item.id === target.residentId);
          if (resident.weaponId !== target.weaponId || resident.outfitId !== target.outfitId) throw new Error('最终穿戴结果与分配方案不一致');
        }
        task.message = plan.changes.length ? `装备分配完成，覆盖 ${plan.residents} 名在家成人，已确认 ${task.completed.length} 次穿戴操作。` :
          plan.residents ? '当前装备已符合分配方案，无需调整。' : '没有可分配装备的在家成人。';
        task.message += `\n已跳过 ${plan.excluded.length} 人。游戏画面未更新时，请刷新查看。`;
      }
    } catch (error) {
      task.message = `装备分配已停止：${error.message}\n已确认 ${task.completed.length} 次穿戴操作；已执行的操作保留，结果未确认的请求不会自动重试。请检查游戏页面。`;
    } finally {
      task.running = false;
    }
  })();
}
