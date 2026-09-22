// 共享代理核心：Pages Functions / Workers / 本地 Node 三处唯一实现。
// 运行环境需提供 Web 标准 API：fetch、Request、Response、URL、AbortController。
// 放在 functions/_lib/ 下作为源码模块；Pages 的路由面由仓库根的 _routes.json 限定在 /api/*。

export const VERSION = "2.1.0";

// 端点与鉴权均已对照各厂商官方文档核对（2026-09）。
// maxTokens / maxTemperature：上游硬约束，超出会报错，因此在此夹取。
// extraBody：模型专属参数。GLM-4.7 与 MiMo 默认会开启思考模式，推理 token 会挤占 max_tokens
// 导致正文返回为空或过短，且本工具做的是风格改写而非推理，故显式关闭。
export const MODEL_ENDPOINTS = {
  "deepseek-v4-pro": {
    url: "https://api.deepseek.com/v1/chat/completions",
    name: "deepseek-v4-pro", auth: "bearer",
  },
  "deepseek-v4-flash": {
    url: "https://api.deepseek.com/v1/chat/completions",
    name: "deepseek-v4-flash", auth: "bearer",
  },
  "glm-4.7": {
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    name: "glm-4.7", auth: "bearer",
    maxTokens: 8192, maxTemperature: 1.0,
    extraBody: { thinking: { type: "disabled" } },
  },
  "qwen-turbo": {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    name: "qwen-turbo", auth: "bearer", maxTokens: 4096,
  },
  "qwen-plus": {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    name: "qwen-plus", auth: "bearer", maxTokens: 4096,
  },
  "xiaomimimo": {
    url: "https://api.xiaomimimo.com/v1/chat/completions",
    name: "mimo-v2.5-pro", auth: "apikey",
    maxTemperature: 1.5,
    extraBody: { thinking: { type: "disabled" } },
  },
};

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

function normalizeBaseUrl(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return { error: "自定义模型地址不是合法 URL" }; }
  const httpsOk = u.protocol === "https:";
  const loopbackOk = u.protocol === "http:" && isLoopbackHost(u.hostname);
  if (!httpsOk && !loopbackOk) return { error: "自定义模型地址必须是 https（本机环回允许 http）" };
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
  return { url: u.toString() };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 决定请求发往哪个端点。custom=true 表示用户自带 baseUrl，此时不套用预置模型的硬约束。
export function resolveTarget(model, baseUrl, authType) {
  if (baseUrl) {
    const norm = normalizeBaseUrl(String(baseUrl));
    if (norm.error) return { error: norm.error };
    return {
      target: {
        url: norm.url,
        name: String(model || "custom"),
        auth: authType === "apikey" ? "apikey" : "bearer",
        custom: true,
      },
    };
  }
  const target = MODEL_ENDPOINTS[model] || MODEL_ENDPOINTS["deepseek-v4-pro"];
  return { target };
}

export function applyModelLimits(target, temperature, maxTokens) {
  let temp = clampNumber(temperature, 0, 2, 0.9);
  if (!target.custom && target.maxTemperature) temp = Math.min(temp, target.maxTemperature);
  let tokens = Math.round(clampNumber(maxTokens, 64, 32000, 4096));
  if (!target.custom && target.maxTokens) tokens = Math.min(tokens, target.maxTokens);
  return { temperature: temp, maxTokens: tokens };
}

export function buildRequestBody(target, messages, temperature, maxTokens, stream) {
  return {
    model: target.name,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: !!stream,
    ...(target.extraBody || {}),
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
    models: Object.keys(MODEL_ENDPOINTS),
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
    apiKey, model = "deepseek-v4-pro", baseUrl, authType,
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

  const resolved = resolveTarget(model, baseUrl, authType);
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
