const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('日志桥接保存目标建造进度，忽略无效消息', async () => {
  const script = fs.readFileSync(path.join(__dirname, 'log-bridge.js'), 'utf8');
  const listeners = [], writes = [];
  const window = { addEventListener(name, fn) { if (name === 'message') listeners.push(fn); } };
  const context = vm.createContext({
    window, location: { origin: 'https://game.arkengine.me' },
    chrome: { storage: { local: { set: async values => writes.push(values) }, onChanged: { addListener() {} } } },
    setTimeout: () => 1, clearTimeout() {}
  });
  vm.runInContext(script, context);
  assert.equal(listeners.length, 1);
  const progress = { room: 'storage', trainStat: null, startFloor: 32 };
  const message = data => ({ source: window, origin: 'https://game.arkengine.me', data });
  await listeners[0](message({ src: 'fengbao-shelter-log', type: 'target-progress', progress }));
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ shelterTargetProgress: progress }]);
  await listeners[0](message({ src: 'other', type: 'target-progress', progress }));
  await listeners[0](message({ src: 'fengbao-shelter-log', type: 'target-progress', progress: null }));
  await listeners[0](message({ src: 'fengbao-shelter-log', type: 'log' }));
  assert.equal(writes.length, 1);
});
