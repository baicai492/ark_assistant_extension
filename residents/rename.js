(() => {
  if (globalThis.__fengbaoShelterAuto?.running) return;
  if (globalThis.__fengbaoResidentRename?.running) return;
  // 任务保存在游戏页面中，切换页签或关闭面板后继续当前批次。
  const task = { running: true, message: '正在读取全部居民…', completed: [], renamed: 0 };
  globalThis.__fengbaoResidentRename = task;

  (async () => {
    try {
      if (location.origin !== 'https://game.arkengine.me' || !/^\/shelter\/?$/.test(location.pathname)) {
        throw new Error('请在自己的避难所页面使用');
      }
      const response = await fetch('/api/shelter', {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000)
      });
      if (response.redirected || response.status === 401 || response.status === 403) throw new Error('登录状态已失效');
      if (!response.ok) throw new Error(`读取居民失败（HTTP ${response.status}）`);
      const view = await response.json();
      if (!Array.isArray(view.state?.residents)) throw new Error('游戏返回的居民数据格式已变化');
      const attributes = [['str', '力'], ['per', '感'], ['end', '耐'], ['cha', '魅'], ['int', '智'], ['agi', '敏'], ['lck', '幸']];
      const residents = view.state.residents.map(resident => {
        if (!Number.isFinite(resident.id) || typeof resident.name !== 'string' || !Number.isFinite(resident.xp) ||
            !Array.isArray(resident.parents) || !resident.parents.every(Number.isFinite) ||
            !attributes.every(([key]) => Number.isFinite(resident.stats?.[key]))) {
          throw new Error(`居民「${resident.name ?? resident.id}」的等级或属性数据不完整`);
        }
        return { ...resident, level: Math.min(50, 1 + Math.floor(Math.sqrt(Math.max(0, resident.xp) / 3))) };
      }).sort((left, right) => right.level - left.level || left.id - right.id);

      // 所有居民（含儿童）参与；只排除同一对中的亲子、兄弟姐妹关系。
      const candidates = residents.map(resident => ({ ...resident,
        total: attributes.reduce((sum, [key]) => sum + resident.stats[key], 0)
      })).sort((left, right) => right.total - left.total || left.id - right.id);
      const pairs = [];
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const left = candidates[i], right = candidates[j];
          if (left.parents.includes(right.id) || right.parents.includes(left.id) ||
              left.parents.some(id => right.parents.includes(id))) continue;
          pairs.push({ members: [left, right], total: left.total + right.total });
        }
      }
      pairs.sort((left, right) => right.total - left.total || left.members[0].id - right.members[0].id || left.members[1].id - right.members[1].id);
      let parents = [], bestTotal = -1;
      // 选两对不重复用人的最高总分组合，AB 和 CD 分别成对，跨对允许有亲属关系。
      for (let i = 0; i < pairs.length - 1; i++) {
        if (pairs[i].total + pairs[i + 1].total <= bestTotal) break;
        for (let j = i + 1; j < pairs.length; j++) {
          const total = pairs[i].total + pairs[j].total;
          if (total <= bestTotal) break;
          if (pairs[i].members.some(left => pairs[j].members.some(right => left.id === right.id))) continue;
          parents = [...pairs[i].members, ...pairs[j].members];
          bestTotal = total;
          break;
        }
      }
      const parentMarks = new Map(parents.map((resident, index) => [resident.id, 'ABCD'[index]]));

      // 保留旧版纯编号、带父母编号及新版属性名称中的编号，新居民从最大编号后接续。
      const numbers = new Map(residents.map(resident => {
        const match = resident.name.match(/^(\d+)(?:\([\d,]+\))?([A-Z]*)$/) || resident.name.match(/^[^-]+-(\d+)([A-Z]*)$/);
        return [resident.id, match ? match[1] : null];
      }));
      let nextNumber = Math.max(0, ...[...numbers.values()].map(Number)) + 1;
      const plan = residents.map(resident => {
        // 带星标的居民完整保留原名，不修改编号或亲本标记。
        if (resident.name.includes('★')) return { id: resident.id, oldName: resident.name, name: resident.name, level: resident.level };
        // 并列最高的基础属性全部保留，按力、感、耐、魅、智、敏、幸顺序拼接。
        const highest = Math.max(...attributes.map(([key]) => resident.stats[key]));
        // 至少五项基础属性为 10 时，统一使用“神”作为名称前缀；否则并列最高属性全部保留。
        const label = attributes.filter(([key]) => resident.stats[key] === 10).length >= 5
          ? '神'
          : attributes.filter(([key]) => resident.stats[key] === highest).map(([, label]) => label).join('');
        const number = numbers.get(resident.id) ?? String(nextNumber++);
        // A–D 每次重新分配，其他大写后缀保留，新亲本标记放在名字末尾。
        const suffix = (resident.name.match(/\d(?:\([\d,]+\))?([A-Z]+)$/)?.[1] ?? '').replace(/[ABCD]/g, '');
        const name = `${label}-${String(Number(number)).padStart(3, '0')}${suffix}${parentMarks.get(resident.id) ?? ''}`;
        if (name.length > 12) throw new Error(`新名字「${name}」超过游戏的 12 字限制`);
        return { id: resident.id, oldName: resident.name, name, level: resident.level };
      });

      for (const resident of plan) {
        if (resident.oldName !== resident.name) {
          task.message = `正在将「${resident.oldName}」改为「${resident.name}」…\n已处理 ${task.completed.length}/${plan.length} 人。`;
          const renameResponse = await fetch('/api/shelter/action', {
            method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: { type: 'rename_resident', residentId: resident.id, name: resident.name },
              idempotencyKey: crypto.randomUUID()
            })
          });
          if (renameResponse.redirected || renameResponse.status === 401 || renameResponse.status === 403) throw new Error('登录状态已失效');
          const data = await renameResponse.json();
          if (!renameResponse.ok || data.code === 'retry') throw new Error(data.error || `改名结果未确认（HTTP ${renameResponse.status}）`);
          if (data.view?.state?.residents?.find(item => item.id === resident.id)?.name !== resident.name) {
            throw new Error(`「${resident.oldName}」的改名结果未确认，请检查游戏页面`);
          }
          task.renamed++;
        }
        task.completed.push(resident);
      }
      task.message = plan.length ? `已完成 ${plan.length} 名居民的编号，本次改名 ${task.renamed} 人。\n游戏画面如未更新，请刷新查看。` : '当前没有居民，无需改名。';
      if (plan.length) task.message += parents.length ? `\n生育亲本（A＋B、C＋D）：\n${parents.map(resident => `${parentMarks.get(resident.id)}：${plan.find(item => item.id === resident.id).name}（属性总和 ${resident.total}）`).join('\n')}` : '\n未找到两对不重复用人且各对内无亲子或兄弟姐妹关系的居民，未标记生育亲本。';
    } catch (error) {
      // 请求失败或结果未确认时停止，保留已确认的结果，不自动重试。
      task.message = `改名已停止：${error.message}\n已确认改名 ${task.renamed} 人，已执行的改名保留。`;
    } finally {
      task.running = false;
    }
  })();
})();
