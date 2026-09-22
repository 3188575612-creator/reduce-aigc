// 共享代理核心：Pages Functions / Workers / 本地 Node 三处唯一实现。
// 运行环境需提供 Web 标准 API：fetch、Request、Response、URL、AbortController。
// 放在 functions/_lib/ 下作为源码模块；Pages 的路由面由仓库根的 _routes.json 限定在 /api/*。

export const VERSION = "3.0.0";

// 本服务不内置任何模型：端点、模型 ID、密钥全部由用户在自己的浏览器里配置后随请求带来。
// 下面这份是按上游域名匹配的「参数适配」，不是模型清单 —— 用户填官方地址时会自动套用已知约束，
// 填别的地址则不套用。约束依据来自各厂商官方文档（2026-09 核对）：
// maxTokens / maxTemperature 是上游硬约束，超出会报错，故在此夹取。
// extraBody：GLM 与 MiMo 默认会开启思考模式，推理 token 会挤占 max_tokens 导致正文返回为空或过短，
// 而本工具做的是风格改写而非推理，故显式关闭。
export const UPSTREAM_PROFILES = [
  {
    label: "智谱 GLM",
    match: /(^|\.)bigmodel\.cn$/i,
    maxTokens: 8192, maxTemperature: 1.0,
    extraBody: { thinking: { type: "disabled" } },
  },
  {
    label: "小米 MiMo",
    match: /(^|\.)xiaomimimo\.com$/i,
    maxTemperature: 1.5,
    extraBody: { thinking: { type: "disabled" } },
  },
  {
    label: "阿里 DashScope",
    match: /(^|\.)dashscope\.aliyuncs\.com$/i,
    maxTokens: 4096,
  },
];

const DEFAULT_TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 120000;
const DEFAULT_RATE_LIMIT = 30;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

// 内网/保留地址：现在所有请求都打到用户自定义的地址，必须挡住 SSRF 面。
// 需要连本机或内网自建模型（Ollama 等）时，用 ALLOW_PRIVATE_UPSTREAM=1 显式开启。
export function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "0.0.0.0" || h === "::" ) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// 未配置 ALLOWED_ORIGINS 时：只放行同源与本地环回，跨站一律拒绝。
// 配置后：只放行白名单，逗号分隔，支持 * 通配全部（不推荐）。
export function resolveOrigin(request, env = {}) {
  const origin = request.headers.get("Origin");
  if (!origin) return { allowed: true, header: null };
  let originHost = null;
  try { originHost = new URL(origin).host; } catch { return { allowed: false, header: null }; }

  const raw = (env.ALLOWED_ORIGINS || "").trim();
  if (raw) {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.includes("*")) return { allowed: true, header: origin };
    if (list.includes(origin)) return { allowed: true, header: origin };
    return { allowed: false, header: null };
  }

  const selfHost = request.headers.get("Host") || new URL(request.url).host;
  if (originHost && selfHost && originHost === selfHost) return { allowed: true, header: origin };
  if (isLoopbackHost(originHost) && isLoopbackHost(selfHost)) return { allowed: true, header: origin };
  return { allowed: false, header: null };
}

function corsHeaders(originHeader) {
  const h = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (originHeader) h["Access-Control-Allow-Origin"] = originHeader;
  return h;
}

const buckets = new Map();

function checkRateLimit(ip, limit) {
  const now = Date.now();
  const windowMs = 60000;
  let arr = buckets.get(ip);
  if (!arr) { arr = []; buckets.set(ip, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) return { ok: false, retryAfter: Math.ceil((windowMs - (now - arr[0])) / 1000) };
  arr.push(now);
  if (buckets.size > 20000) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
      if (buckets.size <= 10000) break;
    }
  }
  return { ok: true };
}

function normalizeBaseUrl(baseUrl, allowPrivate) {
  let u;
  try { u = new URL(baseUrl); } catch { return { error: "自定义模型地址不是合法 URL" }; }

  const priv = isPrivateHost(u.hostname);
  if (priv && !allowPrivate) {
    return { error: "自定义模型地址不能是内网/本机地址；如确需（如本机自建模型），请让服务端设置 ALLOW_PRIVATE_UPSTREAM=1" };
  }
  if (!priv && u.protocol !== "https:") {
    return { error: "自定义模型地址必须是 https" };
  }
  if (priv && u.protocol !== "https:" && u.protocol !== "http:") {
    return { error: "自定义模型地址协议不支持" };
  }

  let path = u.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(path)) {
    // 已是完整端点，原样使用
  } else if (/\/v\d+$/.test(path)) {
    path += "/chat/completions";
  } else {
    path += "/v1/chat/completions";
  }
  u.pathname = path;
  u.search = "";
  u.hash = "";
  return { url: u.toString(), hostname: u.hostname.toLowerCase() };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 决定请求发往哪个端点。不再有内置模型：baseUrl 必填（用户自定义模型）。
export function resolveTarget(model, baseUrl, authType, allowPrivate = false) {
  if (!baseUrl || !String(baseUrl).trim()) {
    return { error: "缺少 baseUrl：本服务不内置模型，请先在设置里添加自定义模型（需填完整 API 地址）" };
  }
  const norm = normalizeBaseUrl(String(baseUrl), allowPrivate);
  if (norm.error) return { error: norm.error };
  const profile = UPSTREAM_PROFILES.find((p) => p.match.test(norm.hostname)) || null;
  return {
    target: {
      url: norm.url,
      name: String(model || "custom"),
      auth: authType === "apikey" ? "apikey" : "bearer",
      hostname: norm.hostname,
      profile,
    },
  };
}

export function applyModelLimits(target, temperature, maxTokens) {
  let temp = clampNumber(temperature, 0, 2, 0.9);
  let tokens = Math.round(clampNumber(maxTokens, 64, 32000, 4096));
  const profile = target.profile;
  if (profile) {
    if (profile.maxTemperature) temp = Math.min(temp, profile.maxTemperature);
    if (profile.maxTokens) tokens = Math.min(tokens, profile.maxTokens);
  }
  return { temperature: temp, maxTokens: tokens };
}

export function buildRequestBody(target, messages, temperature, maxTokens, stream) {
  return {
    model: target.name,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: !!stream,
    ...((target.profile && target.profile.extraBody) || {}),
  };
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "messages 必须是非空数组";
  if (messages.length > MAX_MESSAGES) return `messages 超过上限 ${MAX_MESSAGES} 条`;
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") return "messages 元素格式错误";
    if (typeof m.content !== "string") return "messages 元素的 content 必须是字符串";
    if (m.role && !["system", "user", "assistant"].includes(m.role)) return "messages 的 role 非法";
    total += m.content.length;
  }
  if (total > MAX_TOTAL_CHARS) return `文本过长：合计 ${total} 字，上限 ${MAX_TOTAL_CHARS} 字`;
  return null;
}

export function handleHealth(cors = {}) {
  return json({
    ok: true,
    service: "reduce-aigc-proxy",
    version: VERSION,
    models: "user-supplied",
    time: new Date().toISOString(),
  }, 200, cors);
}

export async function handleRewrite(request, env = {}) {
  const { allowed, header: originHeader } = resolveOrigin(request, env);
  const cors = corsHeaders(originHeader);

  if (request.method === "OPTIONS") {
    if (!allowed) return new Response(null, { status: 403, headers: cors });
    return new Response(null, { status: 204, headers: cors });
  }

  if (!allowed) {
    return json({ error: "来源不在允许列表内" }, 403, cors);
  }

  if (request.method === "GET") return handleHealth(cors);

  if (request.method !== "POST") {
    return json({ error: "仅支持 POST" }, 405, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Real-IP")
    || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim()
    || "local";
  const limit = clampNumber(env.RATE_LIMIT_PER_MIN, 1, 100000, DEFAULT_RATE_LIMIT);
  const rl = checkRateLimit(ip, limit);
  if (!rl.ok) {
    return json({ error: `请求过于频繁，请 ${rl.retryAfter} 秒后重试` }, 429,
      { ...cors, "Retry-After": String(rl.retryAfter) });
  }

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared && declared > MAX_BODY_BYTES) {
    return json({ error: "请求体过大" }, 413, cors);
  }

  let raw;
  try { raw = await request.text(); } catch {
    return json({ error: "读取请求体失败" }, 400, cors);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: "请求体过大" }, 413, cors);
  }

  let body;
  try { body = JSON.parse(raw); } catch {
    return json({ error: "Invalid JSON" }, 400, cors);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "请求体必须是 JSON 对象" }, 400, cors);
  }

  const {
    apiKey, model, baseUrl, authType,
    messages, temperature, max_tokens, stream,
  } = body;

  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return json({ error: "缺少 apiKey" }, 400, cors);
  }
  if (apiKey.length > 512) {
    return json({ error: "apiKey 长度异常" }, 400, cors);
  }

  const msgError = validateMessages(messages);
  if (msgError) return json({ error: msgError }, 400, cors);

  for (const m of messages) if (!m.role) m.role = "user";

  const allowPrivate = env.ALLOW_PRIVATE_UPSTREAM === "1" || env.ALLOW_PRIVATE_UPSTREAM === "true";
  const resolved = resolveTarget(model, baseUrl, authType, allowPrivate);
  if (resolved.error) return json({ error: resolved.error }, 400, cors);
  const target = resolved.target;

  const limits = applyModelLimits(target, temperature, max_tokens);
  const reqBody = buildRequestBody(target, messages, limits.temperature, limits.maxTokens, stream);

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (target.auth === "apikey") headers["api-key"] = apiKey;
  else headers["Authorization"] = `Bearer ${apiKey}`;

  const timeoutMs = clampNumber(env.UPSTREAM_TIMEOUT_MS, 200, 120000, DEFAULT_TIMEOUT_MS);

  try {
    let resp = null;
    let text = "";
    let contentType = "";
    const attempts = stream ? 1 : 2;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        resp = await fetch(target.url, {
          method: "POST",
          headers,
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (stream && resp.ok && resp.body) {
        return new Response(resp.body, {
          status: 200,
          headers: {
            "Content-Type": resp.headers.get("Content-Type") || "text/event-stream",
            "Cache-Control": "no-cache",
            ...cors,
          },
        });
      }

      contentType = resp.headers.get("Content-Type") || "";
      text = await resp.text();
      if (text) break;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 1000));
    }

    if (!text) {
      return json({ error: { message: `上游空响应 HTTP ${resp.status}` } }, 502, cors);
    }

    if (!contentType.includes("application/json")) {
      return json({ error: { message: text.slice(0, 500) || `HTTP ${resp.status}` } }, resp.status || 502, cors);
    }

    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  } catch (err) {
    const msg = err && err.name === "AbortError" ? `请求超时(${timeoutMs / 1000}s)` : (err && err.message) || "未知错误";
    return json({ error: { message: "API 请求失败: " + msg } }, 502, cors);
  }
}

export default { fetch: (request, env) => handleRewrite(request, env) };
