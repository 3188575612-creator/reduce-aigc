const https = require("https");

const DEEPSEEK_HOST = "api.deepseek.com";
const DEEPSEEK_PATH = "/v1/chat/completions";

module.exports = function handler(req, res) {
  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "仅支持 POST" }));
  }

  // 读取请求体
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid JSON" }));
    }

    const { apiKey, messages, temperature = 0.9, max_tokens = 4096 } = parsed;

    if (!apiKey || !messages) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "缺少 apiKey 或 messages" }));
    }

    const postData = JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature,
      max_tokens,
    });

    const options = {
      hostname: DEEPSEEK_HOST,
      path: DEEPSEEK_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let data = "";
      proxyRes.on("data", (chunk) => (data += chunk));
      proxyRes.on("end", () => {
        res.writeHead(proxyRes.statusCode, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(data);
      });
    });

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "API 请求失败: " + err.message }));
    });

    proxyReq.write(postData);
    proxyReq.end();
  });
};
