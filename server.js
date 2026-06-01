const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3456;
const DEEPSEEK_HOST = "api.deepseek.com";
const DEEPSEEK_PATH = "/v1/chat/completions";

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

function proxyToDeepSeek(req, res) {
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
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    serveFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
  } else if (req.method === "POST" && url.pathname === "/api/rewrite") {
    proxyToDeepSeek(req, res);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`✅ AIGC降重工具已启动: http://localhost:${PORT}`);
});
