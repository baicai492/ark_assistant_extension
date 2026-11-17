(() => {
  if (globalThis.__fengbaoOverload) return;
  globalThis.__fengbaoOverload = true;

  const key = 'fengbao-overload-v1';
  const names = ['石墙卫', '光环辅助', '雷电法师'];
  // 用户确认的九步顺序；坐标相对于 960 × 576 画布。
  const placements = [
    { hero: 2, x: 264, y: 408 },
    { hero: 2, x: 360, y: 408 },
    { hero: 0, x: 168, y: 168 },
    { hero: 2, x: 792, y: 360 },
    { hero: 2, x: 744, y: 408 },
    { hero: 2, x: 840, y: 408 },
    { hero: 2, x: 360, y: 360 },
    { hero: 1, x: 312, y: 408 },
    { hero: 1, x: 792, y: 408 }
  ];
  // 同一标签页内跨页面保留循环状态，关闭弹窗不会停止任务。
  const saved = sessionStorage.getItem(key);
  const state = saved ? JSON.parse(saved) : {
    running: false, rounds: 0, step: 0, phase: 'idle', deadline: 0,
    message: '就绪：请从关卡选择页开始。'
  };
  let timer;
  let delayedStep;
  let nextTickDelay;

  function save() {
    sessionStorage.setItem(key, JSON.stringify(state));
  }

  function transition(phase, message) {
    state.phase = phase;
    state.message = message;
    state.deadline = Date.now() + 30000;
    save();
  }

  function stop(message) {
    clearTimeout(timer);
    state.running = false;
    state.message = message;
    save();
    chrome.runtime.sendMessage({ type: 'fengbao-overload-keep-awake', running: false })
      .then(result => { if (result.error) console.error(result.error); }, error => console.error('释放速刷关卡保活失败：', error));
  }

  function visible(element) {
    return element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  function findButton(label) {
    return [...document.querySelectorAll('button')].find(element =>
      visible(element) && element.textContent.trim() === label);
  }

  function shortcuts() {
    return [...document.querySelectorAll('[aria-label="常用英雄快捷栏"] button')];
  }

  function checkOrder(buttons) {
    if (names.some((name, index) => buttons[index]?.textContent.split('·')[0].trim() !== name)) {
      stop('常用栏顺序不符合要求：请调整为 石墙卫 → 光环辅助 → 雷电法师。');
      return false;
    }
    return true;
  }

  function tick() {
    const levels = /^\/levels\/?$/.test(location.pathname);
    const play = /^\/play\/35\/?$/.test(location.pathname);
    if (!levels && !play) {
      stop('已离开关卡选择页或核心过载，循环停止。');
      return;
    }

    const result = [...document.querySelectorAll('h2')].find(element =>
      visible(element) && /^(胜利|失败|挑战失败|战败)[！!。]?$/.test(element.textContent.trim()));
    if (result && !result.textContent.startsWith('胜利')) {
      stop('挑战失败，循环已停止。');
      return;
    }
    const life = [...document.querySelectorAll('.pixel-panel > span.text-destructive')].find(element =>
      visible(element) && /^生命\s*\d+\s*$/.test(element.textContent.trim()));
    if (life && Number(life.textContent.match(/\d+/)[0]) === 0) {
      stop('生命归零，挑战失败，循环已停止。');
      return;
    }
    if (result && state.phase !== 'return') {
      const back = [...document.querySelectorAll('a[href="/levels"]')].find(element =>
        visible(element) && element.textContent.trim() === '返回关卡');
      if (back) {
        transition('return', '胜利，等待返回关卡选择页');
        back.click();
      }
      return;
    }

    // 金币积累及自然出兵不设 30 秒超时；页面跳转和按钮响应有明确等待上限。
    if (!['deploy', 'battle'].includes(state.phase) && Date.now() > state.deadline) {
      stop(`等待超过 30 秒：${state.message}。请检查页面。`);
      return;
    }

    if (state.phase === 'return') {
      if (levels && document.querySelector('[data-level-view]')) {
        state.rounds++;
        state.step = 0;
        transition('levels', '本轮完成，准备检查体力');
      }
      return;
    }

    if (state.phase === 'levels') {
      if (!levels) return;
      const staminaLine = [...document.querySelectorAll('p')].find(element =>
        visible(element) && element.textContent.includes('今日扫荡剩余') && element.textContent.includes('体力'));
      const stamina = staminaLine?.textContent.match(/体力\s*(\d+)\s*\/\s*\d+/);
      if (!stamina) return;
      if (Number(stamina[1]) < 6) {
        stop(`体力不足：当前 ${stamina[1]} 点，每次挑战需要 6 点。`);
        return;
      }
      const entry = document.querySelector('[data-level-view] a[href="/play/35"]');
      if (visible(entry)) {
        transition('prepare', '体力充足，等待核心过载战前准备');
        entry.click();
      }
      return;
    }

    if (state.phase === 'prepare') {
      if (!play) return;
      const start = findButton('准备完成，开始挑战');
      if (start && !start.disabled) {
        state.step = 0;
        // 每轮随机挑选一步，仅在该步安放前额外等待 100–500 毫秒。
        delayedStep = Math.floor(Math.random() * placements.length);
        transition('check', '已开始挑战，等待检查常用栏');
        start.click();
      }
      return;
    }

    if (state.phase === 'check') {
      const buttons = shortcuts();
      if (!buttons.length) return;
      if (checkOrder(buttons)) transition('speed', '常用栏检查通过，设置 5 倍速');
      return;
    }

    if (state.phase === 'speed') {
      const speed = [...document.querySelectorAll('button')].find(element =>
        visible(element) && /^\d+(?:\.\d+)?x$/.test(element.textContent.trim()));
      if (!speed || speed.disabled) return;
      if (speed.textContent.trim() !== '5x') {
        speed.click();
        return;
      }
      const resume = findButton('继续');
      if (resume && !resume.disabled) resume.click();
      transition('deploy', '5 倍速，准备按顺序布置');
      return;
    }

    if (state.phase === 'deploy') {
      if (state.step === placements.length) {
        transition('battle', '9 步布置完成，等待自然出兵和战斗结算');
        return;
      }
      const buttons = shortcuts();
      if (!checkOrder(buttons)) return;
      const next = placements[state.step];
      const target = buttons[next.hero];
      const message = `第 ${state.step + 1}/9 步：等待${names[next.hero]}可用`;
      if (state.message !== message) {
        state.message = message;
        save();
      }
      if (target.disabled) return;
      target.click();
      // 下一次轮询再点击画布，等待页面完成角色选择的更新。
      transition('place', `第 ${state.step + 1}/9 步：放置${names[next.hero]}`);
      if (state.step === delayedStep) nextTickDelay += 100 + Math.floor(Math.random() * 401);
      return;
    }

    if (state.phase === 'place') {
      const canvas = document.querySelector('canvas[width="960"][height="576"]');
      if (!visible(canvas)) return;
      const next = placements[state.step];
      const rect = canvas.getBoundingClientRect();
      // 使用画布显示尺寸换算位置，不依赖浏览器窗口或滚动位置。
      canvas.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.left + next.x / 960 * rect.width,
        clientY: rect.top + next.y / 576 * rect.height,
        button: 0
      }));
      state.step++;
      transition('deploy', `已执行 ${state.step}/9 步布置`);
    }
  }

  function run() {
    chrome.runtime.sendMessage({ type: 'fengbao-overload-keep-awake', running: true, autoFocus: state.autoFocus === true })
      .then(result => { if (result.error) stop(`保活启动失败：${result.error}`); }, error => stop(`保活启动失败：${error.message}`));
    timer = setTimeout(function poll() {
      nextTickDelay = 250;
      try { tick(); } catch (error) { stop(`执行失败：${error.message}`); }
      if (state.running) timer = setTimeout(poll, nextTickDelay);
    }, 250);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'fengbao-overload') return;
    if (message.action === 'start' && !state.running) {
      if (!/^\/levels\/?$/.test(location.pathname)) {
        stop('请在 “作战” 页面打开此扩展');
      } else {
        state.running = true;
        state.autoFocus = message.autoFocus === true;
        state.rounds = 0;
        state.step = 0;
        transition('levels', '正在检查体力与核心过载入口');
        run();
      }
    } else if (message.action === 'stop') {
      stop('已手动停止扩展；游戏战斗不会自动暂停。');
    }
    respond({ ...state });
  });

  if (state.running) {
    // 战斗页面刷新后无法确认已放置角色，停止以免重复布置。
    if (['check', 'speed', 'deploy', 'place', 'battle'].includes(state.phase)) {
      stop('战斗页面已重新加载，循环停止。请手动处理本局后返回关卡页重启。');
    } else {
      run();
    }
  }
})();
