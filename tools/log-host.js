// Chrome Native Messaging host：接收扩展发来的日志快照，去重后追加到插件
// 目录下的 logs/shelter.log。路径按本文件所在目录计算，不写死项目位置。
// 扩展存储和面板只保留最近一段，但本地文件会持续累积，不受扩展侧的条数上限截断。
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'shelter.log');
// 只读取文件尾部用于找出本次快照中的重叠部分；不读取整份历史。
const tailBytes = 4 * 1024 * 1024;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function readTailLines() {
  let stat;
  try {
    stat = fs.statSync(logFile);
  } catch {
    return [];
  }
  if (!stat.size) return [];
  const start = Math.max(0, stat.size - tailBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(logFile, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
      if (!read) break;
      offset += read;
    }
    let text = buffer.subarray(0, offset).toString('utf8');
    // 从文件中部开始读时，第一行可能不完整，丢掉。
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    if (text.endsWith('\n')) text = text.slice(0, -1);
    return text ? text.split('\n') : [];
  } finally {
    fs.closeSync(fd);
  }
}

// 找文件末尾与本次快照开头最长的重叠，只追加真正新增的行。
// 快照是扩展每次送来的最近一段日志，重叠之后的部分才是新日志。
function overlapLength(fileLines, incoming) {
  const max = Math.min(fileLines.length, incoming.length);
  if (!max) return 0;
  const last = fileLines[fileLines.length - 1];
  for (let size = max; size > 0; size--) {
    if (incoming[size - 1] !== last) continue;
    let same = true;
    for (let index = 0; index < size; index++) {
      if (fileLines[fileLines.length - size + index] !== incoming[index]) {
        same = false;
        break;
      }
    }
    if (same) return size;
  }
  return 0;
}

function appendLogs(logs) {
  const lines = logs.filter(line => typeof line === 'string');
  fs.mkdirSync(logDir, { recursive: true });
  const overlap = overlapLength(readTailLines(), lines);
  const fresh = lines.slice(overlap);
  if (!fresh.length) return { lines: lines.length, appended: 0, file: logFile };
  let separator = '';
  try {
    const size = fs.statSync(logFile).size;
    if (size) {
      const fd = fs.openSync(logFile, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) separator = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {}
  fs.appendFileSync(logFile, `${separator}${fresh.join('\n')}\n`, 'utf8');
  return { lines: lines.length, appended: fresh.length, file: logFile };
}

function clearLogs() {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logFile, '', 'utf8');
  return { lines: 0, appended: 0, file: logFile };
}

function handle(message) {
  try {
    if (message?.command === 'clear') {
      send({ ok: true, ...clearLogs() });
    } else if (message?.command === 'log') {
      if (!Array.isArray(message.logs)) throw new Error('logs 必须是数组');
      // 兼容旧版面板的“清空日志”消息；后台推送不会发送空数组。
      if (!message.logs.length) {
        send({ ok: true, ...clearLogs() });
        return;
      }
      send({ ok: true, ...appendLogs(message.logs) });
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
