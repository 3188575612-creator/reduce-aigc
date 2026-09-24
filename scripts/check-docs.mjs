// 文档一致性校验：README 标称的测试条数必须与实测一致，版本号必须与 package.json/代理一致，
// 公告里不许出现版本日志式条目。
// 数据来源：各测试脚本运行时写入的 output/test-counts.json（不用重复跑测试，也不依赖能否 spawn）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COUNTS = path.join(ROOT, "output", "test-counts.json");
const COMMANDS = ["npm test", "npm run test:e2e", "npm run test:ui"];

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const problems = [];

let counts = null;
try {
  counts = JSON.parse(fs.readFileSync(COUNTS, "utf8"));
} catch {
  console.log("缺少测试结果文件（output/test-counts.json）。");
  console.log("请先跑一遍测试（npm test / test:e2e / test:ui），再执行本校验。");
  console.log("CI 里的顺序就是先跑三个套件、最后跑这一步。");
  process.exit(1);
}

console.log("实测条数：");
let total = 0;
for (const cmd of COMMANDS) {
  const rec = counts[cmd];
  if (!rec) { problems.push(`结果文件里没有「${cmd}」，可能这次没跑到`); continue; }
  total += rec.total;
  console.log(`  ${cmd.padEnd(18)} ${rec.total} 项${rec.skipped ? `（环境跳过 ${rec.skipped}）` : ""}  采集于 ${rec.at.replace("T", " ").slice(0, 16)}`);
}
console.log(`  合计 ${total} 项`);

const claimedFor = (cmd) => {
  const row = readme.split("\n").find((l) => l.includes("\`" + cmd + "\`"));
  if (!row) return null;
  const m = row.match(/(\d+)\s*项/);
  return m ? Number(m[1]) : null;
};

console.log("");
for (const cmd of COMMANDS) {
  const claimed = claimedFor(cmd);
  const actual = counts[cmd] ? counts[cmd].total : null;
  if (actual === null) continue;
  if (claimed === null) problems.push(`README 的「${cmd}」一行没写条数（实际 ${actual} 项）`);
  else if (claimed !== actual) problems.push(`README 说「${cmd}」是 ${claimed} 项，实际 ${actual} 项`);
}

const claimedTotal = (readme.match(/合计离线\s*\*\*(\d+)\s*项\*\*/) || readme.match(/合计离线\s*(\d+)\s*项/) || [])[1];
if (!claimedTotal) problems.push(`README 没写「合计离线 N 项」（实际 ${total} 项）`);
else if (Number(claimedTotal) !== total) problems.push(`README 说合计 ${claimedTotal} 项，实际 ${total} 项`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const handler = fs.readFileSync(path.join(ROOT, "functions/_lib/rewrite-handler.mjs"), "utf8");
const handlerV = (handler.match(/export const VERSION = "([^"]+)"/) || [])[1];
if (pkg !== handlerV) problems.push(`package.json=${pkg} 与代理版本=${handlerV} 不一致`);
const firstChangelog = (readme.match(/### (\d+\.\d+\.\d+)/) || [])[1];
if (firstChangelog !== pkg) problems.push(`README 首个变更记录是 ${firstChangelog}，package.json 是 ${pkg}`);

const ann = JSON.parse(fs.readFileSync(path.join(ROOT, "announcement.json"), "utf8"));
const logLike = ann.items.filter((it) => /（v\d+\.\d+）|v\d+\.\d+ 更新/.test(String(it.time) + String(it.text)));
if (logLike.length) problems.push(`announcement.json 里混进了版本日志式公告 ${logLike.length} 条（公告只放用户必要通知）`);

if (problems.length) {
  console.log("文档不一致：");
  for (const p of problems) console.log("  ✗ " + p);
  process.exit(1);
}
console.log("文档与实现一致 ✓");
