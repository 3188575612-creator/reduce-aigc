// 记录本次运行的断言条数，供 npm run check:docs 校验 README 的标称数字。
// 为什么要落文件：check-docs 若自己去 spawn 测试，一来重复跑一遍、二来在禁止 spawn 的环境会失效。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "output", "test-counts.json");

export function recordCount(key, total, skipped = 0) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const cur = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
    cur[key] = { total, skipped, at: new Date().toISOString() };
    fs.writeFileSync(FILE, JSON.stringify(cur, null, 2));
  } catch {
    // 统计是辅助信息，失败不能影响测试结论
  }
}
