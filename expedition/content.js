(() => {
  if (window.__fengbaoExpedition) return;
  window.__fengbaoExpedition = true;

  const state = { running: false, burst: false, rounds: 0, dueAt: 0, message: '尚未开始' };
  let timer;
  let phase;
  let phaseChecks;
  let nextPhaseCheck;
  let phaseMessage;
  let checks;
  let nextCheck;
  let refreshed = false;
  const resumeKey = 'fengbao-expedition-resume';

  const visible = element => element.getClientRects().length > 0;
  const text = element => element.textContent.replace(/\s+/g, ' ').trim();
  const enabled = element => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const button = pattern => [...document.querySelectorAll('button')].find(element => visible(element) && pattern.test(text(element)));

  function enter(next, message) {
    phase = next;
    phaseChecks = 0;
    nextPhaseCheck = Date.now();
    phaseMessage = message;
    state.message = message;
  }

  function stop(message) {
    clearInterval(timer);
    sessionStorage.removeItem(resumeKey);
    state.running = false;
    state.dueAt = 0;
    state.message = message;
  }

  function tick() {
    if (!/^\/activities\/expedition\/?$/.test(location.pathname)) {
      stop('已停止：已离开远征页面');
      return;
    }
    switch (phase) {
      case 'resume': {
        // 优先识别确认弹窗和已有远征，再判断派出前的设置步骤。
        const mode = button(/^完整行程$/);
        if (mode) {
          enter(mode.getAttribute('aria-selected') === 'true' ? 'confirm' : 'mode', '继续确认完整行程');
          break;
        }
        const section = [...document.querySelectorAll('section')].find(element => visible(element) && element.querySelector('h2')?.textContent.trim() === '进行中的远征');
        if (section && /完整到达：\s*\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/.test(section.textContent)) {
          enter('arrival', '正在读取完整到达时间');
          break;
        }
        if (button(/^一键领取\s*[（(]\s*[1-9]\d*\s*[）)]$/)) {
          checks = 0;
          nextCheck = Date.now();
          refreshed = true;
          enter('wait', '已发现可领取队伍，继续领取');
          break;
        }
        const route = [...document.querySelectorAll('button[aria-pressed]')].find(element => visible(element) && text(element).includes('边境巡逻') && [...element.querySelectorAll('span')].some(span => text(span) === '1h'));
        if (!route) return;
        if (route.getAttribute('aria-pressed') !== 'true') {
          enter('route', '正在选择边境巡逻 · 1h');
          break;
        }
        const label = [...document.querySelectorAll('label')].find(element => visible(element) && text(element) === '允许使用今日突发额度');
        if (label?.querySelector('input[type="checkbox"]')?.checked !== state.burst) {
          enter('burst', '正在设置突发额度');
        } else {
          checks = 0;
          nextCheck = Date.now();
          enter('dispatch', '等待派出队伍');
        }
        break;
      }
      case 'route': {
        const route = [...document.querySelectorAll('button[aria-pressed]')].find(element => visible(element) && text(element).includes('边境巡逻') && [...element.querySelectorAll('span')].some(span => text(span) === '1h'));
        if (!route || !enabled(route)) return;
        if (route.getAttribute('aria-pressed') !== 'true') {
          route.click();
          enter('routeSelected', '等待选中边境巡逻 · 1h');
        } else enter('burst', '正在设置突发额度');
        break;
      }
      case 'routeSelected': {
        const route = [...document.querySelectorAll('button[aria-pressed="true"]')].find(element => visible(element) && text(element).includes('边境巡逻') && [...element.querySelectorAll('span')].some(span => text(span) === '1h'));
        if (route) enter('burst', '正在设置突发额度');
        break;
      }
      case 'burst': {
        const label = [...document.querySelectorAll('label')].find(element => visible(element) && text(element) === '允许使用今日突发额度');
        const input = label?.querySelector('input[type="checkbox"]');
        if (!input) return;
        if (input.checked !== state.burst) {
          if (!enabled(input)) return;
          input.click();
        }
        enter('dispatch', '等待派出队伍');
        checks = 0;
        nextCheck = Date.now();
        break;
      }
      case 'dispatch': {
        // 首次立即检查，后续每五秒检查一次，成功后只点击一次。
        if (Date.now() < nextCheck) return;
        checks += 1;
        const label = [...document.querySelectorAll('label')].find(element => visible(element) && text(element) === '允许使用今日突发额度');
        const burstReady = label?.querySelector('input[type="checkbox"]')?.checked === state.burst;
        const dispatch = button(/^派出\s*[1-9]\d*\s*支队伍$/);
        if (burstReady && dispatch && enabled(dispatch)) {
          dispatch.click();
          enter('mode', '等待完整行程确认弹窗');
        } else {
          const reason = !burstReady ? '突发额度选项尚未同步' : '未发现可点击的派出队伍按钮';
          if (checks >= 20) stop(`已停止：派出检查连续 20 次失败，${reason}`);
          else {
            nextCheck = Date.now() + 5000;
            state.message = `等待派出（${checks}/20）：${reason}，5 秒后重查`;
          }
        }
        break;
      }
      case 'mode': {
        const mode = button(/^完整行程$/);
        if (!mode || !enabled(mode)) return;
        if (mode.getAttribute('aria-selected') !== 'true') mode.click();
        enter('confirm', '等待确认完整行程');
        break;
      }
      case 'confirm': {
        const mode = button(/^完整行程$/);
        if (mode?.getAttribute('aria-selected') !== 'true') return;
        const confirm = button(/^确认完整行程\s*·\s*[1-9]\d*\s*队$/);
        if (!confirm || !enabled(confirm)) return;
        confirm.click();
        enter('accepted', '等待派出确认弹窗关闭');
        break;
      }
      case 'accepted':
        if (!button(/^确认完整行程\s*·\s*\d+\s*队$/)) {
          enter('arrival', '正在读取完整到达时间');
        }
        break;
      case 'arrival': {
        const section = [...document.querySelectorAll('section')].find(element => visible(element) && element.querySelector('h2')?.textContent.trim() === '进行中的远征');
        if (!section) return;
        const matches = [...section.textContent.matchAll(/完整到达：\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/g)];
        if (!matches.length) return;
        // 页面日期按浏览器本地时间解析，取全部队伍最晚到达时间再加一分钟。
        const arrivals = matches.map(match => {
          const [, year, month, day, hour, minute, second] = match.map(Number);
          return new Date(year, month - 1, day, hour, minute, second).getTime();
        });
        state.dueAt = Math.max(...arrivals) + 60000;
          checks = 0;
          nextCheck = state.dueAt;
        refreshed = false;
        enter('wait', `等待领取：${new Date(state.dueAt).toLocaleString('zh-CN', { hour12: false })}`);
        break;
      }
      case 'ready': {
        // 等待远征业务数据出现，页面外壳加载完成不代表领取界面已就绪。
        const section = [...document.querySelectorAll('section')].find(element => visible(element) && element.querySelector('h2')?.textContent.trim() === '进行中的远征');
        if (!section || (!/完整到达：\s*\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/.test(section.textContent) && !button(/^一键领取\s*[（(]\s*[1-9]\d*\s*[）)]$/))) return;
        checks = 0;
        nextCheck = Date.now();
        enter('wait', '远征页面已就绪，等待领取');
        break;
      }
      case 'wait': {
        if (Date.now() < nextCheck) return;
        // 每轮到点只刷新一次，保存领取阶段所需状态供刷新后继续。
        if (!refreshed) {
          sessionStorage.setItem(resumeKey, JSON.stringify({ burst: state.burst, rounds: state.rounds, dueAt: state.dueAt }));
          clearInterval(timer);
          state.message = '已到领取时间，正在刷新页面';
          location.reload();
          return;
        }
        // 业务页面就绪后才开始领取计数，不补执行后台暂停期间错过的检查。
        checks += 1;
        const claim = button(/^一键领取\s*[（(]\s*[1-9]\d*\s*[）)]$/);
        if (claim && enabled(claim)) {
          claim.click();
          state.dueAt = 0;
          enter('claimed', '等待领取完成');
        } else {
          const reason = claim ? '一键领取按钮不可点击' : '未发现有可领取队伍的一键领取按钮';
          if (checks >= 20) stop(`已停止：领取检查连续 20 次失败，${reason}`);
          else {
            nextCheck = Date.now() + 5000;
            state.message = `等待领取（${checks}/20）：${reason}，5 秒后重查`;
          }
        }
        break;
      }
      case 'claimed':
        if (!button(/^一键领取\s*[（(]\s*[1-9]\d*\s*[）)]$/)) {
          state.rounds += 1;
          enter('route', '领取完成，开始下一轮：选择 1h 路线');
        }
        break;
    }
  }

  function startTimer() {
      timer = setInterval(() => {
        try {
          // 各操作阶段首次立即检查，失败后每五秒重查；后台延迟不补计次数。
          const checkedPhase = phase;
          const checkOperation = phase !== 'wait' && phase !== 'dispatch';
          if (checkOperation && Date.now() < nextPhaseCheck) return;
          tick();
          if (state.running && checkOperation && phase === checkedPhase) {
            // 锁屏后页面可能延迟加载，就绪阶段持续等待，不消耗操作重试次数。
            if (phase === 'ready') {
              nextPhaseCheck = Date.now() + 5000;
              state.message = '等待远征页面就绪，5 秒后重查（可手动停止）';
              return;
            }
            phaseChecks += 1;
            if (phaseChecks >= 20) stop(`已停止：${phaseMessage}，连续 20 次检查未满足条件`);
            else {
              nextPhaseCheck = Date.now() + 5000;
              state.message = `${phaseMessage}（${phaseChecks}/20），5 秒后重查`;
            }
          }
        } catch (error) { stop(`已停止：${error.message}`); }
      }, 500);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'fengbao-expedition') return;
    if (message.action === 'start' && !state.running) {
      state.running = true;
      state.burst = message.burst;
      state.rounds = 0;
      // 每次手动开始都根据当前页面识别阶段，从对应步骤继续。
      enter('resume', '正在识别当前远征步骤');
      startTimer();
    } else if (message.action === 'stop') stop('已手动停止');
    respond({ ...state });
  });
  // 恢复记录只消费一次，避免刷新后再次刷新；保留轮数和突发额度选项。
  const resume = sessionStorage.getItem(resumeKey);
  if (resume && /^\/activities\/expedition\/?$/.test(location.pathname)) {
    sessionStorage.removeItem(resumeKey);
    Object.assign(state, JSON.parse(resume), { running: true });
    refreshed = true;
    checks = 0;
    nextCheck = Date.now();
    enter('ready', '页面已刷新，等待远征页面就绪（远征业务数据尚未出现）');
    startTimer();
  }
})();

