// 从游戏使用的 zh-CN/strings.conf 生成安卓端系列码名称表。
// 用法：node gen-setnames.js "D:\\Game\\MDPro3\\Data\\locales\\zh-CN\\strings.conf"
const fs = require('fs');
const path = require('path');

const source = process.argv[2];
if (!source) {
  console.error('用法：node gen-setnames.js <zh-CN/strings.conf 路径>');
  process.exit(1);
}

const names = new Map();
for (const [index, line] of fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
  if (!line.startsWith('!setname')) continue;
  const match = line.match(/^!setname\s+0x([0-9a-fA-F]+)\s+([^\t\r\n]+)/);
  if (!match) throw new Error(`第 ${index + 1} 行的 !setname 格式无效`);
  const code = parseInt(match[1], 16);
  const name = match[2].trim();
  if (!name || code < 1 || code > 0xffff) throw new Error(`第 ${index + 1} 行的系列码超出 CDB 的 16 位范围或缺少名称`);
  if (names.has(code)) throw new Error(`第 ${index + 1} 行的系列码 0x${code.toString(16)} 重复`);
  names.set(code, name);
}

if (!names.size) throw new Error('没有找到 !setname 条目');
const entries = [...names].sort(([a], [b]) => a - b).map(([code, name]) => `${code}:${JSON.stringify(name)}`);
const output = `// 自动生成：来自游戏 zh-CN/strings.conf 的 !setname 映射（16 位系列码 → 中文名）\n` +
  `// 使用 gen-setnames.js 重新生成。共 ${entries.length} 条。\n` +
  `window.YGO_SETNAMES = {${entries.join(',')}};\n`;
fs.writeFileSync(path.join(__dirname, 'www', 'setnames.js'), output, 'utf8');
console.log(`已生成 ${entries.length} 条系列码：${path.join(__dirname, 'www', 'setnames.js')}`);
