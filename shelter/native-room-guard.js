(() => {
  'use strict';

  const apiKey = '__fengbaoNativeRoomGuard';
  const recommendationLabelParts = ['推荐调入', '按', '含装备', '排序'];

  function isNativeRecommendationSelect(element) {
    if (!element || element.tagName?.toLowerCase?.() !== 'select') return false;
    const label = [
      element.textContent,
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title')
    ].filter(value => typeof value === 'string').join('\n');
    return recommendationLabelParts.every(part => label.includes(part));
  }

  function groupFor(element, root) {
    try {
      return element.closest?.('dialog, [role="dialog"]') ?? root;
    } catch {
      return root;
    }
  }

  function dedupeNativeRecommendationSelects(root = globalThis.document) {
    if (!root?.querySelectorAll) return 0;
    const seenGroups = new Set();
    let removed = 0;
    for (const element of root.querySelectorAll('select')) {
      if (!isNativeRecommendationSelect(element)) continue;
      const group = groupFor(element, root);
      if (!seenGroups.has(group)) {
        seenGroups.add(group);
        continue;
      }
      // 只删除重复的原生下拉本身，保留游戏已经渲染好的第一个可交互控件。
      element.remove();
      removed++;
    }
    return removed;
  }

  function startNativeRoomGuard({
    root = globalThis.document,
    Observer = globalThis.MutationObserver,
    schedule = callback => queueMicrotask(callback)
  } = {}) {
    if (!root?.querySelectorAll || typeof Observer !== 'function') return null;
    let scheduled = false;
    let running = false;
    let stopped = false;
    let observer;

    const run = () => {
      scheduled = false;
      if (stopped || running) return;
      running = true;
      try {
        dedupeNativeRecommendationSelects(root);
      } finally {
        running = false;
      }
    };
    const queue = () => {
      if (stopped || running || scheduled) return;
      scheduled = true;
      schedule(run);
    };

    observer = new Observer(queue);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    run();

    const guard = {
      run,
      stop() {
        if (stopped) return;
        stopped = true;
        observer.disconnect();
      }
    };
    return guard;
  }

  const api = { isNativeRecommendationSelect, dedupeNativeRecommendationSelects, startNativeRoomGuard };
  globalThis[apiKey] = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined' && globalThis.MutationObserver &&
      !globalThis.__fengbaoNativeRoomGuardStarted) {
    globalThis.__fengbaoNativeRoomGuardStarted = true;
    startNativeRoomGuard();
  }
})();
