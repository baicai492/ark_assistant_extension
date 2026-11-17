function startShelterAuto(intervalSeconds, recallEvents, dismissEnabled, dismissTotal, dismissStatEnabled, dismissStatKey, dismissStat, rescueCount, rescueEnabled, rescueMode, godEnabled) {
  const previous = globalThis.__fengbaoShelterAuto;
  if (previous?.running) return;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || !Number.isInteger(recallEvents) || recallEvents < 1) throw new Error('间隔和事件次数必须为正整数');
  if (rescueEnabled && !['auto', 'workers'].includes(rescueMode)) throw new Error('请选择事件救援方式');
  if (rescueEnabled && rescueMode === 'auto' && (!Number.isInteger(rescueCount) || rescueCount < 1)) throw new Error('救援次数必须为正整数');
  if (dismissEnabled && (!Number.isInteger(dismissTotal) || dismissTotal < 1 || dismissTotal > 70)) throw new Error('遣散阈值必须为 1–70 的整数');
  const statLabels = { str: '力量', per: '感知', end: '耐力', cha: '魅力', int: '智力', agi: '敏捷', lck: '幸运' };
  if (dismissStatEnabled && !Object.hasOwn(statLabels, dismissStatKey)) throw new Error('请选择单项遣散的指定属性');
  if (dismissStatEnabled && (!Number.isInteger(dismissStat) || dismissStat < 1 || dismissStat > 10)) throw new Error('单项属性遣散阈值必须为 1–10 的整数');
  const task = { running: true, stopRequested: false, intervalSeconds, rescueEnabled, rescueMode, rescueCount, recallEvents, dismissEnabled, dismissTotal, dismissStatEnabled, dismissStatKey, dismissStat, godEnabled, logs: previous?.logs ?? [], message: '正在开启托管…', nextAt: null, pendingDispatch: previous?.pendingDispatch ?? {}, newcomers: previous?.newcomers ?? [], knownIds: previous?.knownIds ?? null, deployments: previous?.deployments ?? {} };
  task.incidentSnapshot = previous?.incidentSnapshot ?? null;
  globalThis.__fengbaoShelterAuto = task;
  const log = message => { task.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`); if (task.logs.length > 2000) task.logs.shift(); task.message = message; };
  const stopped = () => task.stopRequested;
  const wait = ms => new Promise(resolve => { task.wake = resolve; task.timer = setTimeout(resolve, ms); });
  let view;
  async function read() {
    const response = await fetch('/api/shelter', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok || response.redirected) throw new Error('读取失败或登录已失效');
    view = await response.json();
    if (!Array.isArray(view.state?.residents) || !Array.isArray(view.state.rooms) || !Array.isArray(view.state.explorers)) throw new Error('避难所数据格式已变化');
    if (view.switches?.frozen) throw new Error('避难所正在维护');
  }
  async function act(action) {
    if (stopped()) return false;
    const response = await fetch('/api/shelter/action', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, idempotencyKey: crypto.randomUUID() }) });
    if (response.redirected || response.status === 401 || response.status === 403) throw new Error('登录已失效');
    const data = await response.json();
    // 未攒满产出是正常等待状态，只跳过本次收取，不中断托管。
    if (action.type === 'collect_all' && response.status < 500 && data.code !== 'retry' &&
        /(?:没有|暂无|尚无).{0,12}可收取|(?:还没|尚未|未|没有).{0,6}攒满/.test(data.error || '')) {
      log(`全部收取已跳过：${data.error}`);
      await read();
      return false;
    }
    if (!response.ok || data.code === 'retry') throw new Error(data.error || '操作结果未确认');
    view = data.view;
    return true;
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
  (async () => {
    try {
      if (location.origin !== 'https://game.arkengine.me' || !/^\/shelter\/?$/.test(location.pathname)) throw new Error('请在自己的避难所页面开启');
      if (globalThis.__fengbaoWorkAssignment?.running || globalThis.__fengbaoDormAssignment?.running || globalThis.__fengbaoResidentRename?.running) throw new Error('其他居民任务正在运行，请等待完成');
      await read();
      // 首次开启纳入门外无父母的成人；之后以新增 ID 识别电台新居民，不碰原岗位。
      if (!task.knownIds) {
        task.knownIds = view.state.residents.map(resident => resident.id);
        if (view.state.rooms.some(room => room.type === 'radio')) task.newcomers = view.state.residents.filter(resident => resident.roomId === null && resident.away === null && resident.deadAt === null && resident.adultAt <= view.serverTime && resident.parents.length === 0).map(resident => resident.id);
      }
      // 每次开启重新记录已有名单，停用期间到来的居民也不参与自动遣散。
      task.knownIds = view.state.residents.map(resident => resident.id);
      log(`托管开启：每 ${intervalSeconds} 秒检查，废土 ${recallEvents} 次事件召回。`);
      while (!stopped()) {
        // 与页面右上角刷新、全部收取按钮使用相同接口，不刷新整张网页。
        await read();
        if (stopped()) break;
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
        if (godEnabled) {
          // 救援快照归位完成后再调整训练岗位，避免新安排被快照覆盖。
          if (task.incidentSnapshot || view.state.rooms.some(room => room.incident)) log('造神计划：事件处理中，暂停居民调动。');
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
        if (stopped()) break;
        task.nextAt = Date.now() + intervalSeconds * 1000;
        log(`本轮完成，${intervalSeconds} 秒后开始下一轮。`);
        await wait(intervalSeconds * 1000);
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
