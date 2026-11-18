// Chrome Native Messaging host：接收扩展发来的完整日志，写入插件目录下的
// logs/shelter.log。路径按本文件所在目录计算，不写死项目位置。
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'shelter.log');

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function writeLogs(logs) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logFile, logs.length ? `${logs.join('\n')}\n` : '', 'utf8');
}

function handle(message) {
  try {
    if (message?.command === 'log') {
      if (!Array.isArray(message.logs)) throw new Error('logs 必须是数组');
      writeLogs(message.logs);
      send({ ok: true, lines: message.logs.length, file: logFile });
    } else if (message?.command === 'ping') {
      // 面板用 ping 确认 host 已安装且日志目录可写。
      fs.mkdirSync(logDir, { recursive: true });
      fs.accessSync(logDir, fs.constants.W_OK);
      send({ ok: true, file: logFile });
    } else {
      send({ error: '未知命令' });
    }
  } catch (error) {
    send({ error: error.message });
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const raw = buffer.subarray(4, 4 + length).toString('utf8');
    buffer = buffer.subarray(4 + length);
    try {
      handle(JSON.parse(raw));
    } catch (error) {
      send({ error: `消息解析失败：${error.message}` });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
