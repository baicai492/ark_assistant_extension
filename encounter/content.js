(() => {
  // 弹窗每次打开都会注入，已存在的任务只保留一份。
  if (globalThis.__fengbaoEncounter) return;
  globalThis.__fengbaoEncounter = true;

  const state = { running: false, rounds: 0, message: "尚未开始", settings: { waitSec: 5, maxRetries: 20, cycleSec: 360 } };
  let controller;
  const onTargetPage = () => location.origin === "https://game.arkengine.me" && /^\/cultivate\/?$/.test(location.pathname);

  function available(button) {
    return button && !button.matches(":disabled") && button.getAttribute("aria-disabled") !== "true" &&
      !button.closest('[inert], [aria-disabled="true"]') && button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  function firstChoice() {
    // 使用给定选项按钮的结构定位，按 DOM 顺序取第一个，不绑定随机文案。
    return [...document.querySelectorAll('button[data-slot="game-button"].h-auto.whitespace-normal.text-left')]
      .find(button => button.querySelector("span.block.text-caption") && button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  }

  function delay(seconds, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, seconds * 1000);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function run(signal) {
    const { waitSec, maxRetries, cycleSec } = state.settings;
    const pageError = () => [...document.querySelectorAll('p[role="status"].text-destructive')]
      .find(item => item.textContent.trim() && item.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    // 仅恢复页面明确保留的原请求，不匹配具体错误文案。
    async function recover() {
      signal.throwIfAborted();
      if (!onTargetPage()) throw new Error("已离开修炼页面，任务停止。");
      if (!pageError()) return false;
      const button = [...document.querySelectorAll('button[data-slot="game-button"]')]
        .find(item => item.textContent.trim() === "确认原修炼结果" && available(item));
      if (!button) return false;
      state.message = "正在确认原修炼结果，等待页面更新";
      button.click();
      await delay(waitSec, signal);
      if (!onTargetPage()) throw new Error("已离开修炼页面，任务停止。");
      return true;
    }

    try {
      while (true) {
        signal.throwIfAborted();
        if (!onTargetPage()) throw new Error("已离开修炼页面，任务停止。");
        // 不接管用户已有的奇遇，避免把上一轮选项误认为新请求的结果。
        if (firstChoice()) throw new Error("页面已有未处理的奇遇选项，请手动处理后再开始。");
        let button;
        let choice;
        let recovered = false;
        // 每个阶段耗尽常规检查后，最多恢复一次，并重新按原次数检查。
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          if (!onTargetPage()) throw new Error("已离开修炼页面，任务停止。");
          state.message = `检查寻找奇遇按钮：${attempt}/${maxRetries}`;
          // 恢复可能直接返回奇遇选项，此时不重复寻找奇遇。
          if (recovered && firstChoice()) break;
          button = [...document.querySelectorAll('button[data-slot="game-button"]')]
            .find(item => item.textContent.trim() === "寻找奇遇");
          if (available(button)) break;
          button = null;
          if (attempt < maxRetries) await delay(waitSec, signal);
          else if (!recovered && await recover()) { recovered = true; attempt = 0; }
        }
        if (!button && !(recovered && firstChoice())) throw new Error("等待寻找奇遇按钮超时，任务停止。");
        if (button) button.click();

        recovered = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          state.message = `等待奇遇选项：${attempt}/${maxRetries}`;
          await delay(waitSec, signal);
          if (!onTargetPage()) throw new Error("已离开修炼页面，任务停止。");
          choice = firstChoice();
          if (available(choice)) break;
          choice = null;
          if (attempt === maxRetries && !recovered && await recover()) { recovered = true; attempt = 0; }
        }
        if (!choice) throw new Error("等待第一个奇遇选项超时，任务停止。");
        choice.click();

        // 等待选项消失再进入下一轮，避免重复提交尚未结算的奇遇。
        let settled = false;
        recovered = false;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          state.message = `等待选项处理：${attempt}/${maxRetries}`;
          await delay(waitSec, signal);
          if (!onTargetPage()) throw new Error("已离开修炼页面，任务停止。");
          // 错误状态下选项消失不代表结算成功，仍需按本阶段恢复。
          if (!firstChoice() && !pageError()) { settled = true; break; }
          if (attempt === maxRetries && !recovered && await recover()) { recovered = true; attempt = 0; }
        }
        if (!settled) throw new Error("选项仍未消失，无法确认处理完成，任务停止。");
        state.rounds++;
        state.message = "本轮选项已处理，等待下一轮";
        await delay(cycleSec, signal);
      }
    } catch (error) {
      state.message = signal.aborted ? "已停止" : error.message;
    } finally {
      state.running = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type !== "fengbao-encounter") return;
    if (message.action === "start" && !state.running) {
      const { waitSec, maxRetries, cycleSec } = message.settings;
      if (!Number.isFinite(waitSec) || waitSec < 0.1 || !Number.isInteger(maxRetries) || maxRetries < 1 || !Number.isFinite(cycleSec) || cycleSec < 0.1) {
        reply({ ...state, message: "请输入有效的时间和检查次数。" });
        return;
      }
      state.settings = { waitSec, maxRetries, cycleSec };
      state.running = true;
      state.rounds = 0;
      controller = new AbortController();
      void run(controller.signal);
    }
    if (message.action === "stop" && state.running) {
      state.message = "正在停止…";
      controller.abort();
    }
    reply(state);
  });
})();
