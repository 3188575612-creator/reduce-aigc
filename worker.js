export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rewrite") return handleRewrite(request);
    return env.ASSETS.fetch(request);
  },
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function handleRewrite(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (request.method !== "POST") {
    return json({ error: "仅支持 POST" }, 405);
  }
  let body;
  try { body = await request.json(); } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { apiKey, model = "deepseek-v4-pro", messages, temperature = 0.9, max_tokens = 4096 } = body;
  if (!apiKey || !messages) {
    return json({ error: "缺少 apiKey 或 messages" }, 400);
  }
  try {
    const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens }),
    });
    const data = await resp.text();
    return new Response(data, { status: resp.status, headers: { "Content-Type": "application/json", ...cors() } });
  } catch (err) {
    return json({ error: "API 请求失败: " + err.message }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}
