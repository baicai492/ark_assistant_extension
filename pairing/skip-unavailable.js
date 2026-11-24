// 只处理 checkPair 明确标记的“当前无法调动配对”，其余错误沿原调用链抛出。
globalThis.__fengbaoDormPairSkip = function createDormPairSkip(checkPair, getResidents) {
  const skipped = [];

  function check(pair) {
    try {
      return checkPair(pair.ids);
    } catch (error) {
      if (error.skipDormPair !== true) throw error;
      const residents = getResidents();
      const names = pair.ids.map(id => residents.find(resident => resident.id === id)?.name ?? String(id));
      skipped.push(`${names.join(' ＋ ')}：${error.message}`);
      return null;
    }
  }

  return {
    unavailable(message) {
      return Object.assign(new Error(message), { skipDormPair: true });
    },
    filter(plan) {
      return plan.filter(pair => check(pair) !== null);
    },
    async run(plan, assignPair) {
      for (const pair of plan) {
        const members = check(pair);
        if (members === null) continue;
        await assignPair(pair, members);
      }
    },
    summary() {
      return skipped.length ? `\n已跳过 ${skipped.length} 对：\n${skipped.join('\n')}` : '';
    }
  };
};
