// 生成 _redirects：把 Pages 发布面上「不该公开」的仓库文件全部 302 挡回首页。
// 为什么要生成：Pages 的发布面 = 仓库里所有被跟踪的文件，靠手写黑名单迟早会漏；
// 这里以 git 跟踪清单为唯一来源，新增文件只要跑一次 `npm run gen:redirects` 就不会漏，
// 且 e2e 会断言「清单与 _redirects 一致」，漏跑会导致测试失败。
// 用 execFileSync 而不是 execSync：前者直接起进程，不经 cmd.exe / sh。
// Windows 上受限环境 spawn cmd.exe 会报 EBUSY，且少一层 shell 也少一份注入面。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 允许公开的静态资源
const PUBLIC_PATHS = new Set(["index.html", "announcement.json"]);

// Pages 本来就不会发布的路径：Functions 源码、.git 目录、本地产物、Pages 特殊文件。
// 注意：dotfile 本身（.gitignore / .assetsignore）**是会被发布**的，实测确认过，不要放进这个列表。
const NEVER_PUBLISHED = [
  /^functions\//,
  /^\.git\//,
  /^\.workbuddy\//,
  /^\.wrangler\//,
  /^node_modules\//,
  /^output\//,
  /^_redirects$/,
  /^_routes\.json$/,
  /^_headers$/,
];

export function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    if (err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES")) {
      // 保留原始 code：调用方要靠它区分「环境不支持」和「真的出错」
      const wrapped = new Error("当前环境不允许启动子进程，无法执行 git ls-files；请在普通终端运行 npm run gen:redirects");
      wrapped.code = err.code;
      throw wrapped;
    }
    throw err;
  }
}

export function expectedRules() {
  const rootFiles = [];
  const dirs = new Set();
  for (const f of trackedFiles()) {
    if (PUBLIC_PATHS.has(f)) continue;
    if (NEVER_PUBLISHED.some((re) => re.test(f))) continue;
    const dir = path.posix.dirname(f);
    if (dir === ".") rootFiles.push(`/${f} / 302`);
    else dirs.add(`/${dir}/* / 302`);
  }
  return [...rootFiles.sort(), ...[...dirs].sort()];
}

export function renderFile() {
  const rules = expectedRules();
  return [
    "# 本文件由 scripts/gen-redirects.mjs 生成，请勿手改：npm run gen:redirects",
    "#",
    "# 为什么需要它：Cloudflare Pages 的发布面 = 仓库里所有被跟踪的文件",
    "# （Build output directory 是仓库根），.assetsignore 只对 Workers 生效。",
    "# Pages 的 _redirects 只支持 301/302/303/307/308、不支持 404，故用 302 把内容指走。",
    "# _redirects 不作用于 Pages Functions 的请求，因此不影响 /api/*。",
    "",
    ...rules,
    "",
  ].join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = path.join(ROOT, "_redirects");
  const next = renderFile();
  const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (prev === next) {
    console.log(`_redirects 已是最新（${expectedRules().length} 条规则）`);
  } else {
    fs.writeFileSync(target, next);
    console.log(`_redirects 已更新为 ${expectedRules().length} 条规则：`);
    for (const r of expectedRules()) console.log("  " + r);
  }
}
