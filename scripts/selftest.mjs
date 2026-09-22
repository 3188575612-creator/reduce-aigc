// 代理层回归自测：本地 mock 上游 + 直接驱动共享 handler。
// 运行：npm test
import http from "node:http";
import {
  handleRewrite, VERSION, MODEL_ENDPOINTS,
  resolveTarget, applyModelLimits, buildRequestBody,
} from "../functions/_lib/rewrite-handler.mjs";

const MSG_OK = "改写后的占位文本，用于长度校验通过。".repeat(6);

const upstreamCalls = [];
let emptyOnceFired = false;

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { /* 忽略 */ }
    upstreamCalls.push({ path: req.url, headers: req.headers, body: parsed });
    const blob = JSON.stringify(parsed.messages || []);

    if (!/\/(?:[^/]+\/)?v\d+\/chat\/completions$/.test(req.url || "")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "mock: 路径不对 " + req.url } }));
    }
    if (parsed.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"流"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    if (blob.includes("NOT_JSON")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html>上游返回了 HTML 页面</html>");
    }
    if (blob.includes("SLOW")) return;
    if (blob.includes("EMPTY_ONCE") && !emptyOnceFired) {
      emptyOnceFired = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("");
    }
    if (blob.includes("UPSTREAM_500")) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "上游炸了" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: MSG_OK } }],
      _echo: { model: parsed.model, temperature: parsed.temperature, max_tokens: parsed.max_tokens, path: req.url },
    }));
  });
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;
const baseUrl = `http://127.0.0.1:${upstreamPort}/v1/chat/completions`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

let ipSeq = 0;
async function call(payload, opts = {}) {
  const method = opts.method || "POST";
  const headers = {
    "X-Forwarded-For": opts.ip || `10.0.0.${++ipSeq}`,
    ...(opts.headers || {}),
  };
  if (method === "POST") headers["Content-Type"] = "application/json";
  const req = new Request(opts.url || "http://app.local/api/rewrite", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(payload) : undefined,
  });
  return handleRewrite(req, { UPSTREAM_TIMEOUT_MS: "800", ...(opts.env || {}) });
}

function validPayload(extra = {}) {
  return {
    apiKey: "test-key-123",
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: "只输出改写结果" },
      { role: "user", content: "原始文本内容，需要改写的段落。" },
    ],
    baseUrl,
    ...extra,
  };
}

const health = await call(null, { method: "GET" });
const healthBody = await health.json();
check("GET 返回健康信息", health.status === 200 && healthBody.ok === true && healthBody.version === VERSION,
  `status=${health.status} body=${JSON.stringify(healthBody).slice(0, 120)}`);
check("健康信息含模型清单", Array.isArray(healthBody.models) && healthBody.models.includes("deepseek-v4-pro"),
  JSON.stringify(healthBody.models));

let r = await call({ messages: [] });
check("缺少 apiKey -> 400", r.status === 400, `status=${r.status}`);

r = await call({ apiKey: "k" });
check("缺少 messages -> 400", r.status === 400, `status=${r.status}`);

r = await call({ apiKey: "k", messages: "不是数组", baseUrl });
check("messages 非数组 -> 400", r.status === 400, `status=${r.status}`);

r = await call({ apiKey: "k", messages: [{ role: "hacker", content: "x" }], baseUrl });
check("role 非法 -> 400", r.status === 400, `status=${r.status}`);

r = await call({ apiKey: "k", messages: [{ role: "user", content: "x".repeat(130000) }], baseUrl });
check("文本超长 -> 400", r.status === 400, `status=${r.status}`);

r = await call({ apiKey: "k", messages: [{ role: "user", content: "x".repeat(280000) }], baseUrl });
check("请求体过大 -> 413", r.status === 413, `status=${r.status}`);

upstreamCalls.length = 0;
r = await call(validPayload());
let body = await r.json();
check("正常改写 -> 200 且返回正文", r.status === 200 && body.choices?.[0]?.message?.content === MSG_OK,
  `status=${r.status} body=${JSON.stringify(body).slice(0, 160)}`);
check("bearer 鉴权头正确", upstreamCalls.at(-1)?.headers?.authorization === "Bearer test-key-123",
  JSON.stringify(upstreamCalls.at(-1)?.headers));
check("默认模型透传 deepseek-v4-pro", body._echo?.model === "deepseek-v4-pro", JSON.stringify(body._echo));

r = await call(validPayload({ authType: "apikey" }));
body = await r.json();
check("authType=apikey 使用 api-key 头", upstreamCalls.at(-1)?.headers?.["api-key"] === "test-key-123",
  JSON.stringify(upstreamCalls.at(-1)?.headers));

upstreamCalls.length = 0;
r = await call(validPayload({ temperature: 9, max_tokens: 999999 }));
body = await r.json();
check("temperature 被夹到 2", body._echo?.temperature === 2, JSON.stringify(body._echo));
check("max_tokens 被夹到 32000", body._echo?.max_tokens === 32000, JSON.stringify(body._echo));

upstreamCalls.length = 0;
r = await call(validPayload({ baseUrl: `http://127.0.0.1:${upstreamPort}` }));
body = await r.json();
check("baseUrl 缺路径 -> 自动补 /v1/chat/completions", r.status === 200 && body._echo?.path === "/v1/chat/completions",
  `status=${r.status} echo=${JSON.stringify(body._echo)}`);

upstreamCalls.length = 0;
r = await call(validPayload({ baseUrl: `http://127.0.0.1:${upstreamPort}/v1` }));
body = await r.json();
check("baseUrl 以 /v1 结尾 -> 补 /chat/completions", r.status === 200 && body._echo?.path === "/v1/chat/completions",
  `status=${r.status} echo=${JSON.stringify(body._echo)}`);

r = await call(validPayload({ baseUrl: "http://evil.example.com/v1/chat/completions" }));
const evilBody = await r.json();
check("baseUrl 非 https 且非环回 -> 400", r.status === 400, `status=${r.status} body=${JSON.stringify(evilBody).slice(0, 120)}`);

r = await call(validPayload({ messages: [{ role: "user", content: "EMPTY_ONCE 空响应重试" }] }));
body = await r.json();
check("上游首次空响应 -> 重试后成功", r.status === 200 && body.choices?.[0]?.message?.content === MSG_OK,
  `status=${r.status} body=${JSON.stringify(body).slice(0, 160)}`);

r = await call(validPayload({ messages: [{ role: "user", content: "NOT_JSON 返回 HTML" }] }));
body = await r.json();
check("上游非 JSON -> 错误透出正文片段", r.status === 200 && typeof body.error?.message === "string" && body.error.message.includes("HTML"),
  `status=${r.status} body=${JSON.stringify(body).slice(0, 160)}`);

r = await call(validPayload({ messages: [{ role: "user", content: "UPSTREAM_500 试试" }] }));
body = await r.json();
check("上游 500 -> 原状态码 + 错误信息", r.status === 500 && body.error?.message === "上游炸了",
  `status=${r.status} body=${JSON.stringify(body).slice(0, 160)}`);

r = await call(validPayload({ messages: [{ role: "user", content: "SLOW 卡住" }] }));
body = await r.json();
check("上游不响应 -> 超时 502", r.status === 502 && /超时/.test(body.error?.message || ""),
  `status=${r.status} body=${JSON.stringify(body).slice(0, 160)}`);

r = await call(validPayload({ stream: true }));
const streamText = await r.text();
check("stream=true -> SSE 透传", r.status === 200 && (r.headers.get("Content-Type") || "").includes("text/event-stream") && streamText.includes("[DONE]"),
  `status=${r.status} ct=${r.headers.get("Content-Type")} body=${streamText.slice(0, 80)}`);

r = await call(validPayload(), { headers: { Origin: "https://evil.example" } });
check("跨站 Origin -> 403", r.status === 403, `status=${r.status}`);

r = await call(validPayload(), { headers: { Origin: "http://app.local" } });
check("同源 Origin -> 放行且回显 Origin", r.status === 200 && r.headers.get("Access-Control-Allow-Origin") === "http://app.local",
  `status=${r.status} acao=${r.headers.get("Access-Control-Allow-Origin")}`);

r = await call(validPayload(), { headers: { Origin: "https://ok.example" }, env: { ALLOWED_ORIGINS: "https://ok.example, https://other.example" } });
check("白名单命中 -> 放行", r.status === 200 && r.headers.get("Access-Control-Allow-Origin") === "https://ok.example",
  `status=${r.status} acao=${r.headers.get("Access-Control-Allow-Origin")}`);

r = await call(validPayload(), { headers: { Origin: "https://bad.example" }, env: { ALLOWED_ORIGINS: "https://ok.example" } });
check("白名单外 -> 403", r.status === 403, `status=${r.status}`);

r = await call(null, { method: "OPTIONS", headers: { Origin: "https://bad.example" }, env: { ALLOWED_ORIGINS: "https://ok.example" } });
check("预检来自白名单外 -> 403", r.status === 403, `status=${r.status}`);

r = await call(null, { method: "OPTIONS", headers: { Origin: "http://app.local" } });
check("预检同源 -> 204 且带 CORS 头", r.status === 204 && !!r.headers.get("Access-Control-Allow-Methods"),
  `status=${r.status} headers=${JSON.stringify([...r.headers])}`);

const rlEnv = { RATE_LIMIT_PER_MIN: "3" };
const rlIp = "10.9.9.9";
const codes = [];
for (let i = 0; i < 4; i++) {
  const resp = await call(validPayload(), { ip: rlIp, env: rlEnv });
  codes.push(resp.status);
}
check("限流：第 4 次 429", codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429, JSON.stringify(codes));

const otherIp = await call(validPayload(), { ip: "10.9.9.10", env: rlEnv });
check("限流按 IP 隔离", otherIp.status === 200, `status=${otherIp.status}`);

r = await call(null, { method: "PUT", headers: { Origin: "http://app.local" } });
check("非 GET/POST -> 405", r.status === 405, `status=${r.status}`);

r = await call(null, {
  method: "POST",
  headers: { Origin: "http://app.local", "Content-Type": "application/json" },
  url: "http://app.local/api/rewrite",
});
await r.text();
check("空 body POST -> 400 而非崩溃", r.status === 400, `status=${r.status}`);

upstream.close();

// ---------- 端点配置与参数夹取：纯逻辑，不需要网络 ----------
const presets = Object.keys(MODEL_ENDPOINTS);
check("预置端点全部为 https", presets.every((m) => MODEL_ENDPOINTS[m].url.startsWith("https://")),
  presets.filter((m) => !MODEL_ENDPOINTS[m].url.startsWith("https://")).join(","));
check("鉴权类型仅 bearer / apikey", presets.every((m) => ["bearer", "apikey"].includes(MODEL_ENDPOINTS[m].auth)),
  presets.map((m) => `${m}=${MODEL_ENDPOINTS[m].auth}`).join(","));
check("GLM 端点与官方文档一致",
  MODEL_ENDPOINTS["glm-4.7"].url === "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  MODEL_ENDPOINTS["glm-4.7"].url);
check("Qwen 走 compatible-mode 路径",
  MODEL_ENDPOINTS["qwen-plus"].url === "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  MODEL_ENDPOINTS["qwen-plus"].url);
check("MiMo 使用 api-key 头 + mimo-v2.5-pro",
  MODEL_ENDPOINTS["xiaomimimo"].auth === "apikey" && MODEL_ENDPOINTS["xiaomimimo"].name === "mimo-v2.5-pro",
  `${MODEL_ENDPOINTS["xiaomimimo"].auth} / ${MODEL_ENDPOINTS["xiaomimimo"].name}`);

check("未知模型回落到 deepseek-v4-pro",
  resolveTarget("not-exist-model").target.name === "deepseek-v4-pro", "回落失败");
check("自带 baseUrl 标记为 custom",
  resolveTarget("m", "https://x.example.com/v1/chat/completions").target.custom === true, "未标记 custom");
check("自定义地址非法时返回错误而非静默回落",
  !!resolveTarget("m", "http://evil.example.com/v1").error, "未拦截");

const glmLimits = applyModelLimits(MODEL_ENDPOINTS["glm-4.7"], 1.8, 20000);
check("GLM 温度夹到 1.0、max_tokens 夹到 8192",
  glmLimits.temperature === 1.0 && glmLimits.maxTokens === 8192, JSON.stringify(glmLimits));
const mimoLimits = applyModelLimits(MODEL_ENDPOINTS["xiaomimimo"], 1.8, 5000);
check("MiMo 温度夹到官方上限 1.5",
  mimoLimits.temperature === 1.5 && mimoLimits.maxTokens === 5000, JSON.stringify(mimoLimits));
const customLimits = applyModelLimits({ custom: true }, 1.8, 20000);
check("自定义模型不套用预置约束",
  customLimits.temperature === 1.8 && customLimits.maxTokens === 20000, JSON.stringify(customLimits));

const probeMessages = [{ role: "user", content: "x" }];
const glmBody = buildRequestBody(MODEL_ENDPOINTS["glm-4.7"], probeMessages, 1, 100, false);
check("GLM 请求显式关闭思考模式", glmBody.thinking?.type === "disabled", JSON.stringify(glmBody).slice(0, 140));
const mimoBody = buildRequestBody(MODEL_ENDPOINTS["xiaomimimo"], probeMessages, 1, 100, false);
check("MiMo 请求显式关闭思考模式", mimoBody.thinking?.type === "disabled", JSON.stringify(mimoBody).slice(0, 140));
const dsBody = buildRequestBody(MODEL_ENDPOINTS["deepseek-v4-pro"], probeMessages, 1, 100, false);
check("DeepSeek 请求不带 thinking 字段", !("thinking" in dsBody), JSON.stringify(dsBody).slice(0, 140));
check("版本号已升到 2.1.x", VERSION.startsWith("2.1."), VERSION);

const failed = results.filter((x) => !x.ok);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log("  - " + f.name + " :: " + f.detail);
  process.exit(1);
}
console.log("代理层回归自测全部通过 ✅");
