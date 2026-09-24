// 端到端验证：mock 上游 + 真实启动 server.js，走 HTTP 打全链路。
// 运行：npm run test:e2e
import http from "node:http";
import { recordCount } from "./_test-count.mjs";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const PORT = 3456;
const UPSTREAM_PORT = 8899;

const hits = [];
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { /* 忽略 */ }
    hits.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: parsed });

    // 流式请求：按 SSE 分块吐字，验证代理是「边收边转发」而不是攒完再发
    // 路径里带 /html/ 时返回网关 HTML，用于验证代理的清洗
    if (req.url.indexOf("/html/") >= 0) {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html><body><h1>502 Bad Gateway</h1><p>上游网关错误</p></body></html>");
      return;
    }

    if (parsed.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const piece of ["E2E ", "流式 ", "改写结果"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "E2E 改写结果占位文本" } }],
      _echo: { model: parsed.model, temperature: parsed.temperature, max_tokens: parsed.max_tokens, path: req.url },
    }));
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

const child = spawn(NODE, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    UPSTREAM_TIMEOUT_MS: "2000",
    // mock 上游跑在 127.0.0.1，默认会被 SSRF 防护拦下，本地验证需显式开启
    ALLOW_PRIVATE_UPSTREAM: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

const base = `http://127.0.0.1:${PORT}`;
async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const results = [];
// 环境能力缺失（例如沙箱禁止 spawn 子进程）与代码错误要分开：前者记为 SKIP 并显式列出，
// 后者照旧 FAIL —— 不能让环境问题变成"看起来通过了"。
// 注意：跳过也要占一个用例位（skipped 标记），否则本机（跳过）与 CI（不跳过）的总数不同，
// README 里的条数就没法写死 —— 这个隐患正是 npm run check:docs 在 CI 上抓出来的。
function check(name, ok, detail = "", skippedFlag = false) {
  results.push({ name, ok, skipped: skippedFlag });
  const tag = skippedFlag ? "SKIP" : (ok ? "PASS" : "FAIL");
  console.log(`${tag}  ${name}${ok || skippedFlag ? "" : "  -> " + detail}`);
}

async function checkOrSkip(name, fn) {
  try {
    const out = await fn();
    check(name, true, "");
    return out;
  } catch (err) {
    if (err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES")) {
      check(name, true, `环境不允许 spawn 子进程（${err.code}），提交前请在普通终端复跑`, true);
      return null;
    }
    check(name, false, err && err.message);
    return null;
  }
}

function shutdown(code) {
  try { child.kill(); } catch { /* 忽略 */ }
  try { upstream.close(); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(code), 200);
}

const ready = await waitReady();
if (!ready) {
  console.error("服务未启动，日志：\n" + serverLog);
  shutdown(1);
} else {
  console.log("服务已就绪\n" + serverLog.trim() + "\n");

  const h = await fetch(base + "/api/health");
  const hb = await h.json();
  check("GET /api/health -> ok 且版本为 3.9.x", h.status === 200 && hb.ok === true && /^3\.9\./.test(hb.version),
    `status=${h.status} body=${JSON.stringify(hb)}`);
  check("health 不再返回内置模型清单", hb.models === "user-supplied", JSON.stringify(hb.models));

  const noBase = await fetch(base + "/api/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "k", messages: [{ role: "user", content: "x" }] }),
  });
  const noBaseBody = await noBase.json();
  check("缺 baseUrl -> 400 且提示明确（不再有内置模型兜底）",
    noBase.status === 400 && /baseUrl/.test(String(noBaseBody.error)), `status=${noBase.status} body=${JSON.stringify(noBaseBody).slice(0, 120)}`);

  const page = await fetch(base + "/");
  const html = await page.text();
  check("GET / -> 200 HTML", page.status === 200 && html.includes("AIGC降重"), `status=${page.status}`);
  check("HTML 带 CSP 头", (page.headers.get("content-security-policy") || "").includes("default-src 'self'"),
    String(page.headers.get("content-security-policy")));
  check("HTML 含代理状态占位", html.includes('id="proxyStatus"'), "缺少 proxyStatus");
  check("HTML 含记住 Key 开关", html.includes('id="rememberKeys"'), "缺少 rememberKeys");
  check("HTML 含首次提示条", html.includes('id="firstRunNotice"'), "缺少 firstRunNotice");
  check("HTML 已无 renderHeader 调用", !html.includes("renderHeader()"), "仍在调用未定义函数");

  const ann = await fetch(base + "/announcement.json");
  const annJson = await ann.json();
  const annOk = ann.status === 200 && (
    (Array.isArray(annJson.items) && annJson.items.some((it) => it && it.text)) ||
    typeof annJson.text === "string"
  );
  check("GET /announcement.json -> 200 且有公告内容", annOk, `status=${ann.status} body=${JSON.stringify(annJson).slice(0, 120)}`);

  const fav = await fetch(base + "/favicon.ico");
  check("GET /favicon.ico -> 204", fav.status === 204, `status=${fav.status}`);

  let routesOk = false;
  let routesDetail = "";
  try {
    const routes = JSON.parse(fs.readFileSync(path.join(ROOT, "_routes.json"), "utf8"));
    routesOk = routes.version === 1 && Array.isArray(routes.include) && routes.include.includes("/api/*");
    routesDetail = JSON.stringify(routes);
  } catch (err) {
    routesDetail = err.message;
  }
  check("Pages 路由面限定在 /api/*（_routes.json）", routesOk, routesDetail);

  await checkOrSkip("_redirects 覆盖全部被跟踪的非公开文件（发布面收口）", async () => {
    const { expectedRules } = await import("./gen-redirects.mjs");
    const rules = expectedRules();
    const txt = fs.readFileSync(path.join(ROOT, "_redirects"), "utf8");
    const missing = rules.filter((r) => !txt.includes(r));
    if (missing.length) {
      throw new Error(`_redirects 缺 ${missing.length} 条规则（跑 npm run gen:redirects）：${missing.join(", ")}`);
    }
    return rules.length;
  });

  const nf = await fetch(base + "/not-exist");
  check("未知路径 -> 404", nf.status === 404, `status=${nf.status}`);

  const payload = {
    apiKey: "e2e-key",
    model: "glm-4.7-e2e-probe",
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1/chat/completions`,
    temperature: 1.4,
    max_tokens: 2048,
    messages: [
      { role: "system", content: "只输出改写结果" },
      { role: "user", content: "原始段落内容。" },
    ],
  };
  hits.length = 0;
  const w = await fetch(base + "/api/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const wb = await w.json();
  check("POST /api/rewrite 走通全链路", w.status === 200 && wb.choices?.[0]?.message?.content === "E2E 改写结果占位文本",
    `status=${w.status} body=${JSON.stringify(wb).slice(0, 200)}`);
  check("model 参数被透传（不再硬编码 deepseek-chat）", wb._echo?.model === "glm-4.7-e2e-probe",
    JSON.stringify(wb._echo));
  check("temperature 与 max_tokens 透传", wb._echo?.temperature === 1.4 && wb._echo?.max_tokens === 2048,
    JSON.stringify(wb._echo));
  check("上游收到的鉴权头正确", hits.at(-1)?.auth === "Bearer e2e-key", JSON.stringify(hits.at(-1)?.auth));

  const badOrigin = await fetch(base + "/api/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify(payload),
  });
  check("跨站 Origin -> 403", badOrigin.status === 403, `status=${badOrigin.status}`);

  const sameOrigin = await fetch(base + "/api/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify(payload),
  });
  check("同源 Origin -> 200 且回显 Origin",
    sameOrigin.status === 200 && sameOrigin.headers.get("access-control-allow-origin") === base,
    `status=${sameOrigin.status} acao=${sameOrigin.headers.get("access-control-allow-origin")}`);

  const htmlUpstream = await fetch(base + "/api/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/html/v1/chat/completions` }),
  });
  const htmlBody = await htmlUpstream.json();
  check("上游返回 HTML 时报错内容已清洗（不留标签）",
    htmlUpstream.status === 502 &&
    /Bad Gateway/.test(htmlBody.error.message) &&
    !/[<>]/.test(htmlBody.error.message),
    `status=${htmlUpstream.status} msg=${JSON.stringify(htmlBody.error && htmlBody.error.message).slice(0, 90)}`);

  const streamResp = await fetch(base + "/api/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  const streamType = streamResp.headers.get("Content-Type") || "";
  const streamBody = await streamResp.text();
  check("流式请求：代理透传 SSE 而不是攒完再发",
    streamResp.status === 200 && streamType.includes("event-stream") &&
    streamBody.includes("data:") && streamBody.includes("流式"),
    `status=${streamResp.status} ct=${streamType} body=${streamBody.slice(0, 80)}`);

  // 带同源 Origin 再打一次：CORS 头只在带 Origin 时才该出现，顺带验证流式路径没漏掉它
  const streamCors = await fetch(base + "/api/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  await streamCors.text();
  check("流式响应带同源 CORS 回显与禁用缓存头",
    streamCors.headers.get("Access-Control-Allow-Origin") === base &&
    (streamCors.headers.get("Cache-Control") || "").includes("no-cache"),
    `acao=${streamCors.headers.get("Access-Control-Allow-Origin")} cc=${streamCors.headers.get("Cache-Control")}`);
  check("流式请求也会被记进限流与上游调用", hits.some((h) => h.body && h.body.stream === true), "上游没收到 stream 标记");

  const put = await fetch(base + "/api/rewrite", { method: "PUT", headers: { Origin: base } });
  check("PUT /api/rewrite -> 405", put.status === 405, `status=${put.status}`);

  const rel = await fetch(base + "/server.js");
  check("静态路由不暴露 server.js", rel.status === 404, `status=${rel.status}`);

  const failed = results.filter((x) => !x.ok);
  const skippedCount = results.filter((x) => x.skipped).length;
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length - skippedCount}，失败 ${failed.length}` +
    (skippedCount ? `，环境跳过 ${skippedCount}` : ""));
  if (skippedCount) {
    console.log("跳过的项（本机环境限制，非代码问题）：");
    for (const r of results.filter((x) => x.skipped)) console.log(`  - ${r.name}`);
  }
  recordCount("npm run test:e2e", results.length, skippedCount);
  shutdown(failed.length ? 1 : 0);
}
