// 线上暴露面探测：按「内容」而不是状态码判断文件是否真的可取。
// 运行：npm run probe:live [baseUrl]
// 关键点：Pages 开启 SPA 回退后，不存在的路径也会返回 200 + index.html，
// 只看状态码会把回退误判成泄露；这里用 Content-Type + 正文特征区分。
const BASE = (process.argv[2] || "https://reduce-aigc.pages.dev").replace(/\/$/, "");

const SHOULD_BE_PUBLIC = ["/", "/announcement.json"];
// /index.html 会被 Pages 用 308 规范化到 /，两种结果都算正常
const LENIENT = ["/index.html"];
const SHOULD_NOT_BE_PUBLIC = [
  "/server.js", "/worker.js", "/wrangler.jsonc", "/package.json", "/README.md",
  "/.gitignore", "/.assetsignore", "/scripts/selftest.mjs", "/scripts/e2e-local.mjs",
  "/scripts/headless-check.mjs", "/.git/config", "/functions/api/rewrite.js",
];
const EXPECTED_FALLBACK = ["/not-exist-xyz", "/functions/_lib/rewrite-handler.mjs", "/_routes.json"];

async function probe(p) {
  try {
    const resp = await fetch(BASE + p, { redirect: "manual" });
    const ct = (resp.headers.get("content-type") || "").split(";")[0].trim();
    const location = resp.headers.get("location") || "";
    const buf = Buffer.from(await resp.arrayBuffer());
    const head = buf.toString("utf8").slice(0, 80).replace(/\s+/g, " ");
    const isSpaFallback = buf.length > 20000 && head.startsWith("<!DOCTYPE html>");
    return { p, status: resp.status, ct, location, len: buf.length, isSpaFallback, head };
  } catch (err) {
    return { p, status: "ERR", ct: err.message, location: "", len: 0, isSpaFallback: false, head: "" };
  }
}

const rows = [];
for (const p of [...SHOULD_BE_PUBLIC, ...LENIENT, ...SHOULD_NOT_BE_PUBLIC, ...EXPECTED_FALLBACK]) rows.push(await probe(p));

console.log(`目标：${BASE}\n`);
console.log("路径".padEnd(36) + "码".padEnd(6) + "类型".padEnd(26) + "字节".padEnd(9) + "内容");
for (const r of rows) {
  const kind = r.status >= 300 && r.status < 400 ? `redirect -> ${r.location}` : (r.isSpaFallback ? "SPA 回退(html)" : r.ct);
  console.log(r.p.padEnd(36) + String(r.status).padEnd(6) + String(kind).padEnd(26) + String(r.len).padEnd(9) + r.head.slice(0, 44));
}

const problems = [];
for (const r of rows) {
  if (LENIENT.includes(r.p)) {
    const ok = (r.status === 200 && r.head.startsWith("<!DOCTYPE html>")) || (r.status >= 300 && r.status < 400);
    if (!ok) problems.push(`${r.p} 异常，实际 ${r.status} ${r.ct}`);
    continue;
  }
  if (SHOULD_BE_PUBLIC.includes(r.p)) {
    const ok = r.p === "/announcement.json"
      ? r.status === 200 && r.ct.includes("json")
      : r.status === 200 && r.head.startsWith("<!DOCTYPE html>");
    if (!ok) problems.push(`${r.p} 应可正常访问，实际 ${r.status} ${r.ct}`);
    continue;
  }
  const blocked = r.status >= 300 && r.status < 400;
  if (!blocked && !r.isSpaFallback) {
    problems.push(`${r.p} 仍可取到真实内容 [${r.ct}] ${r.len}B :: ${r.head.slice(0, 60)}`);
  }
}

try {
  const health = await (await fetch(BASE + "/api/health")).json();
  console.log(`\n/api/health -> version=${health.version} models=${(health.models || []).length} 个`);
  if (!/^2\./.test(String(health.version))) problems.push(`线上版本异常：${health.version}`);
} catch (err) {
  problems.push("/api/health 不可用：" + err.message);
}

const cross = await fetch(BASE + "/api/rewrite", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
  body: JSON.stringify({ apiKey: "x", messages: [{ role: "user", content: "x" }] }),
});
console.log(`跨站 Origin 探测 -> HTTP ${cross.status}（期望 403）`);
if (cross.status !== 403) problems.push(`CORS 未拦截跨站请求：${cross.status}`);

console.log("");
if (problems.length) {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("线上暴露面检查通过 ✅");
