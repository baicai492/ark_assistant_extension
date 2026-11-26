const savedSettings = bindPersistentSettings('stewardship', [
  'interval', 'recall-events',
  'rescue-enabled', 'rescue-mode-auto', 'rescue-mode-workers', 'rescue-count',
  'dismiss-newcomers-enabled', 'dismiss-enabled', 'dismiss-total',
  'dismiss-stat-enabled', 'dismiss-stat-key', 'dismiss-stat',
  'population-enabled', 'population-total', 'population-min-idle',
  'god-enabled', 'birth-enabled', 'quest-enabled',
  'upgrade-enabled', 'upgrade-dig-enabled', 'upgrade-craft-enabled',
  'target-enabled', 'target-room', 'target-count', 'target-stat'
]);

async function initializeStewardshipSettings() {
  await savedSettings.ready;
  for (const [section, checkbox] of [
    ['rescue-section', 'rescue-enabled'], ['dismiss-section', 'dismiss-newcomers-enabled'],
    ['population-section', 'population-enabled'],
    ['god-section', 'god-enabled'], ['birth-section', 'birth-enabled'], ['quest-section', 'quest-enabled'],
    ['upgrade-section', 'upgrade-enabled'], ['target-section', 'target-enabled']
  ]) {
    document.getElementById(section).open = document.getElementById(checkbox).checked;
  }
  updateOptions();
  await refresh();
  if (running) await savedSettings.save();
  else if (godEnabled.checked) await refreshGodParents().catch(showGodError);
}
