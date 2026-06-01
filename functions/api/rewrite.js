function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const ENDPOINTS = {
  "deepseek-v4-pro":  { url:"https://api.deepseek.com/v1/chat/completions", name:"deepseek-v4-pro", auth:"bearer" },
  "deepseek-v4-flash": { url:"https://api.deepseek.com/v1/chat/completions", name:"deepseek-v4-flash", auth:"bearer" },
  "glm-4-flash":       { url:"https://open.bigmodel.cn/api/paas/v4/chat/completions", name:"glm-4-flash", auth:"bearer" },
  "qwen-turbo":        { url:"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", name:"qwen-turbo", auth:"bearer" },
  "qwen-plus":         { url:"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", name:"qwen-plus", auth:"bearer" },
  "xiaomimimo":        { url:"https://api.xiaomimimo.com/v1/chat/completions", name:"mimo-v2.5-pro", auth:"apikey" },
};

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "仅支持 POST" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  const { apiKey, model = "deepseek-v4-pro", messages, temperature = 0.9, max_tokens = 4096 } = body;

  if (!apiKey || !messages) {
    return new Response(JSON.stringify({ error: "缺少 apiKey 或 messages" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  const ep = ENDPOINTS[model] || ENDPOINTS["deepseek-v4-pro"];

  try {
    const headers = { "Content-Type": "application/json" };
    if (ep.auth === "apikey") {
      headers["api-key"] = apiKey;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const resp = await fetch(ep.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: ep.name,
        messages,
        temperature,
        max_tokens,
      }),
    });

    const ct = resp.headers.get("content-type") || "";
    const raw = await resp.text();

    // If upstream returned non-JSON, wrap it
    if (!ct.includes("application/json")) {
      return new Response(JSON.stringify({
        error: { message: raw.substring(0, 500) || `HTTP ${resp.status}` }
      }), {
        status: resp.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    return new Response(raw, {
      status: resp.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "API 请求失败: " + err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}
