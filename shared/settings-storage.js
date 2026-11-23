// 仅保存调用方明确列出的配置控件；任务状态继续由原页面脚本管理。
function bindPersistentSettings(moduleName, fieldIds) {
  const key = `fengbao-settings-${moduleName}`;
  const fields = fieldIds.map(id => document.getElementById(id));
  const disabled = fields.map(field => field.disabled);
  let values = {};
  let writes = Promise.resolve();
  fields.forEach(field => { field.disabled = true; });

  function read(field) {
    if (field.type === 'checkbox' || field.type === 'radio') return field.checked;
    if (field.type === 'number') {
      return Number.isFinite(field.valueAsNumber) && field.validity.valid ? field.valueAsNumber : undefined;
    }
    return field.value;
  }

  const ready = (async () => {
    try {
      const stored = (await chrome.storage.local.get(key))[key] ?? {};
      for (const field of fields) {
        const value = stored[field.id];
        if (field.type === 'checkbox' || field.type === 'radio') {
          if (typeof value === 'boolean') field.checked = value;
        } else if (field.type === 'number') {
          if (typeof value === 'number' && Number.isFinite(value)) field.value = value;
        } else if (typeof value === 'string') {
          field.value = value;
        }
      }
    } finally {
      fields.forEach((field, index) => { field.disabled = disabled[index]; });
    }
    for (const field of fields) {
      const value = read(field);
      if (value !== undefined) values[field.id] = value;
    }
  })();

  async function save() {
    await ready;
    for (const field of fields) {
      const value = read(field);
      if (value !== undefined) values[field.id] = value;
    }
    const snapshot = { ...values };
    // 连续输入按提交顺序写入，避免较早的参数覆盖后一次修改。
    writes = writes.catch(() => {}).then(() => chrome.storage.local.set({ [key]: snapshot }));
    await writes;
  }

  function saveChange() {
    save().catch(error => {
      document.querySelector('#status').textContent = `保存配置失败：${error.message}`;
    });
  }
  for (const field of fields) {
    field.addEventListener('input', saveChange);
    field.addEventListener('change', saveChange);
  }
  return { ready, save };
}
