function residentDistribution(residents, scope = 'living') {
  if (!Array.isArray(residents) || !['living', 'adults', 'idle'].includes(scope)) throw new Error('居民统计范围无效');
  for (const resident of residents) {
    if (!Array.isArray(resident.stats) || resident.stats.length !== 7 ||
        !resident.stats.every(value => Number.isInteger(value) && value >= 0 && value <= 10) ||
        !['isAdult', 'isAway', 'isDown', 'isIdle'].every(key => typeof resident[key] === 'boolean')) {
      throw new Error(`居民「${resident.name ?? resident.id}」的基础属性或状态不完整，无法统计`);
    }
  }
  const living = residents.filter(resident => !resident.isDown);
  const selected = living.filter(resident => scope === 'living' || scope === 'adults' && resident.isAdult || scope === 'idle' && resident.isIdle);
  // 统一从七项基础属性重新求和，不读取服装加成或战力。
  const scored = selected.map(resident => ({ ...resident, total: resident.stats.reduce((sum, value) => sum + value, 0) }));
  const describe = values => {
    const sorted = [...values].sort((left, right) => left - right);
    const count = sorted.length, middle = Math.floor(count / 2);
    return {
      mean: count ? sorted.reduce((sum, value) => sum + value, 0) / count : null,
      median: count ? count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
      min: count ? sorted[0] : null, max: count ? sorted[count - 1] : null
    };
  };
  const bucket = (label, min, max, values) => {
    const count = values.filter(value => value >= min && value <= max).length;
    return { label, min, max, count, percent: selected.length ? count / selected.length * 100 : 0 };
  };
  const totals = scored.map(resident => resident.total);
  const ranges = [[0, 39], [40, 49], [50, 59], [60, 64], [65, 69], [70, 70]];
  return {
    count: scored.length,
    census: { living: living.length, adults: living.filter(resident => resident.isAdult).length,
      children: living.filter(resident => !resident.isAdult).length, away: living.filter(resident => resident.isAway).length,
      idle: living.filter(resident => resident.isIdle).length, down: residents.length - living.length },
    total: { ...describe(totals),
      groups: ranges.map(([min, max]) => bucket(min === max ? String(min) : `${min}–${max}`, min, max, totals)),
      exact: Array.from({ length: 71 }, (_, value) => bucket(String(value), value, value, totals)).filter(row => row.count) },
    stats: ['力量', '感知', '耐力', '魅力', '智力', '敏捷', '幸运'].map((name, index) => {
      const values = scored.map(resident => resident.stats[index]);
      return { name, ...describe(values), maxed: values.filter(value => value === 10).length,
        buckets: Array.from({ length: 11 }, (_, value) => bucket(String(value), value, value, values)) };
    }),
    low: scored.filter(resident => resident.total < 60).sort((left, right) => left.total - right.total || left.id - right.id)
  };
}
