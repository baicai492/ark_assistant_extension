// 一次性安装 Chrome Native Messaging host：让扩展在开启托管时把日志写入
// 插件目录的 logs/shelter.log（路径不写死，按 tools 目录计算）。
// 用法：双击 tools/install-log-host.cmd，或运行：
//   node tools/install-log-host.js [扩展ID]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const hostName = 'com.fengbao.shelter_log';
const projectRoot = path.resolve(__dirname, '..');
const hostDir = path.join(process.env.LOCALAPPDATA || path.join(projectRoot, '.host'), 'fengbao-shelter-log');
const hostScript = path.join(__dirname, 'log-host.js');
const batPath = path.join(hostDir, 'log-host.bat');
const manifestPath = path.join(hostDir, `${hostName}.json`);
const normalize = value => value.toLowerCase().replace(/[\\/]+$/, '');
const target = normalize(projectRoot);

function findExtensionIds() {
  const ids = new Set();
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data')
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const profile of fs.readdirSync(root)) {
      for (const name of ['Secure Preferences', 'Preferences']) {
        const file = path.join(root, profile, name);
        if (!fs.existsSync(file)) continue;
        try {
          const settings = JSON.parse(fs.readFileSync(file, 'utf8')).extensions?.settings ?? {};
          for (const [id, value] of Object.entries(settings)) {
            if (typeof value?.path === 'string' && normalize(value.path) === target) ids.add(id);
          }
        } catch {}
      }
    }
  }
  return [...ids];
}

const ids = process.argv[2] ? [process.argv[2]] : findExtensionIds();
if (!ids.length) {
  console.error('未找到加载本项目的扩展。请先在 chrome://extensions 查看扩展 ID，再运行：');
  console.error('  node tools/install-log-host.js <扩展ID>');
  process.exitCode = 1;
} else if (!ids.every(id => /^[a-p]{32}$/.test(id))) {
  console.error(`扩展 ID 格式不正确：${ids.join(', ')}`);
  process.exitCode = 1;
} else {
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(batPath, `@echo off\r\n"${process.execPath}" "${hostScript}"\r\n`, 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: hostName,
    description: '风堇Ark自动助手本地日志写入',
    path: batPath,
    type: 'stdio',
    allowed_origins: ids.map(id => `chrome-extension://${id}/`)
  }, null, 2), 'utf8');

  for (const browser of ['Google\\Chrome', 'Microsoft\\Edge']) {
    const key = `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${hostName}`;
    execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
  }

  console.log(`已安装本地日志 host：${hostName}`);
  console.log(`扩展 ID：${ids.join(', ')}`);
  console.log(`日志写入：${path.join(projectRoot, 'logs', 'shelter.log')}`);
  console.log('请到 chrome://extensions 重新加载扩展，之后开启托管会自动写入日志。');
}
