const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('本地日志程序通过标准帧追加、去重、清空，不执行安装或修改注册表', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-log-test-'));
  const toolsDir = path.join(temp, 'tools'); fs.mkdirSync(toolsDir);
  fs.copyFileSync(path.join(__dirname, '../tools/log-host.js'), path.join(toolsDir, 'log-host.js'));
  const send = message => {
    const body = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    const result = spawnSync(process.execPath, [path.join(toolsDir, 'log-host.js')], { input: Buffer.concat([header, body]) });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.ok(result.stdout.length >= 4);
    const size = result.stdout.readUInt32LE(0); assert.equal(result.stdout.length, size + 4);
    return JSON.parse(result.stdout.subarray(4).toString());
  };
  assert.equal(send({ command: 'ping' }).ok, true);
  assert.equal(send({ command: 'log', logs: ['第一条', '第二条'] }).appended, 2);
  assert.equal(send({ command: 'log', logs: ['第一条', '第二条'] }).appended, 0);
  assert.equal(send({ command: 'log', logs: ['第二条', '第三条'] }).appended, 1);
  assert.equal(fs.readFileSync(path.join(temp, 'logs/shelter.log'), 'utf8'), '第一条\n第二条\n第三条\n');
  assert.equal(send({ command: 'clear' }).ok, true);
  assert.equal(fs.readFileSync(path.join(temp, 'logs/shelter.log'), 'utf8'), '');
  assert.match(send({ command: 'unknown' }).error, /未知/);
  // 仅清理本测试创建且已验证位于临时目录内的目录。
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temp, { recursive: true });
});

test('后台读取页面日志单次失败不会停掉定时推送，连续确认停止后才清理', async () => {
  let cleared = 0, reads = 0;
  const context = vm.createContext({ chrome: {
    runtime: { onMessage: { addListener() {} }, sendNativeMessage: async () => ({ ok: true, file: '测试目录/logs/shelter.log' }) },
    storage: { local: { get: async () => ({ shelterLogs: ['旧日志'] }), set: async () => {} } },
    scripting: { executeScript: async () => {
      reads++;
      if (reads === 1) throw new Error('页面暂时不可读');
      return [{ result: { running: false, logs: [] } }];
    } },
    alarms: { clear: async () => { cleared++; }, create: async () => {}, onAlarm: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } }
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  await context.pushShelterLog(42);
  assert.equal(cleared, 0, '单次读取失败不能停掉推送');
  await context.pushShelterLog(42);
  await context.pushShelterLog(42);
  assert.equal(cleared, 0);
  await context.pushShelterLog(42);
  assert.equal(cleared, 1);
});

test('后台识别本地日志程序返回的错误，不伪报成功', async () => {
  const store = {}, handlers = [];
  const context = vm.createContext({ chrome: {
    runtime: { onMessage: { addListener: fn => handlers.push(fn) }, sendNativeMessage: async () => ({ error: '测试写入被拒绝' }) },
    storage: { local: { set: async value => Object.assign(store, value) } },
    alarms: { onAlarm: { addListener() {} } }, tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } }
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  await context.sendShelterLogs(['test']);
  assert.equal(store.shelterLogStatus.ok, false);
  assert.match(store.shelterLogStatus.error, /写入被拒绝/);
  await assert.rejects(context.clearShelterLogs(), /写入被拒绝/);
});
