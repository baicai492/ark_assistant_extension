(() => {
  if (globalThis.__fengbaoFog) return;
  globalThis.__fengbaoFog = true;
  const state = { running: false, rounds: 0, message: '就绪：等待开始。' };
  let phase; let interval = 3600; let reserve = false; let waitUntil = 0; let controller;
  const visible = e => e && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const text = e => e?.textContent.replace(/\s+/g, ' ').trim() || '';
  const button = name => [...document.querySelectorAll('button')].find(e => visible(e) && text(e) === name);
  const ready = e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
  const enter = (next, message) => { phase = next; state.message = message; };
  const energy = () => Number(document.querySelector('p[aria-live="polite"]')?.textContent.match(/当前灵力\s*(\d+)/)?.[1]);
  const enough = () => energy() >= (reserve ? 40 : 20);
  const delay = (seconds, signal) => new Promise((resolve, reject) => { signal.throwIfAborted(); const timer = setTimeout(resolve, seconds * 1000); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  const strategy = () => {
    const route = document.querySelector('select[aria-label="探索路线"]');
    const combat = document.querySelector('select[aria-label="战斗策略"]');
    const hp = document.querySelector('input[aria-label="生命撤离线"]');
    if (route?.value !== 'explore') { route.value = 'explore'; route.dispatchEvent(new Event('change', { bubbles: true })); return false; }
    if (combat?.value !== 'guard-heavy') { combat.value = 'guard-heavy'; combat.dispatchEvent(new Event('change', { bubbles: true })); return false; }
    if (hp?.value !== '15') { hp.value = '15'; hp.dispatchEvent(new Event('input', { bubbles: true })); hp.dispatchEvent(new Event('change', { bubbles: true })); return false; }
    return true;
  };
  async function run(signal) {
    try {
      while (true) {
        signal.throwIfAborted();
        if (!/^\/cultivate\/fog\/?$/.test(location.pathname)) throw new Error('已离开迷雾页面，任务停止。');
        const explore = button('进入并快速探索 · 20 灵力');
        const dialog = [...document.querySelectorAll('[role="alertdialog"]')].find(e => visible(e) && text(e).includes('快速探索'));
        enter('check', '正在检查当前灵力');
        if (!Number.isFinite(energy())) { await delay(5, signal); continue; }
        if (!enough()) {
          waitUntil = Date.now() + interval * 1000; enter('wait', `当前灵力不足 ${reserve ? 40 : 20}`);
          await delay(interval, signal); waitUntil = 0;
          const refresh = button('刷新'); if (ready(refresh)) refresh.click();
          enter('check', '已点击刷新，等待数据更新'); await delay(5, signal); continue;
        }
        if (!ready(explore)) throw new Error('灵力充足，但快速探索按钮不可用，已停止。');
        enter('strategy', '正在确认探索策略');
        while (!strategy()) { await delay(5, signal); }
        enter('enter', '策略已确认，准备进入快速探索');
        await delay(5, signal);
        if (!ready(explore)) { await delay(5, signal); continue; }
        explore.click(); enter('confirm', '等待确认快速探索');
        let confirm;
        for (;;) { confirm = [...document.querySelectorAll('[role="alertdialog"]')].find(e => visible(e) && text(e).includes('快速探索'))?.querySelector('button:not(:first-child)'); if (ready(confirm)) break; await delay(5, signal); }
        confirm.click(); enter('result', '已开始快速探索，等待本轮完成');
        for (;;) { await delay(5, signal); const nextExplore = button('进入并快速探索 · 20 灵力'); if (!document.querySelector('[role="alertdialog"]') && ready(nextExplore) && Number.isFinite(energy())) break; }
        state.rounds++; state.message = '本轮完成，准备下一轮';
      }
    } catch (error) { if (!signal.aborted) state.message = error.message; }
    finally { state.running = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'fengbao-fog') return;
    if (message.action === 'start' && !state.running) { interval = Math.max(1, Number(message.interval) || 3600); reserve = Boolean(message.reserve); state.running = true; controller = new AbortController(); void run(controller.signal); }
    else if (message.action === 'stop' && state.running) { state.message = '正在停止…'; controller?.abort(); }
    respond({ ...state, interval, reserve, waitUntil: state.running && phase === 'wait' ? waitUntil : 0 });
  });
})();

